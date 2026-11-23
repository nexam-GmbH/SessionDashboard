// What a chat is about, in a line or a short list (the "In this chat" section beside it): the
// features it develops or debugs, one sentence each, the newest one tied to the session's own status;
// or the question it answers; or the task it runs (a script, a release). Written by a small model
// (Haiku, no tools, nothing saved) once a turn ends, from your messages and Claude's last answer of
// each turn, on the active account; kept per session until the chat goes on.
import { create } from "zustand"
import { getApp } from "@/store/app"
import type { ID, Transcript } from "@/lib/model"
import { REAL } from "@/backend/mode"
import { IN_TAURI } from "@/lib/platform"
import { activeAccountOf } from "@/lib/accounts"

export type SummaryKind = "features" | "question" | "task"
export type ItemState = "done" | "open" | "dropped"
export interface SummaryItem {
  text: string
  state: ItemState
}
export interface ChatSummary {
  kind: SummaryKind
  items: SummaryItem[]
  /** the last chat item it covers: a newer one means it is out of date */
  upto: ID
  at: number
}

const LS = "sd.summaries"
const KEEP = 400
const load = (): Record<ID, ChatSummary> => {
  try {
    return JSON.parse(localStorage.getItem(LS) ?? "{}") as Record<ID, ChatSummary>
  } catch {
    return {}
  }
}

interface State {
  map: Record<ID, ChatSummary>
  busy: Record<ID, boolean>
  /** the chat item a summary could not be written for (not asked again until the chat goes on) */
  failed: Record<ID, ID>
}
export const useSummaries = create<State>(() => ({ map: load(), busy: {}, failed: {} }))

function keep(id: ID, s: ChatSummary) {
  useSummaries.setState((st) => {
    const map = { ...st.map, [id]: s }
    // the newest few hundred chats
    const ids = Object.keys(map)
    if (ids.length > KEEP) for (const old of ids.sort((a, b) => map[a].at - map[b].at).slice(0, ids.length - KEEP)) delete map[old]
    try {
      localStorage.setItem(LS, JSON.stringify(map))
    } catch {
      /* storage full: kept in memory */
    }
    return { map }
  })
}

const SYSTEM = "You label what a chat between a user and the coding agent Claude Code is about, for a narrow sidebar. Answer with one JSON object only, no prose, no code fence."

const RULES = `Return {"kind": "features" | "question" | "task", "items": [{"text": string, "state": "done" | "open" | "dropped"}]}.
- "features": the chat builds, changes or debugs software. One item per feature or bug, in the order they came up. Follow-ups, fixes and polish of the same feature are the same item.
- "question": the chat only asks and answers, nothing is built or run. One item: the question.
- "task": the chat mainly runs something (a script, a deploy, a release, a data fix, a setup) rather than building a feature. One item per task.
- text: one short sentence, at most 12 words, saying what it is, not how. No ending period.
- state: "done" when Claude finished it and the chat moved on or the user was content; "open" while it is being worked on or waits for the user; "dropped" when it was given up.
- At most 6 items; when there are more, keep the newest.
- Write in the language the user writes in.`

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** The chat as the model reads it: your messages, the tools of each turn, Claude's last answer. */
export function chatText(t: Transcript, budget = 12000): string {
  const turns: string[] = []
  let user: string[] = []
  let tools = new Map<string, number>()
  let last = ""
  const flush = () => {
    if (!user.length && !last) return
    const parts = [...user]
    if (tools.size) parts.push(`(tools: ${[...tools].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(", ")})`)
    if (last) parts.push(`Claude: ${clip(last.replace(/\s+/g, " "), 280)}`)
    turns.push(parts.join("\n"))
    user = []
    tools = new Map()
    last = ""
  }
  for (const id of t.order) {
    const it = t.items[id]
    if (!it) continue
    if (it.type === "user_message") {
      if (last || tools.size) flush()
      const text = it.shell ? `ran \`${clip(it.text, 120)}\`` : it.text
      user.push(`User: ${clip(text.replace(/\s+/g, " "), 500)}`)
    } else if (it.type === "agent_message" && it.text.trim()) last = it.text
    else if (it.type === "tool_call") tools.set(it.call.name, (tools.get(it.call.name) ?? 0) + 1)
  }
  flush()
  // the newest turns first in the budget; the oldest drop out
  const kept: string[] = []
  let size = 0
  for (const x of [...turns].reverse()) {
    if (size + x.length > budget && kept.length) break
    kept.unshift(x)
    size += x.length
  }
  return (kept.length < turns.length ? "(earlier turns left out)\n\n" : "") + kept.join("\n\n")
}

/** The model's answer as a summary; null when it is not one. */
export function parseSummary(text: string, upto: ID): ChatSummary | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const v = JSON.parse(m[0]) as { kind?: string; items?: { text?: string; state?: string }[] }
    const kind = (["features", "question", "task"] as const).find((k) => k === v.kind)
    const items = (v.items ?? [])
      .filter((x) => typeof x.text === "string" && x.text.trim())
      .slice(-6)
      .map((x) => ({ text: clip(x.text!.trim().replace(/\.$/, ""), 140), state: (["done", "open", "dropped"] as const).find((s) => s === x.state) ?? "open" }))
    if (!kind || !items.length) return null
    return { kind, items, upto, at: Date.now() }
  } catch {
    return null
  }
}

/** The last thing in the chat that a summary can cover (what you wrote or Claude answered). */
export function lastItem(t: Transcript | undefined): ID | undefined {
  if (!t) return
  for (let i = t.order.length - 1; i >= 0; i--) {
    const it = t.items[t.order[i]]
    if (it && (it.type === "user_message" || (it.type === "agent_message" && !it.streaming))) return it.id
  }
}

/** Browser preview: the summary from your messages, no model. */
function previewSummary(t: Transcript, upto: ID): ChatSummary | null {
  const asks = t.order.map((id) => t.items[id]).filter((x) => x?.type === "user_message") as { text: string }[]
  if (!asks.length) return null
  const first = (s: string) => clip(s.split(/[.!?\n]/)[0].trim(), 70)
  if (asks.length === 1 && /\?\s*$/.test(asks[0].text.trim())) return { kind: "question", items: [{ text: first(asks[0].text), state: "open" }], upto, at: Date.now() }
  const items = asks.slice(-3).map((a, i, all) => ({ text: first(a.text), state: (i === all.length - 1 ? "open" : "done") as ItemState }))
  return { kind: "features", items, upto, at: Date.now() }
}

/** Write (or bring up to date) the summary of a chat. Quietly nothing when it fails. */
export async function summarize(id: ID) {
  const st = getApp()
  const t = st.transcripts[id]
  const upto = lastItem(t)
  if (!t || !upto || useSummaries.getState().busy[id]) return
  if (useSummaries.getState().map[id]?.upto === upto) return
  useSummaries.setState((s) => ({ busy: { ...s.busy, [id]: true } }))
  try {
    if (!(IN_TAURI && REAL)) {
      const s = previewSummary(t, upto)
      if (s) keep(id, s)
      return
    }
    const prev = useSummaries.getState().map[id]
    const prompt = `${RULES}\n${prev ? `\nThe labels so far (keep their wording where it still fits):\n${JSON.stringify({ kind: prev.kind, items: prev.items })}\n` : ""}\nThe chat:\n\n${chatText(t)}\n`
    const { invoke } = await import("@tauri-apps/api/core")
    const s = getApp().sessions[id]
    const answer = await invoke<string>("claude_quick_prompt", { prompt, system: SYSTEM, accountId: s?.machine ? null : activeAccountOf(getApp()) || null })
    const parsed = parseSummary(answer, upto)
    if (parsed) keep(id, parsed)
    else throw new Error("not a summary")
  } catch {
    // no summary this time (offline, at the limit): the old one stays
    useSummaries.setState((s) => ({ failed: { ...s.failed, [id]: upto } }))
  } finally {
    useSummaries.setState((s) => ({ busy: { ...s.busy, [id]: false } }))
  }
}
