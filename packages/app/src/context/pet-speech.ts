/**
 * Turns an event into the single line the desktop pet says out loud.
 *
 * The pet stands in for a person, so what it says has to be a sentence rather
 * than a notification: "打包完了，桌面快捷方式也建好了" reads like a colleague
 * reporting back, while "回复已就绪 / Quick greeting check-in" reads like two
 * labels stacked in a bubble.
 *
 * When the model already wrote a closing line, that line IS the sentence: it is
 * in the user's language, in the user's own context, and it says what actually
 * happened. Templates are only the fallback for events that carry no prose of
 * their own (a permission prompt, a provider error).
 */

/** Locales only need to translate the keys listed here; everything else reuses the reply text. */
export type SpeechKey =
  | "notification.speech.done"
  | "notification.speech.doneUnknown"
  | "notification.speech.error"
  | "notification.speech.errorUnknown"
  | "notification.speech.permission"
  | "notification.speech.permissionBare"
  | "notification.speech.question"
  | "notification.speech.questionBare"
  /** Reused as the "no reason given" tail for an error. */
  | "notification.session.error.fallbackDescription"

export type SpeechTranslate = (key: SpeechKey, params?: Record<string, string>) => string

export type SpeechTone = "done" | "error" | "info"

const SENTENCE_END = /[。！？!?]/
/** A line this short feels like a fragment; one longer than this stops being readable at a glance. */
const WANTED_CHARS = 22
const MAX_CHARS = 56
const TASK_CHARS = 40

const LANGUAGE_NEUTRAL_TASK = /^(new|child) session - \d{4}-/i

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

/** A line that already closes itself needs no glue added when lines are joined. */
const CLOSED = /[。！？!?…：:，,；;、）)】」』”"]$/
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/

function stripLine(line: string) {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/[*_~]{1,2}/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Joins two fragments the way the language would: Chinese runs together, Latin needs a space. */
function glue(left: string, right: string) {
  if (!left) return right
  if (!right) return left
  return CJK.test(left.slice(-1)) || CJK.test(right.slice(0, 1)) ? `${left}${right}` : `${left} ${right}`
}

/** Strips the markdown chrome a chat reply uses, keeping only what reads well out loud. */
export function plainReply(text: string) {
  const lines = text.replace(/```[\s\S]*?```/g, "\n").split(/\r?\n/)
  const kept: string[] = []
  for (const raw of lines) {
    // Table rows read as noise out loud, and a fenced block is not prose at all.
    if (/^\s*\|.*\|\s*$/.test(raw)) continue
    const line = stripLine(raw)
    if (!line) continue
    // Bullets arrive without punctuation; without a comma the list turns into one run-on sentence.
    kept.push(CLOSED.test(line) ? line : `${line}，`)
  }
  const joined = kept.reduce((all, line) => glue(all, line), "").trim()
  // Nothing follows the last line, so a trailing comma there is just a typo.
  return joined.replace(/[，,]$/, "")
}

function cut(text: string) {
  const match = SENTENCE_END.exec(text)
  if (!match) return { head: text.trim(), rest: "" }
  let end = match.index + 1
  // Keep the closing quote that belongs to the sentence we just cut.
  while (end < text.length && /[”"』」）)]/.test(text[end] ?? "")) end += 1
  return { head: text.slice(0, end).trim(), rest: text.slice(end).trim() }
}

function clamp(text: string) {
  if (text.length <= MAX_CHARS) return text
  return `${text.slice(0, MAX_CHARS - 1).trimEnd()}…`
}

/**
 * First sentence or two of a reply: enough to know what happened, short enough
 * to read in a bubble above a whale.
 */
export function summarizeReply(text: string | null | undefined) {
  if (!text) return null
  const plain = plainReply(text)
  if (!plain) return null
  const parts: string[] = []
  let rest = plain
  while (rest && parts.length < 2 && parts.join("").length < WANTED_CHARS) {
    const { head, rest: next } = cut(rest)
    if (!head) break
    parts.push(head)
    rest = next
  }
  const line = parts.reduce((all, part) => glue(all, part), "").trim()
  return line ? clamp(line) : null
}

/** A session title is a usable task name only when it names something. */
export function taskName(title: string | null | undefined) {
  const value = typeof title === "string" ? title.trim() : ""
  if (!value) return null
  if (LANGUAGE_NEUTRAL_TASK.test(value)) return null
  return value.length > TASK_CHARS ? `${value.slice(0, TASK_CHARS - 1)}…` : value
}

/**
 * The last thing the model said in a session, read straight out of the sync
 * store. Typed loosely on purpose: this runs in the notification path, where a
 * shape change should degrade to "no summary", not to a thrown error.
 */
export function lastReplyText(source: unknown, sessionID?: string | null) {
  if (!sessionID) return null
  const data = record(record(source)?.data)
  const messages = record(data?.message)?.[sessionID]
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index])
    if (!message || message.role !== "assistant") continue
    const id = typeof message.id === "string" ? message.id : null
    const parts = id ? record(data?.part)?.[id] : undefined
    if (!Array.isArray(parts)) continue
    const text = parts
      .map(record)
      // Synthetic text is the harness talking, not the model.
      .filter((part) => part && part.type === "text" && part.synthetic !== true)
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim()
    if (text) return text
  }
  return null
}

/**
 * Server errors nest their human message a level or two down, and sometimes
 * there is none at all. Either way the pet needs something to say.
 */
export function errorReason(error: unknown, fallback: string) {
  if (typeof error === "string") return error.trim() || fallback
  const item = record(error)
  const data = record(item?.data)
  const message = item?.message ?? data?.message
  return typeof message === "string" && message.trim() ? message.trim() : fallback
}

/** What the agent is asking to run, e.g. "bash pnpm install". */
export function permissionAction(properties: unknown) {
  const item = record(properties)
  const action = typeof item?.permission === "string" ? item.permission.trim() : ""
  const patterns = Array.isArray(item?.patterns) ? item.patterns : []
  const target = typeof patterns[0] === "string" ? patterns[0].trim() : ""
  return [action, target].filter(Boolean).join(" ").slice(0, 80)
}

/** The headline of a question the agent is waiting on. */
export function questionPrompt(properties: unknown) {
  const item = record(properties)
  const questions = Array.isArray(item?.questions) ? item.questions : []
  const first = record(questions[0])
  const text =
    (typeof first?.header === "string" && first.header.trim()) ||
    (typeof first?.question === "string" && first.question.trim()) ||
    ""
  return typeof text === "string" ? text.slice(0, 80) : ""
}

/** One line, in the user's language, for whatever just happened. */
export function petSpeech(input: {
  kind: "done" | "error" | "permission" | "question"
  /** Last assistant prose, already fetched with {@link lastReplyText}. */
  reply?: string | null
  /** Session title, for events that have nothing better to name the work with. */
  task?: string | null
  /** Tool action / error reason / question header. */
  detail?: string | null
  t: SpeechTranslate
}) {
  const task = taskName(input.task)
  const detail = typeof input.detail === "string" ? input.detail.trim() : ""
  const { t } = input
  // Collapses the space an English template adds after a task that already ends
  // in one, so "Quick check-in  is done" never reaches the bubble.
  const tidy = (line: string) => line.replace(/\s+/g, " ").trim()

  if (input.kind === "done") {
    const said = summarizeReply(input.reply)
    if (said) return said
    if (!task) return tidy(t("notification.speech.doneUnknown"))
    // A Latin task name needs a space before a Chinese verb; a Chinese one does not.
    const label = /[A-Za-z0-9)\]}]$/.test(task) ? `${task} ` : task
    return tidy(t("notification.speech.done", { task: label }))
  }

  if (input.kind === "error") {
    const reason = detail || t("notification.session.error.fallbackDescription")
    if (!task) return tidy(t("notification.speech.errorUnknown", { reason }))
    return tidy(t("notification.speech.error", { task, reason }))
  }

  if (input.kind === "permission") {
    return tidy(detail ? t("notification.speech.permission", { detail }) : t("notification.speech.permissionBare"))
  }

  return tidy(detail ? t("notification.speech.question", { detail }) : t("notification.speech.questionBare"))
}

export function speechTone(kind: "done" | "error" | "permission" | "question"): SpeechTone {
  if (kind === "done") return "done"
  if (kind === "error") return "error"
  return "info"
}
