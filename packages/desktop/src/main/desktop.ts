import { NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node"
import { app } from "electron"
import { Effect, Layer } from "effect"
import { Plugins } from "./plugin"
import { Ipc } from "./ipc"
import { DesktopInitialization } from "./lifecycle/desktop-initialization"
import { installContextMenu } from "./lifecycle/environment"
import { ApplicationLifecycle } from "./lifecycle"
import { DesktopLogging } from "./native/logging"
import { BackgroundService } from "./service/background-service"
import { DesktopCli } from "./service/desktop-cli"
import { marks } from "./lifecycle/marks"
import { startPet, getPetWindow, stopPet } from "./pet"

// Everything above has been loaded and evaluated by now; the layers start below.
marks.bundle = Date.now()

const runIpc = Effect.fn("Desktop.runIpc")(function* () {
  const lifecycle = yield* ApplicationLifecycle.Service
  const plugins = yield* Plugins.Service
  marks.layers = Date.now()
  yield* Effect.logInfo("layers ready", { marks })
  const ipc = yield* Ipc.registerIpcHandlers
  // Main GUI plugins start with the window: servers they restore feed the first paint's server
  // list, and menu items they contribute are present at startup. Their heavy modules load lazily on
  // first use.
  yield* Effect.forkScoped(plugins.start)

  if (lifecycle.restoreWindows().length) ipc.installMenu()
  startPet()
  // The first window's renderer now has its IPC port and is hydrating its stores over it. The crash
  // reporter (spawns a process) and the context menu (a dependency tree) are not worth answering late.
  yield* Effect.sleep("500 millis")
  const logging = yield* DesktopLogging.Service
  yield* logging.startCrashReporter
  yield* installContextMenu
  // The pet is a window too, so window-all-closed would never fire. Quit when
  // the last non-pet window goes away instead.
  const { app } = yield* Effect.sync(() => require("electron"))
  const { BrowserWindow } = yield* Effect.sync(() => require("electron"))
  yield* Effect.sync(() => {
    app.on("browser-window-created", (_e: unknown, win: Electron.BrowserWindow) => {
      win.on("closed", () => {
        if (win === getPetWindow()) return
        if (process.platform === "darwin") return
        const remaining = BrowserWindow.getAllWindows().filter(
          (c: Electron.BrowserWindow) => c !== getPetWindow() && !c.isDestroyed(),
        )
        if (remaining.length === 0) app.quit()
      })
    })
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => stopPet()))
  yield* Effect.callback<void>((resume) => {
    const quit = () => resume(Effect.void)
    app.once("will-quit", quit)

    return Effect.sync(() => app.off("will-quit", quit))
  })
})

runIpc().pipe(
  Effect.provide(Ipc.layer),
  Effect.provide(BackgroundService.layer),
  Effect.provide(DesktopCli.layer),
  Effect.provide(DesktopInitialization.layer),
  Effect.provide(ApplicationLifecycle.layer),
  Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
  Effect.scoped,
  NodeRuntime.runMain,
)
