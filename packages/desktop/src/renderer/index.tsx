// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  AppBaseProviders,
  AppInterface,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  createDraftStore,
  ServerConnection,
  useCommand,
  useGlobal,
  useServer,
  useWslServers,
  useLanguage,
} from "@opencode-ai/app"
import type { UpdaterState } from "@opencode-ai/app/updater"
import * as Sentry from "@sentry/solid"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createMemoryHistory, MemoryRouter, type BaseRouterProps } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import type { PetState } from "../preload/types"
import { t } from "./i18n"
import { initializationData } from "./initialization"
import { DesktopFirstLaunchOnboarding } from "./onboarding"
import { resetZoom, setPinchZoomEnabled, webviewZoom, zoomIn, zoomOut } from "./webview-zoom"
import { windowFullscreen } from "./window-fullscreen"
import { availableStartupServer, readyWslConnections } from "./wsl/connections"
import "./styles.css"
import { Splash } from "@opencode-ai/ui/logo"
import { useTheme } from "@opencode-ai/ui/theme/context"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("desktop.error.dev.rootNotFound"))
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `desktop@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "desktop",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" &&
          !(
            import.meta.env.OPENCODE_CHANNEL === "prod" &&
            (i.name === "GlobalHandlers" || i.name === "BrowserApiErrors")
          ),
      )
    },
  })
}

const [updaterState, setUpdaterState] = createSignal<UpdaterState>({ status: "disabled" })
void window.api.updater.subscribe(setUpdaterState)

const deepLinkEvent = "opencode:deep-link"

type DesktopWindowState = {
  id?: string
}

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

function windowLastActiveUrlKey(windowID: string) {
  return `opencode.desktop.window.${windowID}.last-active-url`
}

function getLastActiveUrl(windowID: string) {
  if (typeof localStorage !== "object") return "/"
  try {
    const value = localStorage.getItem(windowLastActiveUrlKey(windowID))
    if (value?.startsWith("/") && !value.startsWith("//")) return value
  } catch {}
  return "/"
}

function setLastActiveUrl(windowID: string, value: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.setItem(windowLastActiveUrlKey(windowID), value)
  } catch {}
}

/**
 * Mirrors "the session this window is showing" onto the desktop pet. The chat
 * app uses a memory router, so nothing outside this listener can observe which
 * session is on screen — the URL never reaches the main process.
 */
const [boundSession, setBoundSession] = createSignal<string | null>(null)

function reportBoundSession(url: string) {
  const match = /\/session\/([^/?#]+)/.exec(url)
  let sessionID: string | null = null
  if (match) {
    try {
      sessionID = decodeURIComponent(match[1])
    } catch {
      sessionID = match[1]
    }
  }
  setBoundSession(sessionID)
  void window.api.pet.bindSession(sessionID).catch(() => undefined)
}

type PetPart = {
  type?: string
  tool?: string
  text?: string
  synthetic?: boolean
  time?: { start?: number; end?: number }
  state?: { status?: string; title?: string }
}

type PetMessage = {
  id: string
  role?: string
  error?: { name?: string }
}

type PetData = {
  info?: Record<string, { title?: string } | undefined>
  message?: Record<string, PetMessage[] | undefined>
  part?: Record<string, PetPart[] | undefined>
  session_status?: Record<string, { type?: string; attempt?: number } | undefined>
  permission?: Record<string, Array<{ permission?: string; patterns?: string[] }> | undefined>
  question?: Record<string, Array<{ questions?: Array<{ header?: string; question?: string }> }> | undefined>
}

/**
 * The newest tool call that has not finished. A finished tool means the model is
 * back to deciding what to do next, which reads as "thinking", not "working".
 */
function runningTool(parts: PetPart[] | undefined) {
  if (!parts) return null
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (!part) continue
    if (part.type === "tool") {
      const status = part.state?.status
      if (status === "running" || status === "pending") return part.state?.title || part.tool || "tool"
      return null
    }
    // Any newer text/reasoning/step marker means the tool round is over.
    if (part.type === "text" || part.type === "reasoning" || part.type === "step-start") return null
    if (part.type === "retry" || part.type === "step-finish") return null
  }
  return null
}

function latestParts(data: PetData, sessionID: string) {
  const messages = data.message?.[sessionID]
  if (!messages) return { parts: undefined, error: null as string | null, aborted: false }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== "assistant") continue
    const parts = data.part?.[message.id]
    // The user pressed stop. Not a failure, but not a successful finish either:
    // it gets its own pose instead of being folded into either one.
    const aborted = message.error?.name === "MessageAbortedError"
    const error = message.error && !aborted ? "这一轮出错了" : null
    if (parts && parts.length > 0) return { parts, error, aborted }
    if (error || aborted) return { parts: undefined, error, aborted }
  }
  return { parts: undefined, error: null as string | null, aborted: false }
}

/**
 * True while the assistant is streaming prose. `time.end` is stamped when a text
 * part finishes, so a missing end means it is still growing; synthetic text is a
 * system note (tool output, compaction summary) rather than the model talking.
 */
function streamingAnswer(parts: PetPart[] | undefined) {
  if (!parts) return false
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (!part) continue
    if (part.type === "text") {
      if (part.synthetic) return false
      return part.time?.end === undefined && Boolean(part.text?.trim())
    }
    if (part.type === "tool" || part.type === "reasoning" || part.type === "step-start") return false
    if (part.type === "compaction" || part.type === "retry" || part.type === "step-finish") return false
  }
  return false
}

/**
 * Compaction writes a summary before the turn continues, so the newest part is
 * the compaction marker until a step boundary lands after it.
 */
function compacting(parts: PetPart[] | undefined) {
  if (!parts) return false
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (!part) continue
    if (part.type === "compaction") return true
    if (part.type === "step-finish" || part.type === "tool") return false
  }
  return false
}

function permissionText(permission: { permission?: string; patterns?: string[] } | undefined) {
  if (!permission) return "有个权限等你点头"
  const action = typeof permission.permission === "string" ? permission.permission : ""
  const target = Array.isArray(permission.patterns) ? permission.patterns[0] : undefined
  const ask = [action, target].filter(Boolean).join(" ").slice(0, 90)
  return ask ? `有个权限等你点头：${ask}` : "有个权限等你点头"
}

function questionText(question: { questions?: Array<{ header?: string; question?: string }> } | undefined) {
  const first = question?.questions?.[0]
  const text = first?.header || first?.question
  const ask = typeof text === "string" ? text.trim().slice(0, 90) : ""
  return ask ? `想跟你确认一下：${ask}` : "有个事想跟你确认"
}

/** Keeps the greeting up long enough to read, matching the main-process expiry. */
const GREET_WINDOW_MS = 3000

/**
 * Drives the desktop pet from the state the chat UI renders. This replaces a
 * second SSE subscription inside the main process: `/api/event` is scoped to a
 * directory *and* a workspace, and it ends as soon as that instance is disposed,
 * so the pet kept either missing events or reconnecting every couple of seconds.
 */
function usePetActivity() {
  const global = useGlobal()
  const server = useServer()
  const sync = createMemo(() => {
    const conn = server.current
    return conn ? global.ensureServerCtx(conn).sync : undefined
  })

  let sent = ""
  let wasBusy = false
  let session: string | null = null
  /** Session already greeted, so tabbing back and forth does not replay it. */
  let greeted: string | null = null
  let greetUntil = 0

  const send = (state: PetState, detail: string | null, title: string | null, sessionID: string | null) => {
    // Every text delta re-runs this effect; only cross-process on a real change.
    const key = `${state}|${detail ?? ""}|${title ?? ""}|${sessionID ?? ""}`
    if (key === sent) return
    sent = key
    void window.api.pet.report({ sessionID, state, detail, title }).catch(() => undefined)
  }

  createEffect(() => {
    const sessionID = boundSession()
    const current = sync()
    if (sessionID !== session) {
      session = sessionID
      wasBusy = false
      sent = ""
      greeted = null
      greetUntil = 0
    }
    if (!sessionID) {
      send("idle", null, null, null)
      return
    }
    if (!current) return

    const data = current.session.data as unknown as PetData
    const title = data.info?.[sessionID]?.title ?? null
    const status = data.session_status?.[sessionID]
    const busy = (status?.type ?? "idle") !== "idle"
    const { parts, error, aborted } = latestParts(data, sessionID)

    // Priority: the user is what unblocks the turn, so ask them first.
    const permission = data.permission?.[sessionID]?.[0]
    if (permission) {
      send("waiting", permissionText(permission), title, sessionID)
      wasBusy = busy
      return
    }
    const question = data.question?.[sessionID]?.[0]
    if (question) {
      send("needsinput", questionText(question), title, sessionID)
      wasBusy = busy
      return
    }
    // A retry means the provider refused the call and we are backing off. That is
    // something to look at, not ordinary work, so it does not read as "thinking".
    if (status?.type === "retry") {
      send("attention", `重试 ${status.attempt ?? 1}`, title, sessionID)
      wasBusy = true
      return
    }
    if (busy) {
      if (compacting(parts)) {
        send("sweeping", "整理上下文", title, sessionID)
        wasBusy = true
        return
      }
      const tool = runningTool(parts)
      if (tool) {
        send("working", tool, title, sessionID)
        wasBusy = true
        return
      }
      // Answering out loud is a different pose from thinking it over silently.
      send(streamingAnswer(parts) ? "talking" : "thinking", null, title, sessionID)
      wasBusy = true
      return
    }
    if (aborted) {
      send("sad", "这一轮我停了", title, sessionID)
      wasBusy = false
      return
    }
    if (error) {
      send("error", error, title, sessionID)
      wasBusy = false
      return
    }
    // A session nobody has typed in yet: fly in to the desk once, then settle.
    const messages = data.message?.[sessionID]
    if (!messages || messages.length === 0) {
      if (greeted !== sessionID) {
        greeted = sessionID
        greetUntil = Date.now() + GREET_WINDOW_MS
      }
      if (Date.now() < greetUntil) {
        send("greet", null, title, sessionID)
        return
      }
    }
    // A finished turn is the only place "happy" makes sense; the main process
    // expires it a few seconds later on its own.
    send(wasBusy ? "happy" : "idle", null, title, sessionID)
    wasBusy = false
  })
}

function DesktopMemoryRouter(props: BaseRouterProps & { windowID: string }) {
  const history = createMemoryHistory()
  const initialUrl = getLastActiveUrl(props.windowID)
  if (initialUrl !== "/") history.set({ value: initialUrl, replace: true, scroll: false })
  onCleanup(
    history.listen((value) => {
      setLastActiveUrl(props.windowID, value)
      reportBoundSession(value)
    }),
  )
  reportBoundSession(initialUrl)
  return <MemoryRouter {...props} history={history} />
}

const createPlatform = (windowState: DesktopWindowState): Platform => {
  const attachmentPaths = new WeakMap<File, string>()

  // Notifications currently voiced by the pet. A click refers to a bubble that
  // is still on screen, so keeping the last few is enough — and dropping older
  // entries stops the map from growing for the life of the window.
  const petSpeech = new Map<string, () => void>()
  let petSpeechSeq = 0
  window.api.pet.onSayClick((id) => {
    const action = petSpeech.get(id)
    petSpeech.delete(id)
    if (!action) return
    void window.api.showWindow().catch(() => undefined)
    void window.api.setWindowFocus().catch(() => undefined)
    action()
  })
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const runDesktopMenuAction: Platform["runDesktopMenuAction"] = (action) => {
    switch (action) {
      case "view.resetZoom":
        resetZoom()
        return
      case "view.zoomIn":
        zoomIn()
        return
      case "view.zoomOut":
        zoomOut()
        return
    }

    return window.api.runDesktopMenuAction(action)
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  const wslServersApi = os === "windows" ? window.api.wslServers : undefined

  return {
    platform: "desktop",
    os,
    version: pkg.version,
    windowID: windowState.id,

    async openDirectoryPickerDialog(opts) {
      return window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title,
      })
    },

    async openAttachmentPickerDialog(opts, onFile) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title,
        defaultPath: opts?.defaultPath,
        extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
      })
      if (!result) return
      try {
        for (const file of result.files) {
          const selected = new File([await window.api.readPickedFile(result.token, file.path)], file.name)
          attachmentPaths.set(selected, file.path)
          await onFile(selected)
        }
      } finally {
        await window.api.releasePickedFiles(result.token)
      }
    },

    getPathForFile(file) {
      return attachmentPaths.get(file) ?? window.api.getPathForFile(file)
    },

    async saveFilePickerDialog(opts) {
      return window.api.saveFilePicker({
        title: opts?.title,
        defaultPath: opts?.defaultPath,
      })
    },

    openExternal(url: string) {
      window.api.openExternal(url)
    },
    openLocalFile(url: string) {
      window.api.openLocalFile(url)
    },
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        return window.api.openPath(path, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },
    async revealPath(path: string) {
      return window.api.revealPath(path)
    },

    storage,
    draftStore: createDraftStore({
      get: window.api.draftGet,
      set: window.api.draftSet,
      remove: window.api.draftDelete,
      putBlob: (blob) => blob.arrayBuffer().then(window.api.draftBlobPut),
      getBlob: (id) => window.api.draftBlobGet(id).then((data) => data && new Blob([data])),
    }),

    updater: {
      state: updaterState,
      check: () => window.api.updater.check(),
      install: () => window.api.updater.install(),
    },

    exportDebugLogs: () => window.api.exportDebugLogs(),

    setForceFocus: (enabled) => window.api.setForceFocus(enabled),

    recordFatalRendererError: (error) => window.api.recordFatalRendererError(error),

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, onClick, tone) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return

      // The pet is the thing already sitting on top of the desktop, so it gets
      // the notification. A Windows toast in the bottom-right corner would be a
      // second source of truth for the same event, and the user asked for one.
      const id = `pet-say-${++petSpeechSeq}`
      if (onClick) {
        petSpeech.set(id, onClick)
        while (petSpeech.size > 4) {
          const oldest = petSpeech.keys().next()
          if (oldest.done) break
          petSpeech.delete(oldest.value)
        }
      }
      const said = await window.api.pet
        .say({ id, title, detail: description ?? null, tone: tone ?? "info" })
        .catch(() => false)
      if (said) return
      // No pet on screen: fall back to the toast rather than swallow the event.
      petSpeech.delete(id)

      const notification = new Notification(title, {
        body: description ?? "",
        icon: "https://opencode.ai/favicon-96x96-v3.png",
      })
      notification.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        onClick?.()
        notification.close()
      }
    },

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return ServerConnection.Key.make(url)
    },

    setDefaultServer: async (url: string | null) => {
      await window.api.setDefaultServerUrl(url)
    },

    wslServers: wslServersApi,

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    webviewZoom,

    windowFullscreen,

    getPinchZoomEnabled: () => window.api.getPinchZoomEnabled(),

    setPinchZoomEnabled,

    runDesktopMenuAction,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
listenForDeepLinks()

function LoadingSplash() {
  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
      <Splash class="w-16 h-20 opacity-50 animate-pulse" />
    </div>
  )
}

function DesktopRoot(props: { windowState: DesktopWindowState }) {
  const platform = createPlatform(props.windowState)
  const loadLocale = async () => {
    const current = await platform.storage?.("opencode.global.dat").getItem("language")
    const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
    const raw = current ?? legacy
    if (!raw) return
    const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
    if (!locale) return
    const next = normalizeLocale(locale)
    if (next !== "en") await loadLocaleDict(next)
    return next satisfies Locale
  }

  // Fetch sidecar credentials (available immediately, before health check)
  const [sidecar] = createResource(() => window.api.awaitInitialization())

  const [defaultServer] = createResource(() => platform.getDefaultServer?.())
  const [locale] = createResource(loadLocale)
  const router = (props: BaseRouterProps) => (
    <DesktopMemoryRouter {...props} windowID={platform.windowID ?? "browser"} />
  )
  const onboarding = Promise.withResolvers<void>()

  function Inner() {
    const cmd = useCommand()
    menuTrigger = (id) => cmd.trigger(id)

    const theme = useTheme()
    usePetActivity()

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) {
        void window.api.setBackgroundColor(bg)
      }
    })

    return null
  }

  function App() {
    const wslServers = useWslServers()
    const language = useLanguage()
    const ready = createMemo(
      () => !defaultServer.loading && !sidecar.loading && !locale.loading && !wslServers.isLoading,
    )
    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const list: ServerConnection.Any[] = []
      if (data) {
        list.push({
          displayName: language.t("desktop.server.local"),
          type: "sidecar",
          variant: "base",
          http: {
            url: data.url,
            username: data.username ?? undefined,
            password: data.password ?? undefined,
          },
        })
      }
      list.push(...readyWslConnections(wslServers.data, language.t("wsl.server.label")))
      return list
    })
    const effectiveDefaultServer = createMemo(() =>
      ServerConnection.Key.make(availableStartupServer(defaultServer.latest, wslServers.data)),
    )
    return (
      <Show when={ready()} fallback={<LoadingSplash />}>
        <Show when={effectiveDefaultServer()} keyed>
          {(key) => (
            <AppInterface
              defaultServer={key}
              servers={servers()}
              router={router}
              startup={onboarding.promise}
              serverScoped={
                <DesktopFirstLaunchOnboarding
                  initialUrl={getLastActiveUrl(platform.windowID ?? "browser")}
                  onLoaded={onboarding.resolve}
                />
              }
            >
              <Inner />
            </AppInterface>
          )}
        </Show>
      </Show>
    )
  }

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders
        locale={locale.latest}
        onNativeTranslations={(bundle) => void window.api.setNativeTranslations(bundle).catch(() => undefined)}
      >
        <Show when={true}>{(_) => <App />}</Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

render(() => {
  const [windowState] = createResource(async () => {
    const api = window.api as typeof window.api & {
      getWindowID?: () => Promise<string>
    }
    return { id: await api.getWindowID?.() }
  })

  return (
    <Show when={windowState.latest} fallback={<LoadingSplash />} keyed>
      {(state) => <DesktopRoot windowState={state} />}
    </Show>
  )
}, root!)
