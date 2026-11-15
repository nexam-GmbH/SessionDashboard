// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-chat/tool-summary/{index,parsers,paths}.ts (Apache-2.0). Modified for session-dashboard.
// Changes: Claude Code tool names (Read/Edit/Write/Bash/Grep/Glob/Agent/TodoWrite/
// ExitPlanMode/AskUserQuestion/WebFetch/mcp__*) instead of Cline's runtime tools;
// summaries read our ToolCall model; label parts keep Cline's prose/code split.
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

/** Shorten a long path to `.../parent/file`, keeping as many trailing dirs as fit. */
export function shortenPath(filePath: string, maxLen = 48): string {
  if (filePath.length <= maxLen) return filePath
  const parts = filePath.split(/[\\/]/)
  const fileName = parts.pop() ?? ""
  if (fileName.length >= maxLen - 4) return `…/${fileName}`
  let result = fileName
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = `${parts[i]}/${result}`
    if (candidate.length + 2 > maxLen) break
    result = candidate
  }
  return `…/${result}`
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

/** One styled segment of a row label; `code` segments render monospace. */
export type ToolLabelPart = { text: string; code?: boolean; muted?: boolean }

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

export interface ToolSummary {
  family: ToolFamily
  /** Short verb-ish tool label shown in the name column ("Read", "Bash", "graphify"). */
  name: string
  /** One-line summary after the name. */
  parts: ToolLabelPart[]
  diff?: { added: number; removed: number }
  /** Trailing muted detail, e.g. "14 matches", "exit 1". */
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

/**
 * Build the one-line presentation for a tool call. Never throws: malformed
 * input degrades to the tool's title (Cline's "never throws" contract).
 */
export function buildToolSummary(call: ToolCall): ToolSummary {
  const family = classifyTool(call.name)
  const input = (isRecord(normalizeValue(call.input)) ? normalizeValue(call.input) : {}) as Record<string, unknown>
  const failed = call.status === "failed"

  switch (family) {
    case "read": {
      const path = str(input, "file_path") ?? call.locations?.[0]?.path ?? call.title
      const n = lineCount(call.output)
      return {
        family,
        name: "Read",
        parts: [{ text: shortenPath(path), code: true }],
        meta: n ? `${n} lines` : undefined,
      }
    }
    case "edit": {
      const path = str(input, "file_path") ?? call.diff?.[0]?.path ?? call.title
      const added = call.diff?.reduce((a, d) => a + d.added, 0) ?? 0
      const removed = call.diff?.reduce((a, d) => a + d.removed, 0) ?? 0
      return {
        family,
        name: call.name === "Write" ? "Write" : "Edit",
        parts: [{ text: shortenPath(path), code: true }],
        diff: added || removed ? { added, removed } : undefined,
      }
    }
    case "command": {
      const command = collapse(str(input, "command") ?? call.terminal?.command ?? call.title)
      const exit = call.terminal?.exitCode
      return {
        family,
        name: "Bash",
        parts: [{ text: command, code: true }],
        meta: exit === undefined ? undefined : `exit ${exit}`,
        metaTone: exit === undefined ? undefined : exit === 0 ? "ok" : "error",
      }
    }
    case "search": {
      const pattern = str(input, "pattern") ?? call.title
      const n = lineCount(call.output)
      const isGlob = call.name === "Glob"
      return {
        family,
        name: call.name,
        parts: [{ text: isGlob ? pattern : `"${pattern}"`, code: true }, ...(str(input, "path") && str(input, "path") !== "." ? [{ text: ` in ${str(input, "path")}`, muted: true }] : [])],
        meta: call.output !== undefined ? (isGlob ? `${n} ${n === 1 ? "file" : "files"}` : `${n} ${n === 1 ? "match" : "matches"}`) : undefined,
      }
    }
    case "graph": {
      const { tool } = splitMcpName(call.name)
      const q = str(input, "query") ?? call.title
      const callers = /(\d+) callers? in (\d+) files?/.exec(call.output ?? "")
      return {
        family,
        name: "graphify",
        parts: [{ text: tool.replace(/_/g, " "), muted: true }, { text: " " }, { text: q, code: false }],
        meta: callers ? `${callers[1]} callers` : undefined,
      }
    }
    case "web": {
      const url = str(input, "url") ?? str(input, "query") ?? call.title
      let host = url
      try {
        const u = new URL(url)
        host = `${u.hostname}${u.pathname.length > 1 ? u.pathname : ""}`
      } catch {
        /* not a url (WebSearch query) */
      }
      return { family, name: call.name === "WebSearch" ? "Search" : "Fetch", parts: [{ text: host, code: true }] }
    }
    case "agent": {
      const type = str(input, "subagent_type") ?? "agent"
      const desc = str(input, "description") ?? call.title
      return { family, name: "Agent", parts: [{ text: type, muted: true }, { text: ` ${desc}` }] }
    }
    case "todo": {
      const todos = Array.isArray(input.todos) ? (input.todos as { status?: string }[]) : []
      const done = todos.filter((t) => t.status === "completed").length
      return { family, name: "Plan", parts: [{ text: todos.length ? `Updated plan` : call.title }], meta: todos.length ? `${done}/${todos.length}` : undefined }
    }
    case "plan":
      return { family, name: "Plan", parts: [{ text: call.display === "awaiting_permission" ? "Plan ready for approval" : "Presented plan" }] }
    case "question":
      return { family, name: "Ask", parts: [{ text: call.title }] }
    case "mcp": {
      const { server, tool } = splitMcpName(call.name)
      return { family, name: server, parts: [{ text: tool, code: true }] }
    }
    default:
      return { family, name: call.name, parts: [{ text: call.title }], meta: failed ? "failed" : undefined }
  }
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

/** First and last N lines of long output, with the hidden count (Cline agent-command-output idea). */
export function headTail(text: string, head = 6, tail = 6) {
  const lines = text.replace(/\n$/, "").split("\n")
  if (lines.length <= head + tail + 2) return { head: lines, hidden: 0, tail: [] as string[], total: lines.length }
  return { head: lines.slice(0, head), hidden: lines.length - head - tail, tail: lines.slice(-tail), total: lines.length }
}

// ---------- work summaries (Claude Code desktop: "Edited 2 files, ran a command +362 −99") ----------
const plainName = (p: unknown) => (typeof p === "string" && p ? displayFileName(p) : undefined)

/**
 * One line for a group of tool calls, in the past tense: "Edited 2 files, ran a command",
 * "Updated FreelancersPage.tsx", "Read 3 files, searched the code". At most three parts.
 */
export function summarizeWork(calls: readonly ToolCall[]): string {
  const edits = new Set<string>()
  const reads = new Set<string>()
  const servers = new Set<string>()
  let commands = 0
  let searches = 0
  let web = 0
  let agents = 0
  let plan = false
  let editCalls = 0
  const other = new Set<string>()
  for (const c of calls) {
    const input = (isRecord(c.input) ? c.input : {}) as Record<string, unknown>
    switch (classifyTool(c.name)) {
      case "edit":
        editCalls++
        edits.add(String(input.file_path ?? input.notebook_path ?? c.title))
        break
      case "read":
        reads.add(String(input.file_path ?? input.path ?? c.title))
        break
      case "command":
        if (c.name === "Bash") commands++
        break
      case "search":
      case "graph":
        searches++
        break
      case "web":
        web++
        break
      case "agent":
        agents++
        break
      case "mcp":
        servers.add(splitMcpName(c.name).server)
        break
      case "todo":
        plan = true
        break
      case "plan":
      case "question":
        break
      default:
        other.add(c.name)
    }
  }
  const parts: string[] = []
  // a single file and nothing else: "Updated Foo.tsx"; with other work: "edited Foo.tsx, ran a command"
  const onlyEdits = editCalls === calls.length
  if (edits.size) parts.push(edits.size === 1 ? `${onlyEdits ? "updated" : "edited"} ${plainName([...edits][0]) ?? "a file"}` : `edited ${edits.size} files`)
  if (commands) parts.push(commands === 1 ? "ran a command" : `ran ${commands} commands`)
  if (reads.size) parts.push(reads.size === 1 ? `read ${plainName([...reads][0]) ?? "a file"}` : `read ${reads.size} files`)
  if (searches) parts.push("searched the code")
  if (web) parts.push(web === 1 ? "looked something up" : "searched the web")
  if (agents) parts.push(agents === 1 ? "ran a subagent" : `ran ${agents} subagents`)
  if (servers.size) parts.push(`used ${[...servers].slice(0, 2).join(", ")}`)
  if (plan && parts.length < 3) parts.push("updated the plan")
  if (other.size && parts.length < 3) parts.push(`used ${[...other][0]}`)
  const line = parts.slice(0, 3).join(", ") || "Worked"
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/** What a running tool call is doing, in the present tense: "Running a command", "Editing Foo.tsx". */
export function describeActivity(call: ToolCall | undefined): string {
  if (!call) return "Working"
  const input = (isRecord(call.input) ? call.input : {}) as Record<string, unknown>
  switch (classifyTool(call.name)) {
    case "edit":
      return call.name === "Write" ? `Creating ${plainName(input.file_path) ?? "a file"}` : `Editing ${plainName(input.file_path ?? input.notebook_path) ?? "a file"}`
    case "read":
      return `Reading ${plainName(input.file_path ?? input.path) ?? "files"}`
    case "command":
      return "Running a command"
    case "search":
    case "graph":
      return "Searching the code"
    case "web":
      return "Searching the web"
    case "agent":
      return "Running a subagent"
    case "mcp":
      return `Using ${splitMcpName(call.name).server}`
    case "todo":
      return "Planning"
    case "question":
      return "Asking you"
    default:
      return `Using ${call.name}`
  }
}
