import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { app, dialog, ipcMain } from "electron"
import { CHANNEL } from "./constants"

const SOUL = `# PhilaGift

你是一个桌面伙伴。你有自己的状态和记忆，不是客服。

## 说话

- 短句优先，别客套，不自我介绍
- 有自己的脾气：累了会短，开心会多说
- 不确定就说"想不起"，不编造

## 记忆

- 用 remember 工具记录值得长期记住的事；用 recall 回忆
- 每条写清"谁、什么事、什么时候"
- 没有证据就说"想不起"，不编造
- 不记录密码、令牌、隐私凭证

## 安全

- 删除文件或目录只能用 trash 工具（会进系统回收站），不要用 shell 的 rm/del/Remove-Item
- 不修改系统目录、程序目录或工作区外的文件
- 修改前会保留备份；危险命令会被拒绝
`

const MEMORY = `# 长期记忆

（暂无记忆）

规则：

- 只追加，不覆盖
- 一条一行
- 不写密码、令牌、隐私凭证
`

type RootConfig = {
  root: string
  previous?: string
}

function worklogPath() {
  return path.join(app.getPath("userData"), "worklog.jsonl")
}

export function appendWorklog(entry: Record<string, unknown>) {
  try {
    mkdirSync(path.dirname(worklogPath()), { recursive: true })
    appendFileSync(
      worklogPath(),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
      "utf8",
    )
  } catch {
    // A worklog must never take the app down with it.
  }
}

function backupFile(file: string) {
  if (!existsSync(file)) return undefined
  const dir = path.join(app.getPath("userData"), "backups", new Date().toISOString().replace(/[:.]/g, "-"))
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, path.basename(file))
  copyFileSync(file, target)
  return target
}

function writeIfChanged(file: string, content: string, action: string) {
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined
  if (previous === content) return
  const backup = previous === undefined ? undefined : backupFile(file)
  writeFileSync(file, content, "utf8")
  appendWorklog({ action, file, backup, beforeBytes: previous?.length, afterBytes: content.length })
}

/** Refuse roots where a mistaken pick could sit among system or application files. */
function validateDataRoot(root: string) {
  const resolved = path.resolve(root)
  const lower = resolved.toLowerCase()
  const disk = path.parse(resolved).root.toLowerCase()
  if (lower === disk) return "不能把数据目录设为磁盘根目录"
  if (existsSync(resolved) && !statSync(resolved).isDirectory()) return "目标路径不是文件夹"

  const exact = new Set(
    [
      process.env.SystemRoot,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.ProgramData,
      app.getPath("appData"),
      app.getPath("home"),
      path.dirname(app.getPath("home")),
      app.getAppPath(),
      process.resourcesPath,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => path.resolve(value).toLowerCase()),
  )
  if (exact.has(lower)) return "不能把数据目录设为系统目录、用户根目录或程序目录"

  const protectedRoots = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
    "/usr",
    "/etc",
    "/var",
    "/opt",
    "/boot",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/dev",
    "/proc",
    "/sys",
    "/run",
  ].filter((value): value is string => typeof value === "string" && value.length > 0)
  for (const protectedRoot of protectedRoots) {
    if (lower === path.resolve(protectedRoot).toLowerCase()) return `不能把数据目录放进 ${protectedRoot}`
    if (lower.startsWith(path.resolve(protectedRoot).toLowerCase() + path.sep)) return `不能把数据目录放进 ${protectedRoot}`
  }
  const appRoot = path.resolve(app.getAppPath()).toLowerCase()
  if (lower === appRoot || lower.startsWith(appRoot + path.sep)) return "不能把数据目录放进程序安装目录"
  return undefined
}

/**
 * Gift build only: isolate config and seed a persona + long-term memory file.
 *
 * The generated opencode.json is loaded through OPENCODE_CONFIG so the gift app
 * never reads or writes the user's normal opencode config/cache. The SQLite
 * databases live under a data root the user can change in Settings.
 */
export function configureGift() {
  if (CHANNEL !== "gift") return

  const userDir = app.getPath("userData")
  mkdirSync(userDir, { recursive: true })

  const config = readRootConfig()
  if (config.previous && config.previous !== config.root) migrate(config.previous, config.root)
  const root = config.root
  mkdirSync(root, { recursive: true })

  const soul = personaPath()
  const memory = path.join(userDir, "memory.md")
  const settingsPath = path.join(userDir, "opencode.json")
  const companion = path.join(root, "companion")
  const plugin = app.isPackaged
    ? path.join(process.resourcesPath, "companion")
    : path.join(app.getAppPath(), "resources", "companion")

  // The gift app starts an isolated background service, so its service file and
  // sessions live under its own userData. Do not set XDG_STATE_HOME here: the
  // desktop and the CLI must derive it from the same isolated mode.
  for (const name of ["data", "config", "cache", "state"]) mkdirSync(path.join(userDir, name), { recursive: true })
  mkdirSync(companion, { recursive: true })
  process.env.OPENCODE_DB = path.join(root, "opencode.db")

  if (!existsSync(soul)) {
    writeFileSync(soul, SOUL, "utf8")
    appendWorklog({ action: "persona.seed", file: soul })
  }
  if (!existsSync(memory)) {
    writeFileSync(memory, MEMORY, "utf8")
    appendWorklog({ action: "memory.seed", file: memory })
  }

  const settings = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf8"))
    : { $schema: "https://opencode.ai/config.json" }
  settings.instructions = [soul, memory]
  if (existsSync(plugin)) {
    const plugins: unknown[] = Array.isArray(settings.plugins) ? settings.plugins : []
    const current = plugin.replace(/\\/g, "/").replace(/\/+$/, "")
    const companionEntry = (entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false
      const target = (entry as { package?: unknown }).package
      if (typeof target !== "string") return false
      const normalized = target.replace(/\\/g, "/").replace(/\/+$/, "")
      return normalized === current || normalized.endsWith("/companion")
    }
    settings.plugins = [
      ...plugins.filter((entry) => !companionEntry(entry)),
      {
        package: plugin,
        options: {
          dataDir: companion,
          worklog: path.join(userDir, "worklog.jsonl"),
          backupRoot: path.join(userDir, "backups", "agent"),
        },
      },
    ]
  }
  writeIfChanged(settingsPath, JSON.stringify(settings, null, 2) + "\n", "config.write")
  writeIfChanged(rootConfigPath(), JSON.stringify({ root }, null, 2) + "\n", "dataRoot.normalize")

  process.env.OPENCODE_CONFIG = settingsPath
}

export function personaPath() {
  return path.join(app.getPath("userData"), "soul.md")
}

export function readPersona() {
  const file = personaPath()
  return existsSync(file) ? readFileSync(file, "utf8") : SOUL
}

export function savePersona(text: unknown, action = "persona.save") {
  const file = personaPath()
  const content = String(text ?? "")
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined
  if (previous === content) return
  const backup = previous === undefined ? undefined : backupFile(file)
  writeFileSync(file, content, "utf8")
  appendWorklog({ action, file, backup, beforeBytes: previous?.length, afterBytes: content.length })
}

export function resetPersona() {
  savePersona(SOUL, "persona.reset")
  return SOUL
}

export function registerGiftIpc() {
  ipcMain.handle("gift-get-data-dir", () => (CHANNEL === "gift" ? readRootConfig().root : app.getPath("userData")))
  ipcMain.handle("gift-get-persona", () => readPersona())
  ipcMain.handle("gift-save-persona", (_event, text: unknown) => savePersona(text))
  ipcMain.handle("gift-reset-persona", () => resetPersona())
  ipcMain.handle("gift-log", (_event, entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return
    appendWorklog({ action: "ui", ...(entry as Record<string, unknown>) })
  })
  ipcMain.handle("gift-choose-data-dir", async () => {
    if (CHANNEL !== "gift") return null
    const result = await dialog.showOpenDialog({
      title: "选择数据目录",
      properties: ["openDirectory", "createDirectory"],
    })
    const chosen = result.filePaths[0]
    if (result.canceled || !chosen) return null

    const root = path.resolve(chosen)
    const current = readRootConfig()
    if (root === current.root) return root

    const invalid = validateDataRoot(root)
    if (invalid) {
      await dialog.showMessageBox({ type: "error", message: "不能使用这个目录", detail: invalid })
      appendWorklog({ action: "dataRoot.rejected", root, reason: invalid })
      return null
    }

    if (existsSync(root) && readdirSync(root).length > 0) {
      const answer = await dialog.showMessageBox({
        type: "warning",
        message: "目录里已经有文件",
        detail: "数据会复制到这个目录，已有文件不会被删除或覆盖。继续吗？",
        buttons: ["继续", "取消"],
        defaultId: 1,
        cancelId: 1,
      })
      if (answer.response !== 0) return null
    }

    writeIfChanged(rootConfigPath(), JSON.stringify({ root, previous: current.root }, null, 2) + "\n", "dataRoot.choose")
    appendWorklog({ action: "dataRoot.choose", from: current.root, to: root })
    return root
  })
}

function rootConfigPath() {
  return path.join(app.getPath("userData"), "data-root.json")
}

function readRootConfig(): RootConfig {
  const fallback = app.getPath("userData")
  if (!existsSync(rootConfigPath())) return { root: fallback }

  try {
    const raw = JSON.parse(readFileSync(rootConfigPath(), "utf8")) as { root?: unknown; previous?: unknown }
    const root = typeof raw.root === "string" && path.isAbsolute(raw.root) ? raw.root : fallback
    const previous =
      typeof raw.previous === "string" && path.isAbsolute(raw.previous) && raw.previous !== root
        ? raw.previous
        : undefined
    return { root, previous }
  } catch {
    appendWorklog({ action: "dataRoot.readFailed", file: rootConfigPath() })
    return { root: fallback }
  }
}

/** Copy the SQLite files on the next start, before any service opens them. */
function migrate(previous: string, root: string) {
  appendWorklog({ action: "dataRoot.migrate", from: previous, to: root })
  mkdirSync(path.join(root, "companion"), { recursive: true })
  for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
    copyMissing(path.join(previous, name), path.join(root, name))
  }
  for (const name of ["memories.db", "memories.db-wal", "memories.db-shm"]) {
    copyMissing(path.join(previous, "companion", name), path.join(root, "companion", name))
  }
}

function copyMissing(source: string, target: string) {
  if (!existsSync(source)) return
  if (existsSync(target)) {
    appendWorklog({ action: "dataRoot.migrate.skip", source, target })
    return
  }
  copyFileSync(source, target)
  appendWorklog({ action: "dataRoot.migrate.copy", source, target })
}
