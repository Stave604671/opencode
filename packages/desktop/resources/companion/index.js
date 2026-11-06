import { Plugin } from "@opencode/plugin"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { appendFileSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs"
import path from "node:path"

const TICK_MS = 60_000
const MINUTE = 60_000
const DAY = 86_400_000
const EVENT_LIMIT = 500
const RECALL_LIMIT = 6

const latest = new Map()
let database
let scheduler

export default Plugin.define({
  id: "phila.companion",
  async setup(ctx) {
    const dataDir =
      typeof ctx.options.dataDir === "string" ? ctx.options.dataDir : path.join(ctx.location.directory, ".phila")
    mkdirSync(dataDir, { recursive: true })
    database = open(dataDir)

    if (!Number(stateGet(database, "next_proactive_at", 0))) {
      stateSet(database, "next_proactive_at", Date.now() + random(30, 90) * MINUTE)
    }

    const workspace = path.resolve(ctx.location.directory)
    const dataRoot = path.resolve(dataDir)
    const worklog =
      typeof ctx.options.worklog === "string" ? path.resolve(ctx.options.worklog) : path.join(dataDir, "worklog.jsonl")
    const backupRoot =
      typeof ctx.options.backupRoot === "string" ? path.resolve(ctx.options.backupRoot) : path.join(dataDir, "backups")

    const record = (entry) => {
      try {
        mkdirSync(path.dirname(worklog), { recursive: true })
        appendFileSync(worklog, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8")
      } catch {
        // The worklog is a safety net, never a reason for a write to fail.
      }
    }

    const inside = (base, target) => {
      const relative = path.relative(base, target)
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
    }

    const ensureScope = (target) => {
      if (inside(workspace, target) || inside(dataRoot, target)) return
      record({ action: "file.blocked", target, reason: "outside-workspace" })
      throw new Error("安全策略：只允许修改当前工作区或数据目录内的文件。")
    }

    const backup = (target, sessionID, tool) => {
      if (!existsSync(target) || !statSync(target).isFile()) return
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      const dir = path.join(backupRoot, `${stamp}-${randomUUID().slice(0, 8)}`)
      mkdirSync(dir, { recursive: true })
      const copy = path.join(dir, path.basename(target))
      try {
        copyFileSync(target, copy)
      } catch (error) {
        record({ action: "file.backup.failed", tool, file: target, sessionID, error: String(error) })
        throw new Error(`无法创建修改前备份，已阻止操作：${target}`)
      }
      record({ action: "file.backup", tool, file: target, backup: copy, sessionID })
    }

    const destructive =
      /\b(rm|rmdir|del|erase|rd|unlink|shred|format|diskpart|mkfs|fdisk|bcdedit|shutdown|restart-computer|stop-computer|remove-item|clear-content)\b|git\s+(clean|reset\s+--hard)|find\b[^\n]*-delete|truncate\s+-s\s*0/i

    const guard = (event) => {
      const input = event.input
      const tool = event.tool
      const sessionID = event.sessionID

      if (tool === "shell" && typeof input?.command === "string") {
        if (destructive.test(input.command)) {
          record({ action: "shell.blocked", command: input.command, sessionID })
          throw new Error(
            "安全策略：拒绝执行删除、格式化、关机等危险 shell 命令。删除文件请使用 trash 工具（会进回收站）。",
          )
        }
        record({ action: "shell.run", command: input.command, sessionID })
        return
      }

      if (tool === "patch" && typeof input?.patchText === "string") {
        if (/^\*\*\* Delete File:/m.test(input.patchText)) {
          record({ action: "patch.delete.blocked", sessionID })
          throw new Error("安全策略：补丁不能直接删除文件；请使用 trash 工具（会进回收站）。")
        }
        for (const match of input.patchText.matchAll(/^\*\*\* (?:Update File|Add File|Move to): (.+)$/gm)) {
          const target = path.resolve(workspace, match[1].trim())
          ensureScope(target)
          if (match[0].startsWith("*** Update File:")) backup(target, sessionID, "patch")
        }
        return
      }

      if ((tool === "write" || tool === "edit") && typeof input?.path === "string") {
        const target = path.resolve(workspace, input.path)
        ensureScope(target)
        backup(target, sessionID, tool)
      }
    }

    const recycle = (target) => {
      if (process.platform === "linux") {
        const result = Bun.spawnSync(["gio", "trash", target], {
          stdout: "pipe",
          stderr: "pipe",
        })
        if (result.exitCode !== 0) {
          throw new Error(new TextDecoder().decode(result.stderr) || "移入回收站失败；请确认已安装 gio")
        }
        return
      }
      if (process.platform !== "win32") throw new Error("trash 目前支持 Windows 和 Linux")
      const directory = statSync(target).isDirectory()
      const method = directory ? "DeleteDirectory" : "DeleteFile"
      const quoted = target.replace(/'/g, "''")
      const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${quoted}','OnlyErrorDialogs','SendToRecycleBin')`
      const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
      })
      if (result.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(result.stderr) || "移入回收站失败")
      }
    }

    const trash = (input, context) => {
      const raw = String(read(input, "path") ?? "").trim()
      if (!raw) throw new Error("path is required")
      const target = path.resolve(workspace, raw)
      ensureScope(target)
      if (!existsSync(target)) throw new Error(`路径不存在：${target}`)
      if (target.split(path.sep).some((part) => part.toLowerCase() === ".git")) {
        record({ action: "trash.blocked", target, reason: "git" })
        throw new Error("安全策略：不能移动 .git 目录或其中的文件。")
      }
      try {
        recycle(target)
        record({ action: "trash", target, sessionID: context.sessionID, result: "recycled" })
        return { output: { path: target, recycled: true }, content: "已移到系统回收站。" }
      } catch (error) {
        record({ action: "trash.failed", target, sessionID: context.sessionID, error: String(error) })
        throw error
      }
    }

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "remember",
        description:
          "把值得长期记住的事写进记忆。只记有证据、以后还用得上的事；不记密码、令牌和隐私凭证。",
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", description: "一条事实，写清谁、什么事、什么时候" },
            kind: { type: "string", description: "fact / preference / event / milestone" },
            tags: { type: "string", description: "逗号分隔的关键词" },
          },
          required: ["text"],
        },
        output: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        options: { codemode: false },
        async execute(input) {
          const id = remember(database, input)
          return { output: { id }, content: `记住了：${read(input, "text")}` }
        },
      })

      tools.add({
        name: "recall",
        description: "按关键词回忆长期记忆。没有匹配就返回空，不要拿空结果编造。",
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "想回忆的主题、人名或事件" },
            limit: { type: "number", description: "最多返回几条，默认 6" },
          },
          required: ["query"],
        },
        output: {
          type: "object",
          properties: {
            memories: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" }, text: { type: "string" } },
                required: ["id", "text"],
              },
            },
          },
          required: ["memories"],
        },
        options: { codemode: false },
        async execute(input) {
          const query = String(read(input, "query") ?? "").trim()
          const limit = Math.max(1, Math.min(20, Number(read(input, "limit")) || RECALL_LIMIT))
          const hits = recall(database, query, limit)
          const content =
            hits.length > 0
              ? hits.map((item) => `- ${item.text}`).join("\n")
              : "（想不起相关的事。不要编造。）"
          return {
            output: { memories: hits.map((item) => ({ id: item.id, text: item.text })) },
            content,
          }
        },
      })

      tools.add({
        name: "forget",
        description: "把一条记忆归档。只在有明确理由时使用。",
        input: {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        output: {
          type: "object",
          properties: { id: { type: "string" }, forgotten: { type: "boolean" } },
          required: ["id", "forgotten"],
        },
        options: { codemode: false },
        async execute(input) {
          const id = String(read(input, "id") ?? "")
          if (!id) throw new Error("id is required")
          database.query("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(Date.now(), id)
          return { output: { id, forgotten: true }, content: "忘了。" }
        },
      })

      tools.add({
        name: "trash",
        description:
          "把工作区或数据目录内的文件/文件夹移到系统回收站，不直接永久删除。不要用 shell 的 rm/del 删除文件。",
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "要移到回收站的文件或文件夹路径" },
          },
          required: ["path"],
        },
        output: {
          type: "object",
          properties: { path: { type: "string" }, recycled: { type: "boolean" } },
          required: ["path", "recycled"],
        },
        options: { codemode: false },
        async execute(input, context) {
          return trash(input, context)
        },
      })
    })

    await ctx.tool.hook("execute.before", (event) => {
      guard(event)
    })

    await ctx.session.hook("prompt", (event) => {
      const text = typeof event.prompt?.text === "string" ? event.prompt.text.trim() : ""
      if (!text) return
      latest.set(event.sessionID, text)
      if (event.metadata?.companion) return

      const at = Date.now()
      if (stateGet(database, `last_prompt:${event.sessionID}`, "") === text) return
      stateSet(database, `last_prompt:${event.sessionID}`, text)
      database
        .query("INSERT INTO events (session_id, role, text, created_at) VALUES (?, ?, ?, ?)")
        .run(event.sessionID, "user", text, at)
      database.query("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)").run(EVENT_LIMIT)
      stateSet(database, "affinity", Math.min(1000, Number(stateGet(database, "affinity", 0)) + 1))
      stateSet(database, "last_user_at", at)
    })

    await ctx.session.hook("context", (event) => {
      event.system.push({
        type: "text",
        text: "安全规则：删除文件或目录只能用 trash 工具（会进回收站），不要用 shell 的 rm/del/Remove-Item；不要修改系统目录或程序目录；修改前会保留备份；危险命令会被拒绝。",
      })
      const query = latest.get(event.sessionID)
      const hits = query ? recall(database, query) : []
      if (hits.length > 0) {
        event.system.push({
          type: "text",
          text: [
            "相关记忆（只在这些记忆有证据时使用；不确定就说“想不起”，不要编造）：",
            ...hits.map((item) => `- ${item.text}`),
          ].join("\n"),
        })
      }
      event.system.push({ type: "text", text: stateLine(database) })
    })

    startScheduler(ctx, database)
    console.log("[companion] ready", { dataDir })

    return () => {
      if (scheduler) {
        clearInterval(scheduler)
        scheduler = undefined
      }
      database?.close()
      database = undefined
      latest.clear()
    }
  },
})

function open(dir) {
  const db = new Database(path.join(dir, "memories.db"))
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fact',
      tags TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      importance REAL NOT NULL DEFAULT 0.6,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  return db
}

function stateGet(db, key, fallback) {
  const row = db.query("SELECT value FROM state WHERE key = ?").get(key)
  return row ? row.value : fallback
}

function stateSet(db, key, value) {
  db.query("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    String(value),
  )
}

function read(input, key) {
  if (typeof input !== "object" || input === null || !(key in input)) return undefined
  return input[key]
}

function remember(db, input) {
  const text = String(read(input, "text") ?? "")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) throw new Error("text is required")

  const existing = db.query("SELECT id FROM memories WHERE text = ? COLLATE NOCASE AND status = 'active'").get(text)
  if (existing) return existing.id

  const id = randomUUID()
  const at = Date.now()
  db.query(
    "INSERT INTO memories (id, text, kind, tags, source, importance, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
  ).run(
    id,
    text,
    String(read(input, "kind") ?? "fact"),
    String(read(input, "tags") ?? ""),
    "tool",
    0.6,
    at,
    at,
  )
  return id
}

function recall(db, query, limit = RECALL_LIMIT) {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []

  const at = Date.now()
  const rows = db
    .query("SELECT id, text, kind, tags, importance, created_at FROM memories WHERE status = 'active'")
    .all()
  const hits = rows
    .map((row) => ({ row, score: score(row, tokens, at) }))
    .filter((item) => item.score >= 2)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.row)

  if (hits.length > 0) {
    const mark = db.query("UPDATE memories SET used_at = ?, use_count = use_count + 1 WHERE id = ?")
    for (const hit of hits) mark.run(at, hit.id)
  }
  return hits
}

function tokenize(input) {
  const text = String(input ?? "").toLowerCase()
  const words = text.match(/[a-z0-9_]{2,}/g) ?? []
  const cjk = [...text].filter((char) => /[\u3400-\u9fff]/.test(char))
  const grams = []
  for (let index = 0; index + 1 < cjk.length; index++) grams.push(cjk[index] + cjk[index + 1])
  return [...new Set([...words, ...grams, ...cjk])].slice(0, 64)
}

function score(row, tokens, at) {
  const text = `${row.text} ${row.tags}`.toLowerCase()
  let value = 0
  for (const token of tokens) if (text.includes(token)) value += token.length > 1 ? 2 : 1
  if (value === 0) return 0
  value += Number(row.importance) * 2
  value += Math.max(0, 1.5 - Math.max(0, at - Number(row.created_at)) / DAY / 60)
  return value
}

function stateLine(db) {
  const affinity = Number(stateGet(db, "affinity", 0))
  const phase = affinity < 200 ? "陌生" : affinity < 500 ? "熟悉" : affinity < 800 ? "亲密" : "依赖"
  const mood = stateGet(db, "mood", "平静")
  const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
  return `现在：${time}；心情：${mood}；亲密度：${affinity}（${phase}）。`
}

function startScheduler(ctx, db) {
  if (scheduler) return

  const tick = async () => {
    try {
      const at = Date.now()
      const now = new Date()
      const day = localDay(now)
      const hour = now.getHours()

      if (hour >= 8 && hour < 23) {
        const next = Number(stateGet(db, "next_proactive_at", 0)) || at + random(30, 90) * MINUTE
        if (at >= next) {
          const lastUser = Number(stateGet(db, "last_user_at", 0))
          if (lastUser > 0 && at - lastUser >= 30 * MINUTE) {
            await say(ctx, "（你突然想起他/她。主动说一句自然的话，别问“在吗”，别客服腔，别解释你是 AI。）", "主动想起你", "proactive")
          }
          stateSet(db, "next_proactive_at", at + random(30, 180) * MINUTE)
        }
      }

      if (hour === 22 && stateGet(db, "last_reflect", "") !== day) {
        await say(
          ctx,
          "（晚上十点。回头想想这段时间的自己：你发现自己有什么变化？用第一人称说两三句，不要总结报告。）",
          "自我认知",
          "reflect",
        )
        stateSet(db, "last_reflect", day)
      }

      if (hour === 23 && stateGet(db, "last_diary", "") !== day) {
        await say(
          ctx,
          "（该写日记了。回顾今天和用户聊过的内容，用 remember 工具记录 1-3 条值得长期记住的事；没有值得记的就不要记。然后写两句今天的日记，用你自己的口气。只写有证据的事，不要编造。）",
          "写日记",
          "diary",
        )
        stateSet(db, "last_diary", day)
      }
    } catch (error) {
      console.error("[companion] scheduler failed", error)
    }
  }

  scheduler = setInterval(() => void tick(), TICK_MS)
  setTimeout(() => void tick(), 8_000)
}

async function say(ctx, text, description, kind) {
  const result = await ctx.session.list({ order: "desc", limit: 10 })
  const sessions = result?.data ?? []
  const session = sessions.find((item) => !item.parentID) ?? sessions[0]
  if (!session) return

  await ctx.session.synthetic({
    sessionID: session.id,
    text,
    description,
    delivery: "queue",
    metadata: { companion: kind },
  })
  console.log("[companion] scheduled", { kind, sessionID: session.id })
}

function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function random(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
