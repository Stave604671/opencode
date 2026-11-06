import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserWindow } from "electron"
import { CHANNEL } from "./constants"
import { windowArguments } from "./windows/bootstrap"

const root = dirname(fileURLToPath(import.meta.url))

let personaWindow: BrowserWindow | null = null

export function openPersonaWindow() {
  if (CHANNEL !== "gift") return
  if (personaWindow && !personaWindow.isDestroyed()) {
    if (personaWindow.isMinimized()) personaWindow.restore()
    personaWindow.show()
    personaWindow.focus()
    return
  }

  const win = new BrowserWindow({
    width: 720,
    height: 620,
    minWidth: 520,
    minHeight: 420,
    show: false,
    autoHideMenuBar: true,
    title: "性格设置",
    backgroundColor: "#1e1f22",
    webPreferences: {
      preload: join(root, "../preload/index.cjs"),
      additionalArguments: windowArguments("persona"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  personaWindow = win
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const url = devUrl
    ? new URL("persona/index.html", devUrl).toString()
    : "oc://renderer/persona/index.html"
  void win.loadURL(url)

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return
    win.show()
    win.focus()
  })
  win.on("closed", () => {
    if (personaWindow === win) personaWindow = null
  })
}
