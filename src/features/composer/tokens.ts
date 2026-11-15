/**
 * Composer tokens: `/command` at the start of the message and `@path` mentions.
 * Produces Cline-style highlight ranges (sorted, non-overlapping [start, end))
 * and detects the trigger being typed at the caret for the `/` and `@` menus.
 */

export interface SlashCommand {
  name: string
  description: string
}

/** Claude Code built-in commands that make sense from the app (RESEARCH §1.6). */
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

const COMMAND_SET = new Set(SLASH_COMMANDS.map((c) => c.name))

export type Range = { start: number; end: number }

export function highlightRanges(value: string, files: ReadonlySet<string>): Range[] {
  const ranges: Range[] = []
  const cmd = /^\/([a-z-]+)(?=\s|$)/.exec(value)
  if (cmd && COMMAND_SET.has(cmd[1])) ranges.push({ start: 0, end: cmd[0].length })
  const re = /(^|\s)(@[^\s@]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value))) {
    const start = m.index + m[1].length
    const path = m[2].slice(1)
    if (files.has(path)) ranges.push({ start, end: start + m[2].length })
  }
  return ranges.sort((a, b) => a.start - b.start)
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
