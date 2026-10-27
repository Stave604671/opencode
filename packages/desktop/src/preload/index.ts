import { contextBridge, ipcRenderer, webUtils } from "electron"
import {
  DragCancelEvent,
  IpcTransportPort,
  WindowSnapshotChannel,
  storageSnapshotNames,
  type WindowSnapshot,
} from "../shared/ipc-transport"
import { windowBootstrapFromArguments } from "../shared/window-bootstrap"
import type { PetActivity, PetSnapshot, PetSpeech } from "./types"

ipcRenderer.on(IpcTransportPort, (event) => {
  const port = event.ports[0]

  if (port) window.postMessage(IpcTransportPort, "*", [port])
})

ipcRenderer.on(DragCancelEvent, () => window.dispatchEvent(new Event(DragCancelEvent)))

const bootstrap = windowBootstrapFromArguments(process.argv)

// Asked before the page runs, so the stores the shell reads are hydrated on the first render.
const snapshot: Promise<WindowSnapshot> = ipcRenderer
  .invoke(WindowSnapshotChannel, storageSnapshotNames(bootstrap.id))
  .catch(() => ({ storage: {} }))

contextBridge.exposeInMainWorld("electron", {
  windowID: bootstrap.id,
  bootstrap,
  storageSnapshot: snapshot.then((snapshot) => snapshot.storage),
  plugins: snapshot.then((snapshot) => snapshot.plugins),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
})

contextBridge.exposeInMainWorld("api", {
  pet: {
    getState: () => ipcRenderer.invoke("pet-get-state"),
    onState: (cb: (s: PetSnapshot) => void) => {
      const h = (_: unknown, s: PetSnapshot) => cb(s)
      ipcRenderer.on("pet-state", h)
      return () => ipcRenderer.removeListener("pet-state", h)
    },
    report: (a: PetActivity) => ipcRenderer.invoke("pet-report", a),
    say: (s: PetSpeech) => ipcRenderer.invoke("pet-say", s),
    sayClick: (id: string) => ipcRenderer.invoke("pet-say-click", id),
    onSay: (cb: (s: PetSpeech) => void) => {
      const h = (_: unknown, s: PetSpeech) => cb(s)
      ipcRenderer.on("pet-say", h)
      return () => ipcRenderer.removeListener("pet-say", h)
    },
    onSayClick: (cb: (id: string) => void) => {
      const h = (_: unknown, id: string) => cb(id)
      ipcRenderer.on("pet-say-click", h)
      return () => ipcRenderer.removeListener("pet-say-click", h)
    },
    focusMain: () => ipcRenderer.invoke("pet-focus-main"),
    dragStart: () => ipcRenderer.invoke("pet-drag-start"),
    dragTo: (dx: number, dy: number) => ipcRenderer.invoke("pet-drag-move", dx, dy),
    dragEnd: () => ipcRenderer.invoke("pet-drag-end"),
    getVisible: () => ipcRenderer.invoke("pet-get-visible"),
    setVisible: (v: boolean) => ipcRenderer.invoke("pet-set-visible", v),
    toggle: () => ipcRenderer.invoke("pet-toggle"),
    bindSession: (id: string | null) => ipcRenderer.invoke("pet-bind-session", id),
  },
})
