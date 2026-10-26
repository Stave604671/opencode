import idleSprite from "./assets/whale/whale-idle.gif"
import happySprite from "./assets/whale/whale-happy.gif"
import sleepSprite from "./assets/whale/whale-sleeping.gif"
import sleepSprite2 from "./assets/whale/whale-sleeping-2.gif"
import thinkSprite from "./assets/whale/whale-thinking.gif"
import waitSprite from "./assets/whale/whale-waiting.gif"
import workSprite from "./assets/whale/whale-working.gif"
import workSprite2 from "./assets/whale/whale-working-2.gif"
import workSprite3 from "./assets/whale/whale-working-3.gif"
import workSprite4 from "./assets/whale/whale-working-4.gif"
import talkSprite from "./assets/whale/whale-talking.gif"
import sweepSprite from "./assets/whale/whale-sweeping.gif"
import askSprite from "./assets/whale/whale-needsinput.gif"
import attentionSprite from "./assets/whale/whale-attention.gif"
import errorSprite from "./assets/whale/whale-error.gif"
import sadSprite from "./assets/whale/whale-sad.gif"
import greetSprite from "./assets/whale/whale-greet.gif"
import loafSprite from "./assets/whale/whale-loafing.gif"
import loafSprite2 from "./assets/whale/whale-loafing-2.gif"
import loafSprite3 from "./assets/whale/whale-loafing-3.gif"
import roamSprite from "./assets/whale/whale-roam.gif"

import type { PetSnapshot, PetSpeech, PetState } from "../../preload/types"

/**
 * One sprite per runtime state. The whale maid is the default skin, so a state
 * the main process invents without an entry here falls back to `idle` rather
 * than leaving the previous frame up.
 */
const SPRITES: Record<PetState, string> = {
  idle: idleSprite,
  loafing: loafSprite,
  sleeping: sleepSprite,
  thinking: thinkSprite,
  working: workSprite,
  talking: talkSprite,
  sweeping: sweepSprite,
  waiting: waitSprite,
  needsinput: askSprite,
  attention: attentionSprite,
  error: errorSprite,
  sad: sadSprite,
  happy: happySprite,
  greet: greetSprite,
}

/**
 * Pools for the states the pet sits in longest. A single four-second loop shown
 * for ten minutes reads as a frozen app, so `working` and the idle family cycle
 * through the extra poses the sheet ships.
 */
const POOLS: Partial<Record<PetState, string[]>> = {
  working: [workSprite, workSprite2, workSprite3, workSprite4],
  sleeping: [sleepSprite, sleepSprite2],
  loafing: [loafSprite, loafSprite2, loafSprite3, roamSprite],
}

/** How long one pose in a pool stays up before the next one takes over. */
const POOL_ROTATE_MS = 60 * 1000

const STATES = Object.keys(SPRITES) as PetState[]
/** Only these states interrupt the user, so only these get a bubble. */
const BUBBLE_STATES = new Set<PetState>(["waiting", "needsinput", "attention", "error", "sad"])
/** Heavier styling: something is blocked or broken rather than merely notable. */
const ALERT_STATES = new Set<PetState>(["waiting", "needsinput"])

const sprite = document.getElementById("sprite") as HTMLImageElement
const bubble = document.getElementById("bubble") as HTMLDivElement
const bubbleText = document.getElementById("bubble-text") as HTMLSpanElement
const bubbleSub = document.getElementById("bubble-sub") as HTMLSpanElement
const sleepMark = document.getElementById("sleep-mark") as HTMLDivElement
const stage = document.getElementById("stage") as HTMLDivElement

let current: PetState | null = null
let bubbleBody: string | null = null
let poolIndex = 0
let poolTimer: ReturnType<typeof setInterval> | null = null

// ---------- speaking ----------

/** How long the whale keeps its mouth moving for one line. */
const SPEAK_MS = 5000
/** How long a finished line stays up before it fades on its own. */
const HOLD_MS = 6000
/** Hovering the bubble pins it; this is how long it lingers after the pointer leaves. */
const LEAVE_GRACE_MS = 1500

let speech: PetSpeech | null = null
let speechUntil = 0
let typing: number | null = null
let dismiss: number | null = null
let hovering = false
let lastSnapshot: PetSnapshot | null = null

/**
 * Picks the artwork for the state currently on screen. Only ever touches one
 * `img`, so the other poses in a pool stay un-decoded until they are shown —
 * each of these GIFs is ~100 frames of 360×360, about 50 MB once decoded, and
 * preloading the whole sheet would cost over a gigabyte.
 */
function paint(state: PetState) {
  const pool = POOLS[state]
  const src = pool && pool.length > 0 ? pool[poolIndex % pool.length] : SPRITES[state]
  sprite.src = src
  // Lets a smoke test assert on the artwork instead of the URL Vite rewrites it to.
  sprite.dataset.sprite = src.split("/").pop() ?? ""
}

function rotate() {
  if (poolTimer) {
    clearInterval(poolTimer)
    poolTimer = null
  }
  const pool = current ? POOLS[current] : undefined
  if (!current || !pool || pool.length < 2) return
  poolTimer = setInterval(() => {
    if (!current) return
    poolIndex += 1
    paint(current)
  }, POOL_ROTATE_MS)
}

function clearSpeechTimers() {
  if (typing !== null) {
    clearTimeout(typing)
    typing = null
  }
  if (dismiss !== null) {
    clearTimeout(dismiss)
    dismiss = null
  }
}

function repaint() {
  if (lastSnapshot) render(lastSnapshot)
}

/** Drops the spoken line without animating; a live alert is about to take the bubble. */
function stopSpeech() {
  if (!speech) return
  clearSpeechTimers()
  speech = null
  speechUntil = 0
  bubble.classList.remove("speech", "done", "info", "enter", "out")
}

function endSpeech(target: PetSpeech) {
  if (speech !== target) return
  if (hovering) {
    // The pointer is on the bubble, which usually means the user is reading or
    // about to click it. Wait for them instead of yanking it away.
    dismiss = null
    return
  }
  clearSpeechTimers()
  speech = null
  speechUntil = 0
  bubble.classList.add("out")
  window.setTimeout(() => {
    if (speech) return
    bubble.classList.add("hidden")
    bubble.classList.remove("out")
  }, 260)
  repaint()
}

/**
 * Says one line the way a person would: the text types itself out, the whale
 * moves its mouth meanwhile, and the bubble lingers long enough to read. The
 * whole line is bounded, so a notification can never park on screen forever.
 */
function speak(next: PetSpeech) {
  clearSpeechTimers()
  speech = next
  speechUntil = Date.now() + SPEAK_MS
  bubbleBody = null

  const detail = typeof next.detail === "string" && next.detail.trim() ? next.detail.trim() : null
  bubbleSub.textContent = detail ?? ""
  bubbleSub.classList.toggle("hidden", !detail)
  bubbleText.textContent = ""
  // Replacing the class list is what restarts the enter animation.
  bubble.className = `bubble speech enter${next.tone === "error" ? " error" : next.tone === "done" ? " done" : ""}`

  repaint()

  const chars = Array.from(next.title)
  // A long line types faster per character so the whole thing never crawls.
  const pace = chars.length > 26 ? 14 : 26
  let index = 0
  const step = () => {
    if (speech !== next) return
    if (index >= chars.length) {
      typing = null
      dismiss = window.setTimeout(() => endSpeech(next), HOLD_MS)
      return
    }
    // Text content only: titles and session names come from the server and must
    // never be parsed as HTML inside this window.
    bubbleText.textContent += chars[index]
    index += 1
    typing = window.setTimeout(step, pace)
  }
  step()

  // The mouth stops when the line is done; the bubble stays up to be read.
  window.setTimeout(() => {
    if (speech !== next) return
    speechUntil = 0
    repaint()
  }, SPEAK_MS)
}

function render(state: PetSnapshot) {
  lastSnapshot = state
  const next: PetState = state.state in SPRITES ? state.state : "idle"
  const detail = typeof state.detail === "string" && state.detail.trim() ? state.detail.trim() : null
  // A live alert outranks a spoken line: it is the thing the user has to act on.
  const alertMessage = BUBBLE_STATES.has(next) ? detail : null
  if (alertMessage) stopSpeech()

  // Speaking drives the mouth, but never over a state that is waiting on the user.
  const speaking = !alertMessage && Date.now() < speechUntil
  const shown: PetState = speaking ? "talking" : next

  if (shown !== current) {
    current = shown
    poolIndex = 0
    document.body.classList.remove(...STATES.map((value) => `state-${value}`))
    document.body.classList.add(`state-${shown}`)
    document.body.dataset.state = shown
    paint(shown)
    sleepMark.classList.toggle("hidden", shown !== "sleeping")
    rotate()
  }

  if (speech) return

  const message = alertMessage
  if (message === bubbleBody) return

  bubbleBody = message
  if (!message) {
    bubble.classList.add("hidden")
    return
  }
  bubbleText.textContent = message
  bubbleSub.classList.add("hidden")
  bubble.classList.toggle("alert", ALERT_STATES.has(next))
  bubble.classList.toggle("error", next === "error")
  bubble.classList.remove("hidden")
}

// ---------- bubble interaction ----------

// Without this the bubble would double as a drag handle and a click on it would
// move the window by a pixel instead of opening the session.
bubble.addEventListener("pointerdown", (event) => {
  event.stopPropagation()
})

bubble.addEventListener("pointerenter", () => {
  hovering = true
  if (dismiss !== null) {
    clearTimeout(dismiss)
    dismiss = null
  }
})

bubble.addEventListener("pointerleave", () => {
  hovering = false
  if (speech && typing === null) dismiss = window.setTimeout(() => endSpeech(speech!), LEAVE_GRACE_MS)
})

bubble.addEventListener("click", () => {
  const line = speech
  if (!line) {
    void window.api.pet.focusMain().catch(() => undefined)
    return
  }
  void window.api.pet.sayClick(line.id).catch(() => undefined)
  // The user is on their way to the session, so the line has done its job.
  hovering = false
  endSpeech(line)
})

// ---------- drag + click ----------

let drag: { x: number; y: number; moved: number } | null = null
let moving = false
const CLICK_SLOP = 4

stage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return
  drag = { x: event.screenX, y: event.screenY, moved: 0 }
  document.body.classList.add("dragging")
  // Capture the pointer so a fast drag still delivers its release even when the
  // window falls behind the cursor. Without it the gesture leaks past pointerup:
  // the next hover would report a huge stale offset and jump the pet.
  try {
    stage.setPointerCapture(event.pointerId)
  } catch {}
  void window.api.pet.dragStart().catch(() => undefined)
})

window.addEventListener("pointermove", (event) => {
  if (!drag || moving) return
  const dx = event.screenX - drag.x
  const dy = event.screenY - drag.y
  if (!dx && !dy) return
  drag.moved += Math.abs(dx) + Math.abs(dy)
  moving = true
  // Main owns the window position, so send the offset from the grab point and
  // let it clamp to the screen. Keeping the origin fixed makes the gesture
  // self-correcting: dropped events just catch up on the next one.
  void window.api.pet
    .dragTo(dx, dy)
    .catch(() => undefined)
    .finally(() => {
      moving = false
    })
})

function endDrag(click: boolean) {
  if (!drag) return
  const moved = drag.moved
  drag = null
  document.body.classList.remove("dragging")
  void window.api.pet.dragEnd().catch(() => undefined)
  if (click && moved < CLICK_SLOP) void window.api.pet.focusMain().catch(() => undefined)
}

window.addEventListener("pointerup", () => endDrag(true))
window.addEventListener("pointercancel", () => endDrag(false))

// ---------- boot ----------

void window.api.pet
  .getState()
  .then(render)
  .catch(() => undefined)

const off = window.api.pet.onState(render)
const offSay = window.api.pet.onSay(speak)
window.addEventListener("beforeunload", () => {
  off()
  offSay()
  if (poolTimer) clearInterval(poolTimer)
  clearSpeechTimers()
})
