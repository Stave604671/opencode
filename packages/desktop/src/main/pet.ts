import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserWindow, screen } from "electron"
import type { PetActivity, PetSnapshot, PetSpeech, PetState } from "../preload/types"
import { getLastFocusedWindow, keepOwnBackground } from "./windows"
import { write as writeLog } from "./logging"
import { getStore } from "./store"
import { PET_WINDOW_ENABLED_KEY, PET_WINDOW_POSITION_KEY } from "./store-keys"

const root = dirname(fileURLToPath(import.meta.url))
const rendererProtocol = "oc"
const rendererHost = "renderer"

const PET_WIDTH = 220
const PET_HEIGHT = 260
const TICK_MS = 1000
/** Lull before the pet stops sitting still and starts loafing around instead. */
const LOAF_AFTER_MS = 90 * 1000
const SLEEP_AFTER_MS = 5 * 60 * 1000

/**
 * Reactions with a lifetime. The trigger behind each one (a finished turn, a
 * greeting, an abort, a failure) never repeats on its own, so the state has to
 * expire locally rather than wait for a fresh report that will never come.
 */
const TRANSIENT_MS: Partial<Record<PetState, number>> = {
  happy: 4 * 1000,
  greet: 3 * 1000,
  sad: 8 * 1000,
  error: 90 * 1000,
}

/**
 * The pet renders one sprite family per state. Keep this in sync with `SPRITES`
 * and `POOLS` in `src/renderer/pet/pet.ts`: any word that reaches the renderer
 * must resolve to artwork there or the pet falls back to `idle`.
 */
const PET_STATES = new Set<PetState>([
  "idle",
  "thinking",
  "working",
  "talking",
  "sweeping",
  "waiting",
  "needsinput",
  "attention",
  "error",
  "sad",
  "happy",
  "greet",
  "loafing",
  "sleeping",
])

export type { PetSnapshot, PetState }

/**
 * The chat renderer is the only component that knows what the model is doing:
 * it already subscribes to the server's (directory-scoped) event stream and
 * folds it into session status, tool parts and pending prompts. Driving the pet
 * from that store keeps one source of truth instead of a second, fragile one.
 */
let reported: (PetActivity & { at: number }) | null = null
/** Session the chat window says it is showing; used when no report arrived yet. */
let pinned: string | null = null
let petWindow: BrowserWindow | null = null
let ticker: NodeJS.Timeout | null = null
let lastPublished: string | null = null
let started = false
let stopped = false

function log(message: string, meta?: Record<string, unknown>) {
  writeLog("pet", message, meta)
}

function isEnabled() {
  return getStore().get(PET_WINDOW_ENABLED_KEY) !== false
}

export function startPet() {
  if (started) return
  started = true
  if (!isEnabled()) {
    log("pet window disabled")
    return
  }
  createPetWindow()
  if (stopped) return
  if (!ticker) {
    ticker = setInterval(publish, TICK_MS)
    ticker.unref()
  }
}

/**
 * Accepts one activity report from the chat renderer. Everything is validated
 * here because the value crosses a process boundary.
 */
export function reportPetActivity(input: PetActivity | null | undefined) {
  if (!input || typeof input !== "object") return
  const state = PET_STATES.has(input.state) ? input.state : "idle"
  const detail = typeof input.detail === "string" ? input.detail.trim().slice(0, 120) : ""
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : ""
  const next = {
    sessionID: typeof input.sessionID === "string" && input.sessionID.trim() ? input.sessionID.trim() : null,
    state: state as PetState,
    detail: detail || null,
    title: title || null,
    at: Date.now(),
  }
  const previous = reported
  reported = next
  if (!previous) log("activity reporting started", { state: next.state, sessionID: next.sessionID })
  publish()
}

/**
 * The renderer tells us which session is on screen as soon as the route moves,
 * which can land before (or after) the matching activity report. Only reset when
 * the report belongs to a different session, so ordering never blanks the pet.
 */
export function setBoundSession(sessionID: string | null) {
  const next = sessionID && sessionID.trim() ? sessionID.trim() : null
  if (next === pinned) return
  pinned = next
  if (reported?.sessionID === next) return
  reported = null
  lastPublished = null
  publish()
}

export function getPetSnapshot(): PetSnapshot {
  const now = Date.now()
  const activity = reported
  if (!activity) {
    return { state: "idle", sessionID: pinned, title: null, detail: null, idleMs: null, at: now }
  }

  const age = now - activity.at
  const base = { sessionID: activity.sessionID, title: activity.title, idleMs: age, at: now }

  // Past its lifetime a reaction gives way to what a quiet pet would be doing.
  // It has to re-enter the same idle ladder rather than returning a flat "idle",
  // or the pet parks on one frame from here until it falls asleep.
  const ttl = TRANSIENT_MS[activity.state]
  if (ttl !== undefined && age > ttl) {
    if (age > SLEEP_AFTER_MS) return { ...base, state: "sleeping", detail: null }
    if (age > LOAF_AFTER_MS) return { ...base, state: "loafing", detail: null }
    return { ...base, state: "idle", detail: null }
  }

  // Only genuinely quiet states may drift: idle → loafing → asleep. A long tool
  // run stops re-reporting while it works, so it must never be read as idleness.
  if (activity.state === "idle" || activity.state === "loafing") {
    if (age > SLEEP_AFTER_MS) return { ...base, state: "sleeping", detail: null }
    if (age > LOAF_AFTER_MS) return { ...base, state: "loafing", detail: null }
  }

  return { ...base, state: activity.state, detail: activity.detail }
}

function publish() {
  if (!petWindow || petWindow.isDestroyed()) return
  const snapshot = getPetSnapshot()
  // Copying once per second is fine, but only talk to the renderer on change so
  // a quiet session does not burn a frame every tick.
  const key = `${snapshot.state}|${snapshot.sessionID}|${snapshot.detail}|${snapshot.title}`
  if (key === lastPublished) return
  lastPublished = key
  petWindow.webContents.send("pet-state", snapshot)
  log("state changed", {
    state: snapshot.state,
    detail: snapshot.detail,
    sessionID: snapshot.sessionID,
  })
}

export function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) return petWindow

  const saved = readPosition()
  const area = screen.getPrimaryDisplay().workArea
  const position = clampToWorkArea(
    saved?.x ?? area.x + area.width - PET_WIDTH - 24,
    saved?.y ?? area.y + area.height - PET_HEIGHT - 24,
  )

  const win = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: PET_WIDTH,
    height: PET_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: "OpenCode Pet",
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A throttled background window stops producing frames, which leaves a
      // stale surface behind the artwork.
      backgroundThrottling: false,
    },
  })

  petWindow = win
  // The chat theme pushes its background colour onto every window; the pet has to
  // be exempt or the transparent surface gets flattened onto an opaque card.
  keepOwnBackground(win)
  win.setAlwaysOnTop(true, "screen-saver")
  if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Clicking the pet should not pull focus away from whatever the user types in.
  win.setIgnoreMouseEvents(false)

  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    log("pet preload error", { preloadPath, error: String(error) })
  })
  win.webContents.on("did-fail-load", (_event, code, description) => {
    log("pet load failed", { code, description })
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  const url = devUrl
    ? new URL("pet/index.html", devUrl).toString()
    : `${rendererProtocol}://${rendererHost}/pet/index.html`
  void win.loadURL(url)

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return
    // The constructor's size is rounded up to whole physical pixels, which at
    // 150% lands on 222×260. Re-asserting the logical size keeps the footprint
    // identical to what the drag handler maintains.
    win.setBounds({ ...position, width: PET_WIDTH, height: PET_HEIGHT })
    // Never steal focus from the chat window the pet is supposed to be watching.
    win.showInactive()
    publish()
  })

  win.on("moved", () => savePosition(win))
  win.on("closed", () => {
    if (petWindow === win) petWindow = null
  })

  return win
}

function readPosition(): { x: number; y: number } | null {
  const value = getStore().get(PET_WINDOW_POSITION_KEY) as { x?: unknown; y?: unknown } | undefined
  if (!value || typeof value.x !== "number" || typeof value.y !== "number") return null
  return { x: Math.round(value.x), y: Math.round(value.y) }
}

function savePosition(win: BrowserWindow) {
  if (win.isDestroyed()) return
  const [x, y] = win.getPosition()
  getStore().set(PET_WINDOW_POSITION_KEY, { x, y })
}

/**
 * Keeps part of the pet on screen. The margins allow parking it half off an
 * edge, which is how people tuck away a desktop pet they still want to grab.
 * The display is picked from the pet's own centre so a second monitor works.
 */
function clampToWorkArea(x: number, y: number) {
  const area = screen.getDisplayNearestPoint({
    x: Math.round(x + PET_WIDTH / 2),
    y: Math.round(y + PET_HEIGHT / 2),
  }).workArea
  return {
    x: Math.min(Math.max(x, area.x - PET_WIDTH + 40), area.x + area.width - 40),
    y: Math.min(Math.max(y, area.y - PET_HEIGHT + 40), area.y + area.height - 40),
  }
}

/**
 * Where the window sat when the current drag started. Deltas from the renderer
 * are offsets from the grab point, not per-event steps, so a lost or coalesced
 * event can never leave the pet behind the cursor.
 */
let dragOrigin: { x: number; y: number } | null = null

export function beginPetDrag() {
  if (!petWindow || petWindow.isDestroyed()) return
  const bounds = petWindow.getBounds()
  dragOrigin = { x: bounds.x, y: bounds.y }
}

/**
 * The size is repeated on every tick on purpose. `setPosition` on a display
 * running at a fractional scale (150%) adds one logical pixel to the width and
 * the height on every call under Electron 42, so dragging steadily inflated the
 * pet's footprint — the window would grow a pixel per move. Handing `setBounds`
 * an explicit size keeps it pinned to PET_WIDTH × PET_HEIGHT.
 */
export function dragPet(dx: number, dy: number) {
  if (!petWindow || petWindow.isDestroyed()) return
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  if (!dragOrigin) beginPetDrag()
  if (!dragOrigin) return
  const position = clampToWorkArea(dragOrigin.x + dx, dragOrigin.y + dy)
  petWindow.setBounds({
    x: Math.round(position.x),
    y: Math.round(position.y),
    width: PET_WIDTH,
    height: PET_HEIGHT,
  })
}

export function endPetDrag() {
  dragOrigin = null
}

export function setPetVisible(visible: boolean) {
  if (visible) {
    const win = createPetWindow()
    win.showInactive()
    return
  }
  if (petWindow && !petWindow.isDestroyed()) petWindow.hide()
}

export function isPetVisible() {
  return Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible())
}

export function togglePet() {
  const visible = isPetVisible()
  setPetVisible(!visible)
  return !visible
}

/** Brings the chat window forward without activating the pet itself. */
export function focusMainWindow() {
  const last = getLastFocusedWindow()
  const target =
    last && last !== petWindow && !last.isDestroyed()
      ? last
      : BrowserWindow.getAllWindows().find((win) => win !== petWindow && !win.isDestroyed())
  if (!target) return
  // Only restore/show when the window is not already on screen. Re-showing a
  // window that is already visible forces the compositor to rebuild its surface,
  // which is what left a growing white smear behind every pet click.
  if (target.isMinimized()) target.restore()
  if (!target.isVisible()) target.show()
  target.focus()
}

/**
 * Hands a notification to the pet instead of the OS. Returns false when the pet
 * is hidden, which is the signal for the caller to fall back to a toast: with
 * no pet on screen there is nothing to say it, and silently swallowing the
 * notification would be worse than the toast the feature replaces.
 */
export function sayInPet(speech: PetSpeech) {
  const win = petWindow
  if (!win || win.isDestroyed() || !win.isVisible()) return false

  const text: PetSpeech = {
    id: String(speech?.id ?? "").slice(0, 64) || String(Date.now()),
    title: String(speech?.title ?? "").trim().slice(0, 120) || "…",
    detail:
      typeof speech?.detail === "string" && speech.detail.trim() ? speech.detail.trim().slice(0, 120) : null,
    tone: speech?.tone === "error" ? "error" : speech?.tone === "info" ? "info" : "done",
  }

  // The window is created lazily, so the first notification of a session can
  // arrive while the page is still loading and a plain send would be dropped.
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => {
      if (!win.isDestroyed()) win.webContents.send("pet-say", text)
    })
    return true
  }

  win.webContents.send("pet-say", text)
  log("pet spoke", { tone: text.tone, title: text.title })
  return true
}

/** The user clicked the pet's bubble: bring the chat forward and run its action. */
export function clickPetSpeech(id: string) {
  focusMainWindow()
  // Only the window that is now in front runs the action. Broadcasting would
  // navigate every open window to the same session.
  const focused = BrowserWindow.getFocusedWindow()
  const targets =
    focused && focused !== petWindow && !focused.isDestroyed()
      ? [focused]
      : BrowserWindow.getAllWindows().filter((win) => win !== petWindow && !win.isDestroyed())
  for (const win of targets) win.webContents.send("pet-say-click", id)
}

export function getPetWindow() {
  return petWindow
}

export function stopPet() {
  stopped = true
  if (ticker) {
    clearInterval(ticker)
    ticker = null
  }
  if (petWindow && !petWindow.isDestroyed()) petWindow.destroy()
  petWindow = null
}
