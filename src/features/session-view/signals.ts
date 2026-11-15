// Two signals read from a session's transcript:
// - verification: did a test, build or check run after the last edit, and did it pass? Code changed
//   after its last check is the code that ships broken.
// - stuck: the same step failing again and again. Agents that repeat a failing call rarely recover
//   by themselves; a nudge to step back and re-plan does better than a fourth attempt.
import type { ID, ToolCall, Transcript } from "@/lib/model"
import { useApp } from "@/store/app"

const RUNNER =
  /^(?:(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|tests|lint|typecheck|type-check|check\S*|build|verify|e2e)\b|(?:npx|bunx|pnpx)\s+(?:vitest|jest|playwright|tsc|eslint|biome|mocha)\b|bun\s+test\b|cargo\s+(?:test|nextest|check|clippy|build)\b|go\s+(?:test|vet|build)\b|(?:python3?\s+-m\s+)?(?:pytest|mypy|ruff|pyright|unittest)\b|tox\b|tsc\b|eslint\b|vitest\b|jest\b|playwright\s+test\b|make\s+(?:test|check|lint|build)\b|(?:\.\/)?gradlew?\s+(?:\S+\s+)*(?:test|check|build)\b|mvn\s+(?:\S+\s+)*(?:test|verify)\b|dotnet\s+(?:test|build)\b|swift\s+(?:test|build)\b|ctest\b|rspec\b|phpunit\b|mix\s+test\b)/

/** A test, type check, lint or build: one segment of the command starts with a known runner. */
export function isCheck(command: string) {
  return command
    .split(/&&|\|\||;|\n/)
    .map((x) => x.trim().replace(/^(?:\w+=\S+\s+)+/, "").replace(/^(?:timeout\s+\d+\S*\s+)/, ""))
    .some((x) => RUNNER.test(x))
}

const failed = (c: ToolCall) => c.status === "failed" || c.display === "failed" || (c.terminal?.exitCode ?? 0) !== 0
const edits = (c: ToolCall) => (c.kind === "edit" || c.kind === "delete" || c.kind === "move" || !!c.diff?.length) && c.status === "completed"
const commandOf = (c: ToolCall) => c.terminal?.command ?? (typeof c.input.command === "string" ? c.input.command : "")

export type Verification =
  | { state: "none" }
  | { state: "unchecked"; edits: number }
  | { state: "running" | "passed" | "failed"; command: string; at: string }
  | { state: "stale"; command: string; at: string; passed: boolean; edits: number }

export function verification(t: Transcript): Verification {
  let editsAfter = 0
  let anyEdit = false
  for (let i = t.order.length - 1; i >= 0; i--) {
    const it = t.items[t.order[i]]
    if (it?.type !== "tool_call") continue
    const c = it.call
    if (edits(c)) {
      editsAfter++
      anyEdit = true
      continue
    }
    if (c.kind !== "execute" && c.name !== "Bash") continue
    const command = commandOf(c)
    if (!command || !isCheck(command)) continue
    const at = c.completedAt ?? c.startedAt
    if (editsAfter) return { state: "stale", command, at, passed: !failed(c), edits: editsAfter }
    if (c.status === "in_progress" || c.status === "pending") return { state: "running", command, at }
    return { state: failed(c) ? "failed" : "passed", command, at }
  }
  return anyEdit ? { state: "unchecked", edits: editsAfter } : { state: "none" }
}

const vCache = new Map<ID, { order: ID[]; items: Transcript["items"]; value: Verification }>()
export function useVerification(sessionId: ID): Verification | null {
  return useApp((s) => {
    const t = s.transcripts[sessionId]
    if (!t) return null
    const hit = vCache.get(sessionId)
    if (hit && hit.order === t.order && hit.items === t.items) return hit.value
    const value = verification(t)
    vCache.set(sessionId, { order: t.order, items: t.items, value })
    return value
  })
}

// ---------- stuck ----------
export interface Stuck {
  count: number
  what: string
}

/** The step a call takes, without the noise that changes between attempts (whitespace, numbers). */
function signature(c: ToolCall) {
  const base = c.name === "Bash" || c.kind === "execute" ? commandOf(c) : typeof c.input.file_path === "string" ? c.input.file_path : JSON.stringify(c.input)
  return `${c.name}:${base.replace(/\s+/g, " ").replace(/\d+/g, "#").slice(0, 300)}`
}

/**
 * Stuck: in the current turn, 3 or more failures of the same step among its last 8 tool calls, with no
 * success of that step after them. Only the latest turn counts: a new prompt from you resets it.
 */
export function stuck(t: Transcript): Stuck | null {
  const turn = t.turns[t.turns.length - 1]
  if (!turn) return null
  const calls: ToolCall[] = []
  for (let i = t.order.length - 1; i >= 0 && calls.length < 8; i--) {
    const it = t.items[t.order[i]]
    if (!it) continue
    if (it.turnId !== turn.id) break
    if (it.type === "tool_call" && it.call.status !== "pending" && it.call.status !== "in_progress") calls.push(it.call)
  }
  const fails = new Map<string, { n: number; call: ToolCall }>()
  const okSince = new Set<string>()
  for (const c of calls) {
    // newest first: a success of a step newer than its failures means it got past them
    const sig = signature(c)
    if (!failed(c)) {
      if (!fails.has(sig)) okSince.add(sig)
      continue
    }
    if (okSince.has(sig)) continue
    const e = fails.get(sig) ?? { n: 0, call: c }
    e.n++
    fails.set(sig, e)
  }
  let best: { n: number; call: ToolCall } | null = null
  for (const e of fails.values()) if (e.n >= 3 && (!best || e.n > best.n)) best = e
  if (!best) return null
  const cmd = commandOf(best.call)
  return { count: best.n, what: cmd ? cmd.split("\n")[0].slice(0, 120) : best.call.title || best.call.name }
}

const sCache = new Map<ID, { order: ID[]; items: Transcript["items"]; value: Stuck | null }>()
export function useStuck(sessionId: ID): Stuck | null {
  return useApp((s) => {
    const t = s.transcripts[sessionId]
    if (!t) return null
    const hit = sCache.get(sessionId)
    if (hit && hit.order === t.order && hit.items === t.items) return hit.value
    const value = stuck(t)
    sCache.set(sessionId, { order: t.order, items: t.items, value })
    return value
  })
}

export const STEP_BACK =
  "Stop and step back: the same step has now failed several times. Before changing anything else, say what you tried, what the error actually says, and what you assumed that may be wrong. Then propose a different approach."
