// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-chat/tool-summary/{index,parsers,paths}.ts (Apache-2.0). Modified for session-dashboard.
// Changes: Claude Code tool names (Read/Edit/Write/Bash/Grep/Glob/Agent/TodoWrite/
// ExitPlanMode/AskUserQuestion/WebFetch/mcp__*) instead of Cline's runtime tools;
// summaries read our ToolCall model as a verb and a target ("Ran `npm test`"), in the tense of
// the call's state; a run of calls reads as Claude Code desktop's "Read 3 files, ran a command".
import type { ToolCall } from "@/lib/model"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Inputs sometimes arrive as JSON strings (archived transcripts); re-parse anything that looks like JSON. */
export function normalizeValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return value
    }
  }
  return value
}

/** Final path segment, tolerant of both slash styles. */
export function displayFileName(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) || filePath
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".py": "python",
  ".go": "go", ".rs": "rust", ".rb": "ruby", ".java": "java", ".css": "css", ".html": "html",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".md": "markdown",
  ".sql": "sql", ".sh": "bash", ".tf": "hcl", ".hcl": "hcl", ".swift": "swift", ".kt": "kotlin",
}

export function detectLanguage(filePath: string): string | undefined {
  const base = displayFileName(filePath).toLowerCase()
  const dot = base.lastIndexOf(".")
  return dot > 0 ? EXT_TO_LANGUAGE[base.slice(dot)] : undefined
}

function collapse(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

export type ToolFamily =
  | "read"
  | "edit"
  | "command"
  | "search"
  | "graph"
  | "web"
  | "agent"
  | "todo"
  | "plan"
  | "question"
  | "mcp"
  | "other"

/** What a call acted on: a file (clickable, shown relative to the session folder), a command or pattern (mono), or words. */
export type ToolTarget = { text: string; kind: "path" | "code" | "text"; path?: string }

export interface ToolSummary {
  family: ToolFamily
  /** "Ran", "Read", "Edited", "Searched for": present tense while it runs, plain while it waits or was denied */
  verb: string
  target?: ToolTarget
  /** muted words after the target ("in src/auth") */
  detail?: string
  diff?: { added: number; removed: number }
  /** trailing muted detail, e.g. "14 matches", "exit 1" */
  meta?: string
  metaTone?: "error" | "ok"
}

export function classifyTool(name: string): ToolFamily {
  if (name === "Read" || name === "NotebookRead" || name === "LS") return "read"
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") return "edit"
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "command"
  if (name === "Grep" || name === "Glob") return "search"
  if (name.startsWith("mcp__graphify__")) return "graph"
  if (name === "WebFetch" || name === "WebSearch") return "web"
  if (name === "Agent" || name === "Task") return "agent"
  if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") return "todo"
  if (name === "ExitPlanMode") return "plan"
  if (name === "AskUserQuestion") return "question"
  if (name.startsWith("mcp__")) return "mcp"
  return "other"
}

/** `mcp__server__tool` → { server, tool } */
export function splitMcpName(name: string) {
  const [, server = "mcp", ...rest] = name.split("__")
  return { server, tool: rest.join("__") || name }
}

function lineCount(text: string | undefined) {
  if (!text) return 0
  return text.split("\n").filter((l) => l.trim().length > 0).length
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

export function inputOf(call: ToolCall): Record<string, unknown> {
  const v = normalizeValue(call.input)
  return (isRecord(v) ? v : {}) as Record<string, unknown>
}

/** [plain, present, past]: "Run" while it waits or was denied, "Running" while it runs, "Ran" once done. */
type Verbs = readonly [string, string, string]
function tense(call: ToolCall, [plain, ing, past]: Verbs) {
  if (call.display === "running") return ing
  if (call.display === "done" || call.display === "failed") return past
  return plain
}

/** A file a call touched, as the session's folder sees it. */
export function relPath(path: string, cwd?: string): string {
  if (cwd && cwd !== "/" && path.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`)) return path.slice(cwd.replace(/\/$/, "").length + 1)
  return path.replace(/^(?:\/home\/[^/]+|\/Users\/[^/]+)(?=\/)/, "~")
}

function webTarget(url: string) {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname.length > 1 ? u.pathname : ""}`
  } catch {
    return url
  }
}

/**
 * Verb and target for one tool call ("Ran `npm test`", "Edited src/auth/retry.ts +7 −3").
 * Never throws: malformed input degrades to the tool's title (Cline's "never throws" contract).
 */
export function buildToolSummary(call: ToolCall): ToolSummary {
  const family = classifyTool(call.name)
  const input = inputOf(call)

  switch (family) {
    case "read": {
      const path = str(input, "file_path") ?? str(input, "notebook_path") ?? str(input, "path") ?? call.locations?.[0]?.path ?? call.title
      const n = lineCount(call.output)
      const verbs: Verbs = call.name === "LS" ? ["List", "Listing", "Listed"] : ["Read", "Reading", "Read"]
      return { family, verb: tense(call, verbs), target: { text: path, kind: "path", path }, meta: n && call.name !== "LS" ? `${n} lines` : undefined }
    }
    case "edit": {
      const path = str(input, "file_path") ?? str(input, "notebook_path") ?? call.diff?.[0]?.path ?? call.title
      const added = call.diff?.reduce((a, d) => a + d.added, 0) ?? 0
      const removed = call.diff?.reduce((a, d) => a + d.removed, 0) ?? 0
      const creates = call.name === "Write" && (call.diff?.[0]?.op ?? "add") === "add"
      return {
        family,
        verb: tense(call, creates ? ["Create", "Creating", "Created"] : ["Edit", "Editing", "Edited"]),
        target: { text: path, kind: "path", path },
        diff: added || removed ? { added, removed } : undefined,
      }
    }
    case "command": {
      if (call.name === "BashOutput") return { family, verb: tense(call, ["Check", "Checking", "Checked"]), target: { text: "background command output", kind: "text" } }
      if (call.name === "KillShell") return { family, verb: tense(call, ["Stop", "Stopping", "Stopped"]), target: { text: "a background command", kind: "text" } }
      const command = collapse(str(input, "command") ?? call.terminal?.command ?? call.title)
      const exit = call.terminal?.exitCode
      return {
        family,
        verb: tense(call, ["Run", "Running", "Ran"]),
        target: { text: command, kind: "code" },
        // a failed call says Failed already; the exit code is in its details
        meta: exit === undefined || exit === 0 || call.display === "failed" ? undefined : `exit ${exit}`,
        metaTone: exit === undefined || exit === 0 ? undefined : "error",
      }
    }
    case "search": {
      const pattern = str(input, "pattern") ?? call.title
      const where = str(input, "path")
      const n = lineCount(call.output)
      const isGlob = call.name === "Glob"
      return {
        family,
        verb: tense(call, isGlob ? ["Find files", "Finding files", "Found files"] : ["Search for", "Searching for", "Searched for"]),
        target: { text: pattern, kind: "code" },
        detail: where && where !== "." ? `in ${relPath(where)}` : undefined,
        meta: call.output !== undefined ? (isGlob ? `${n} ${n === 1 ? "file" : "files"}` : `${n} ${n === 1 ? "match" : "matches"}`) : undefined,
      }
    }
    case "graph": {
      const q = str(input, "query") ?? call.title
      const callers = /(\d+) callers? in (\d+) files?/.exec(call.output ?? "")
      return { family, verb: tense(call, ["Query the code graph for", "Querying the code graph for", "Queried the code graph for"]), target: { text: q, kind: "text" }, meta: callers ? `${callers[1]} callers` : undefined }
    }
    case "web": {
      if (call.name === "WebSearch") {
        const q = str(input, "query") ?? call.title
        return { family, verb: tense(call, ["Search the web for", "Searching the web for", "Searched the web for"]), target: { text: q, kind: "text" } }
      }
      const url = str(input, "url") ?? call.title
      return { family, verb: tense(call, ["Fetch", "Fetching", "Fetched"]), target: { text: webTarget(url), kind: "code" } }
    }
    case "agent": {
      const type = str(input, "subagent_type")
      const desc = str(input, "description") ?? call.title
      return { family, verb: tense(call, ["Run agent", "Running agent", "Ran agent"]), target: { text: desc, kind: "text" }, detail: type && type !== "general-purpose" ? type : undefined }
    }
    case "todo": {
      const todos = Array.isArray(input.todos) ? (input.todos as { status?: string }[]) : []
      const done = todos.filter((t) => t.status === "completed").length
      return { family, verb: tense(call, ["Update the todo list", "Updating the todo list", "Updated the todo list"]), meta: todos.length ? `${done} of ${todos.length} done` : undefined }
    }
    case "plan":
      return { family, verb: call.display === "awaiting_permission" ? "Plan ready for approval" : "Presented a plan" }
    case "question":
      return { family, verb: call.display === "awaiting_permission" ? "Asking you" : "Asked you", target: { text: str(input, "question") ?? firstQuestion(input) ?? call.title, kind: "text" } }
    case "mcp": {
      const { server, tool } = splitMcpName(call.name)
      return { family, verb: tense(call, ["Use", "Using", "Used"]), target: { text: tool.replace(/_/g, " "), kind: "text" }, detail: `· ${server}` }
    }
    default:
      return { family, verb: tense(call, ["Use", "Using", "Used"]), target: { text: call.name, kind: "code" }, detail: call.title && call.title !== call.name ? collapse(call.title) : undefined }
  }
}

function firstQuestion(input: Record<string, unknown>) {
  const qs = Array.isArray(input.questions) ? (input.questions as { question?: unknown }[]) : []
  return typeof qs[0]?.question === "string" ? qs[0].question : undefined
}

/** Duration of a tool call ("4s", "1m 3s"), or undefined while still running. */
export function toolDurationMs(call: ToolCall): number | undefined {
  if (!call.completedAt) return undefined
  return Math.max(0, Date.parse(call.completedAt) - Date.parse(call.startedAt))
}

/** "Worked for 2m 14s" (Cline formatWorkDuration). */
export function formatWorkDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}

// ---------- work summaries (Claude Code desktop: "Read retry.ts and ran 2 commands") ----------
type Part = { one: (name: string) => string; many: (n: number) => string; names: Set<string>; calls: number; unique: boolean }

/**
 * One line for a run of tool calls, in the past tense and in the order the work happened, worded as
 * Claude Code desktop: "Ran 4 commands", "Read retry.ts and ran a command", "Read 3 files, edited
 * 2 files and ran a command", "Read 3 files, edited a file, ran 2 commands, and 3 more steps".
 */
export function summarizeWork(calls: readonly ToolCall[]): string {
  const parts = new Map<string, Part>()
  let todo = false
  const count = (key: string, one: (name: string) => string, many: (n: number) => string, unique?: string) => {
    let p = parts.get(key)
    if (!p) parts.set(key, (p = { one, many, names: new Set(), calls: 0, unique: unique !== undefined }))
    p.calls++
    if (unique !== undefined) p.names.add(unique)
  }
  for (const c of calls) {
    const input = inputOf(c)
    const file = String(input.file_path ?? input.notebook_path ?? input.path ?? c.title)
    switch (classifyTool(c.name)) {
      case "edit":
        if (c.name === "Write" && (c.diff?.[0]?.op ?? "add") === "add") count("create", (f) => `created ${f}`, (n) => `created ${n} files`, file)
        else count("edit", (f) => `edited ${f}`, (n) => `edited ${n} files`, file)
        break
      case "read":
        count("read", (f) => `read ${f}`, (n) => `read ${n} files`, file)
        break
      case "command":
        if (c.name === "Bash") count("cmd", () => "ran a command", (n) => `ran ${n} commands`)
        else count("tool", () => "used a tool", (n) => `used ${n} tools`)
        break
      case "search":
      case "graph":
        count("search", () => "searched for a pattern", (n) => `searched for ${n} patterns`)
        break
      case "web":
        if (c.name === "WebSearch") count("websearch", () => "searched the web", (n) => `searched the web ${n} times`)
        else count("fetch", () => "fetched a page", (n) => `fetched ${n} pages`)
        break
      case "agent":
        count("agent", () => "ran an agent", (n) => `ran ${n} agents`)
        break
      case "todo":
        // bookkeeping: named only when it is all the run did (the plan itself shows above the prompt box)
        todo = true
        break
      default:
        count("tool", () => "used a tool", (n) => `used ${n} tools`)
    }
  }
  const list = [...parts.values()]
  const words = list.slice(0, 3).map((p) => {
    const n = p.unique ? p.names.size : p.calls
    return n === 1 ? p.one(displayFileName([...p.names][0] ?? "")) : p.many(n)
  })
  const rest = list.slice(3).reduce((a, p) => a + p.calls, 0)
  const line = !words.length
    ? todo
      ? "Updated the todo list"
      : "Worked"
    : rest
      ? `${words.join(", ")}, and ${rest} more ${rest === 1 ? "step" : "steps"}`
      : words.length === 1
        ? words[0]
        : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/** What a running tool call is doing, in the present tense: "Running npm test", "Editing retry.ts". */
export function describeActivity(call: ToolCall | undefined): string {
  if (!call) return "Working"
  if (call.display === "awaiting_permission") return classifyTool(call.name) === "question" ? "Waiting for your answer" : "Waiting for your approval"
  const s = buildToolSummary({ ...call, display: "running" })
  const t = s.target
  if (!t) return s.verb
  const text = t.kind === "path" ? displayFileName(t.text) : t.text.length > 60 ? `${t.text.slice(0, 59)}…` : t.text
  return `${s.verb} ${text}`
}
