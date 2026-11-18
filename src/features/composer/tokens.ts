/**
 * Composer tokens: `/command` at the start of the message and `@path` mentions (painted as chips),
 * the rainbow "ultrathink", and the trigger being typed at the caret for the `/` and `@` menus.
 */

export interface SlashCommand {
  name: string
  description: string
}

/** Claude Code built-in commands that make sense from the app. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Summarize the conversation to free context" },
  { name: "review", description: "Review the changes on this branch" },
  { name: "context", description: "Show what fills the context window" },
  { name: "model", description: "Switch the model for this session" },
  { name: "clear", description: "Start over with an empty context" },
  { name: "cost", description: "Token usage and cost so far" },
  { name: "init", description: "Write a CLAUDE.md for this repository" },
  { name: "memory", description: "Edit CLAUDE.md memory files" },
  { name: "agents", description: "Manage subagent definitions" },
  { name: "permissions", description: "View and edit allow/deny rules" },
  { name: "mcp", description: "MCP servers and their status" },
  { name: "help", description: "List all commands" },
]

/** Argument hints of Claude Code's built-ins, shown greyed after a picked command (Claude Code desktop). */
export const ARG_HINTS: Record<string, string> = {
  review: "[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>]",
  compact: "<optional custom summarization instructions>",
  debug: "[issue description]",
  simplify: "[<target>]",
  effort: "[low|medium|high|xhigh|max|ultracode]",
}

export type Range = { start: number; end: number }
/** What the box paints over its text: a picked command or file as a blue chip, or the rainbow "ultrathink". */
export type Mark = Range & { kind: "chip" | "rainbow" }

/** `/command` at the start (a known one) and `@path` mentions of the repo's files: chips. */
export function chipRanges(value: string, files: ReadonlySet<string>, commands: ReadonlySet<string>): Mark[] {
  const marks: Mark[] = []
  const cmd = /^\/([\w:.-]+)(?=\s|$)/.exec(value)
  if (cmd && commands.has(cmd[1])) marks.push({ start: 0, end: cmd[0].length, kind: "chip" })
  for (const m of value.matchAll(/(^|\s)(@[^\s@]+)/g)) {
    const start = m.index + m[1].length
    if (files.has(m[2].slice(1))) marks.push({ start, end: start + m[2].length, kind: "chip" })
  }
  return marks
}

/**
 * "ultrathink" asks for deeper reasoning: up to 10, whole words, not in a message over 20,000
 * characters or one that starts with "/", not quoted or bracketed, not touching "/", "\" or "-", not
 * followed by "?" or by "." and a letter (Claude Code desktop's rules).
 */
export function thinkRanges(value: string, chips: Range[]): Mark[] {
  if (value.length > 20_000 || /^\**\//.test(value)) return []
  const out: Mark[] = []
  for (const m of value.matchAll(/(?<![\w/\\"'`“‘([{<-])ultrathink(?![\w/\\"'`”’)\]}>?-]|\.[\p{L}\d])/giu)) {
    const r = { start: m.index, end: m.index + m[0].length }
    if (chips.some((c) => c.start < r.end && r.start < c.end)) continue
    out.push({ ...r, kind: "rainbow" })
    if (out.length === 10) break
  }
  return out
}

/** Where the fuzzy match of `query` falls in `text` (for the menus' semibold letters). */
export function matchIndices(query: string, text: string): Set<number> {
  const out = new Set<number>()
  if (!query) return out
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at >= 0) {
    for (let i = 0; i < q.length; i++) out.add(at + i)
    return out
  }
  let ti = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return new Set()
    out.add(found)
    ti = found + 1
  }
  return out
}

export type Trigger = { kind: "slash" | "mention"; query: string; start: number; end: number }

/** The `/` or `@` token under the caret, if any. */
export function triggerAt(value: string, caret: number): Trigger | null {
  let i = caret - 1
  while (i >= 0 && !/\s/.test(value[i])) i--
  const start = i + 1
  const word = value.slice(start, caret)
  if (word.startsWith("/") && start === 0 && !/\s/.test(value.slice(0, caret))) {
    return { kind: "slash", query: word.slice(1), start, end: caret }
  }
  if (word.startsWith("@")) return { kind: "mention", query: word.slice(1), start, end: caret }
  return null
}

/** Cheap subsequence fuzzy score (higher is better, -1 = no match). */
export function fuzzy(query: string, text: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx >= 0) return 1000 - idx - (t.length - q.length) * 0.1 + (t.lastIndexOf("/") < idx ? 200 : 0)
  let ti = 0
  let score = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return -1
    score += found === ti ? 3 : 1
    ti = found + 1
  }
  return score
}
