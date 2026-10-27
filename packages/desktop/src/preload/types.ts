import type { StorageSnapshot, WindowSnapshot } from "../shared/ipc-transport"
import type { WindowBootstrap } from "../shared/window-bootstrap"

export type ElectronNative = {
  windowID: string
  bootstrap: WindowBootstrap
  storageSnapshot: Promise<StorageSnapshot>
  plugins: Promise<WindowSnapshot["plugins"]>
  getPathForFile(file: File): string
}

export type PetState = "idle" | "thinking" | "working" | "talking" | "sweeping" | "waiting" | "needsinput" | "attention" | "error" | "sad" | "happy" | "greet" | "loafing" | "sleeping"

export type PetSnapshot = { state: PetState; sessionID: string | null; title: string | null; detail: string | null; idleMs: number | null; at: number }

export type PetActivity = { sessionID: string | null; state: PetState; detail: string | null; title: string | null }

export type PetSpeech = { id: string; title: string; detail: string | null; tone: "done" | "error" | "info" }

export type PetAPI = {
  getState: () => Promise<PetSnapshot>
  onState: (cb: (state: PetSnapshot) => void) => () => void
  report: (activity: PetActivity) => Promise<void>
  say: (speech: PetSpeech) => Promise<boolean>
  sayClick: (id: string) => Promise<void>
  onSay: (cb: (speech: PetSpeech) => void) => () => void
  onSayClick: (cb: (id: string) => void) => () => void
  focusMain: () => Promise<void>
  dragStart: () => Promise<void>
  dragTo: (dx: number, dy: number) => Promise<void>
  dragEnd: () => Promise<void>
  getVisible: () => Promise<boolean>
  setVisible: (visible: boolean) => Promise<boolean>
  toggle: () => Promise<boolean>
  bindSession: (sessionID: string | null) => Promise<void>
}
