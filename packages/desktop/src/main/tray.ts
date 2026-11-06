import { app, Menu, Tray } from "electron"
import { CHANNEL } from "./constants"
import { focusMainWindow, quitApp } from "./pet"
import { openPersonaWindow } from "./persona"

let tray: Tray | null = null

export async function startTray() {
  if (CHANNEL !== "gift" || tray) return

  const icon = await app.getFileIcon(process.execPath, { size: "small" }).catch(() => undefined)
  if (!icon || icon.isEmpty()) return

  tray = new Tray(icon)
  tray.setToolTip("PhilaGift")
  tray.on("double-click", () => focusMainWindow())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开工作窗口", click: () => focusMainWindow() },
      { label: "编辑性格…", click: () => openPersonaWindow() },
      { type: "separator" },
      { label: "退出 PhilaGift", click: () => quitApp() },
    ]),
  )
}

export function stopTray() {
  tray?.destroy()
  tray = null
}
