// Rewind (Claude Code `/rewind`, Esc Esc): go back to an earlier prompt and restore the
// conversation, the code, or both. Phase 1 works on the mock transcript; Phase 2 maps it to
// checkpoints (`--resume-session-at` / file checkpoints). Every rewind can be undone once.
import { getApp, setApp } from "@/store/app"
import { setStatus } from "@/store/actions"
import type { ID, Item, Transcript } from "@/lib/model"
import { showUndo } from "@/features/notifications/undo"
import { deriveChangedFiles, interruptSession, setUiValue } from "./sessionStore"

export type RewindScope = "both" | "conversation" | "code"

export interface RewindPoint {
  turnId: ID
  prompt: string
  at: string
  /** files edited from this prompt on (what "code" restores) */
  filesAfter: number
}

/** Earlier prompts of a session, newest first. The first prompt is included (rewind to the start). */
export function rewindPoints(t: Transcript | undefined): RewindPoint[] {
  if (!t) return []
  const out: RewindPoint[] = []
  const filesFrom = new Set<string>()
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const turn = t.turns[i]
    for (const id of turn.itemIds) {
      const it = t.items[id]
      if (it?.type === "tool_call") for (const d of it.call.diff ?? []) filesFrom.add(d.path)
    }
    const first = t.items[turn.itemIds[0]]
    if (first?.type !== "user_message") continue
    out.push({ turnId: turn.id, prompt: first.text, at: first.at, filesAfter: filesFrom.size })
  }
  return out
}

function diffOf(t: Transcript) {
  const files = deriveChangedFiles(t).filter((f) => !f.pending)
  return {
    filesChanged: files.length,
    linesAdded: files.reduce((n, f) => n + f.added, 0),
    linesRemoved: files.reduce((n, f) => n + f.removed, 0),
  }
}

export function rewindTo(sessionId: ID, turnId: ID, scope: RewindScope) {
  const st = getApp()
  const t = st.transcripts[sessionId]
  const session = st.sessions[sessionId]
  if (!t || !session) return
  const index = t.turns.findIndex((x) => x.id === turnId)
  if (index < 0) return
  const prompt = t.items[t.turns[index].itemIds[0]]
  const promptText = prompt?.type === "user_message" ? prompt.text : ""

  // snapshot for Undo
  const before = { transcript: t, session, requests: st.requests }

  interruptSession(sessionId)
  const cur = getApp().transcripts[sessionId] ?? t
  const later = new Set(cur.turns.slice(index).flatMap((x) => x.itemIds))
  let next: Transcript
  if (scope === "code") {
    // keep the conversation, drop the file changes made from this prompt on, leave a marker
    const items: Record<ID, Item> = { ...cur.items }
    for (const id of later) {
      const it = items[id]
      if (it?.type === "tool_call" && it.call.diff?.length) items[id] = { ...it, call: { ...it.call, diff: undefined } }
    }
    const last = cur.turns.at(-1)!
    const noticeId = `n_rw_${sessionId}_${Date.now().toString(36)}`
    items[noticeId] = { type: "notice", id: noticeId, turnId: last.id, at: new Date().toISOString(), severity: "info", text: `Code restored to before “${promptText.slice(0, 60)}”` }
    next = {
      ...cur,
      items,
      order: [...cur.order, noticeId],
      turns: [...cur.turns.slice(0, -1), { ...last, itemIds: [...last.itemIds, noticeId] }],
    }
  } else {
    const items: Record<ID, Item> = {}
    for (const id in cur.items) if (!later.has(id)) items[id] = cur.items[id]
    next = { ...cur, items, order: cur.order.filter((id) => !later.has(id)), turns: cur.turns.slice(0, index), liveItemId: undefined }
  }

  const keepDiff = scope === "conversation"
  setApp((s) => ({
    transcripts: { ...s.transcripts, [sessionId]: next },
    // questions/permissions belonged to the turns that are gone
    requests:
      scope === "code"
        ? s.requests
        : Object.fromEntries(
            Object.entries(s.requests).map(([id, r]) => [id, r.sessionId === sessionId && r.state === "pending" ? { ...r, state: "cancelled" as const } : r]),
          ),
  }))
  setStatus(sessionId, scope === "code" ? (session.status === "working" ? "idle" : session.status) : "idle", {
    waitingFor: scope === "code" ? session.waitingFor : undefined,
    activity: undefined,
    diff: keepDiff ? session.diff : { ...session.diff, ...diffOf(next) },
  })
  // the prompt goes back into the composer so it can be edited and sent again (as in the CLI)
  if (scope !== "code") setUiValue(`prefill:${sessionId}`, { n: Date.now(), text: promptText })

  showUndo("Rewound", promptText.length > 48 ? `${promptText.slice(0, 48)}…` : promptText, () => {
    setApp((s) => ({
      transcripts: { ...s.transcripts, [sessionId]: before.transcript },
      sessions: { ...s.sessions, [sessionId]: before.session },
      requests: {
        ...s.requests,
        ...Object.fromEntries(Object.entries(before.requests).filter(([, r]) => r.sessionId === sessionId)),
      },
      statusVersion: s.statusVersion + 1,
    }))
    setUiValue(`prefill:${sessionId}`, { n: Date.now(), text: "" })
  })
}
