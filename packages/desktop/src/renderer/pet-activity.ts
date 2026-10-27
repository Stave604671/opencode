/**
 * Mirrors "what the session on screen is doing" onto the desktop pet.
 *
 * The chat app uses a memory router, so nothing outside this listener can
 * observe which session is on screen. The pet is driven from the same sync
 * store the chat UI renders from: one source of truth, no second event stream.
 */
import { createEffect, createMemo } from "solid-js"
import { useGlobal, useServer } from "@opencode/app"
import type { PetState } from "../preload/types"

declare global {
  interface Window {
    api?: {
      pet?: {
        report: (activity: { sessionID: string | null; state: PetState; detail: string | null; title: string | null }) => Promise<void>
        bindSession: (sessionID: string | null) => Promise<void>
      }
    }
  }
}

const [boundSession, setBoundSession] = createSignalLocal<string | null>(null)

// Minimal signal without importing solid's createSignal at module level
let _bs: string | null = null
const _bsListeners = new Set<(v: string | null) => void>()
function createSignalLocal<T>(initial: T) {
  let value = initial
  const listeners = new Set<(v: T) => void>()
  return [
    () => value,
    (next: T) => {
      value = next
      listeners.forEach((l) => l(next))
    },
  ] as const
}

export function reportBoundSession(url: string) {
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
  void window.api?.pet?.bindSession(sessionID).catch(() => undefined)
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

function runningTool(parts: PetPart[] | undefined) {
  if (!parts) return null
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]
    if (!part) continue
    if (part.type === "tool") {
      const status = part.state?.status
      if (status === "running" || status === "pending") return part.state?.title || part.tool || "tool"
      return null
    }
    if (part.type === "text" || part.type === "reasoning" || part.type === "step-start") return null
    if (part.type === "retry" || part.type === "step-finish") return null
  }
  return null
}

function latestParts(data: PetData, sessionID: string) {
  const messages = data.message?.[sessionID]
  if (!messages) return { parts: undefined, error: null as string | null, aborted: false }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role !== "assistant") continue
    const parts = data.part?.[message.id]
    const aborted = message.error?.name === "MessageAbortedError"
    const error = message.error && !aborted ? "这一轮出错了" : null
    if (parts && parts.length > 0) return { parts, error, aborted }
    if (error || aborted) return { parts: undefined, error, aborted }
  }
  return { parts: undefined, error: null as string | null, aborted: false }
}

function streamingAnswer(parts: PetPart[] | undefined) {
  if (!parts) return false
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]
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

function compacting(parts: PetPart[] | undefined) {
  if (!parts) return false
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]
    if (!part) continue
    if (part.type === "compaction") return true
    if (part.type === "step-finish" || part.type === "tool") return false
  }
  return false
}

const GREET_WINDOW_MS = 3000

/**
 * Drives the desktop pet from the state the chat UI renders. Called from
 * DesktopApp's effect scope so it tears down with the window.
 */
export function usePetActivity() {
  const global = useGlobal()
  const server = useServer()
  const sync = createMemo(() => {
    const conn = server.current
    return conn ? global.ensureServerCtx(conn).sync : undefined
  })

  let sent = ""
  let wasBusy = false
  let session: string | null = null
  let greeted: string | null = null
  let greetUntil = 0

  const send = (state: PetState, detail: string | null, title: string | null, sessionID: string | null) => {
    const key = state + "|" + (detail ?? "") + "|" + (title ?? "") + "|" + (sessionID ?? "")
    if (key === sent) return
    sent = key
    void window.api?.pet?.report({ sessionID, state, detail, title }).catch(() => undefined)
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

    const permission = data.permission?.[sessionID]?.[0]
    if (permission) {
      send("waiting", "有个权限等你点头", title, sessionID)
      wasBusy = busy
      return
    }
    const question = data.question?.[sessionID]?.[0]
    if (question) {
      send("needsinput", "有个事想跟你确认", title, sessionID)
      wasBusy = busy
      return
    }
    if (status?.type === "retry") {
      send("attention", "重试 " + (status.attempt ?? 1), title, sessionID)
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
    send(wasBusy ? "happy" : "idle", null, title, sessionID)
    wasBusy = false
  })
}
