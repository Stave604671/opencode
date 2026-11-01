/**
 * Mirrors "what the session on screen is doing" onto the desktop pet.
 *
 * The chat app uses a memory router, so nothing outside this listener can
 * observe which session is on screen. The pet is driven from the same sync
 * store the chat UI renders from: one source of truth, no second event stream.
 */
import { createEffect, createMemo, createSignal } from "solid-js"
import { useGlobal, useServers } from "@opencode/app/desktop"
import type { PetAPI, PetState } from "../preload/types"

declare global {
  interface Window {
    api: { pet: PetAPI }
  }
}

/** Which session the window is showing, published by the router on every navigation. */
const [boundSession, setBoundSession] = createSignal<string | null>(null)

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

/**
 * The parts of a message this file reads. Typed by hand: the pet only needs four
 * signals (is a tool running, is prose streaming, did the turn fail, was it
 * compacting), and a shape change should degrade to "no state", not a crash.
 */
type PetPart = {
  type?: string
  name?: string
  text?: string
  state?: { status?: string }
}

type PetMessage = {
  type?: string
  time?: { completed?: number }
  content?: PetPart[]
  error?: { type?: string; name?: string; message?: string }
}

function latest(messages: PetMessage[], type: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === type) return message
  }
  return undefined
}

function runningTool(message: PetMessage | undefined) {
  const content = message?.content ?? []
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const part = content[index]
    if (!part) continue
    if (part.type === "tool") {
      const status = part.state?.status
      if (status === "streaming" || status === "pending" || status === "running") return part.name || "tool"
      return null
    }
    if (part.type === "text" || part.type === "reasoning") return null
  }
  return null
}

function streamingAnswer(message: PetMessage | undefined) {
  const content = message?.content ?? []
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const part = content[index]
    if (!part) continue
    if (part.type === "text") return message?.time?.completed === undefined && Boolean(part.text?.trim())
    if (part.type === "tool" || part.type === "reasoning") return false
  }
  return false
}

function interrupted(message: PetMessage | undefined) {
  const name = message?.error?.type ?? message?.error?.name ?? ""
  return /abort/i.test(name)
}

const GREET_WINDOW_MS = 3000

/**
 * Drives the desktop pet from the state the chat UI renders. Called from a
 * component mounted under the app providers so it tears down with the window.
 */
export function usePetActivity() {
  const global = useGlobal()
  const servers = useServers()

  // The window follows its own server: the bundled sidecar, or whichever server
  // served this window when it is not the sidecar.
  const store = createMemo(() => {
    const conn = servers.visible.find((candidate) => servers.current(candidate)) ?? servers.visible[0]
    return conn ? global.ensureServerCtx(conn).data : undefined
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
    const data = store()
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
    if (!data) return

    const title = data.session.get(sessionID)?.title ?? null
    const busy = data.session.status(sessionID) === "running"
    const messages = data.session.message.list(sessionID) as unknown as PetMessage[]
    const permission = data.session.permission.list(sessionID)?.[0]
    const form = data.session.form.list(sessionID)?.[0]
    const assistant = latest(messages, "assistant")

    const permissionLine = permission
      ? [permission.action, permission.resources?.[0]].filter((part) => typeof part === "string" && part).join(" ")
      : ""

    if (permission) {
      send("waiting", permissionLine || "有个权限等你点头", title, sessionID)
      wasBusy = busy
      return
    }
    if (form) {
      send("needsinput", form.title || "有个事想跟你确认", title, sessionID)
      wasBusy = busy
      return
    }
    if (busy) {
      if (latest(messages, "compaction")) {
        send("sweeping", "整理上下文", title, sessionID)
        wasBusy = true
        return
      }
      const tool = runningTool(assistant)
      if (tool) {
        send("working", tool, title, sessionID)
        wasBusy = true
        return
      }
      send(streamingAnswer(assistant) ? "talking" : "thinking", null, title, sessionID)
      wasBusy = true
      return
    }
    const failure = assistant?.error?.message
    if (failure && interrupted(assistant)) {
      send("sad", "这一轮我停了", title, sessionID)
      wasBusy = false
      return
    }
    if (failure) {
      send("error", "这一轮出错了", title, sessionID)
      wasBusy = false
      return
    }
    if (messages.length === 0) {
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
