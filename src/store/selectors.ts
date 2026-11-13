import { useShallow } from "zustand/react/shallow"
import type { ID, Session, SessionStatus, Subagent } from "@/lib/model"
import { compareAttention, needsYou, STATUS_TIER, SUBAGENT_STATUS_AS_SESSION } from "@/lib/status"
import { useApp, type AppState } from "./app"

/** Memoize a derived value on a version number (no recompute on unrelated updates). */
function memoOn<T>(version: (s: AppState) => string | number, compute: (s: AppState) => T) {
  let lastV: string | number | undefined
  let cached: T
  return (s: AppState): T => {
    const v = version(s)
    if (v !== lastV) {
      lastV = v
      cached = compute(s)
    }
    return cached
  }
}

function memoKeyed<T>(version: (s: AppState) => string | number, compute: (s: AppState, key: string) => T) {
  const cache = new Map<string, { v: string | number; value: T }>()
  return (s: AppState, key: string): T => {
    const v = version(s)
    const hit = cache.get(key)
    if (hit && hit.v === v) return hit.value
    const value = compute(s, key)
    cache.set(key, { v, value })
    return value
  }
}

const sv = (s: AppState) => `${s.structVersion}:${s.statusVersion}`

export function isVisibleLive(s: Session) {
  return !s.archived && s.control !== "history"
}

// ---------- single records ----------
export const useSession = (id: ID | undefined) => useApp((s) => (id ? s.sessions[id] : undefined))
export const useRepo = (id: ID | undefined | null) => useApp((s) => (id ? s.repos[id] : undefined))
export const useSubagent = (id: ID | undefined) => useApp((s) => (id ? s.subagents[id] : undefined))

// ---------- attention queue ----------
export type AttentionEntry =
  | { kind: "session"; id: ID; status: SessionStatus; at: string }
  | { kind: "subagent"; id: ID; sessionId: ID; status: SessionStatus; at: string }

export const selectAttention = memoOn(sv, (s) => {
  const out: AttentionEntry[] = []
  for (const sess of Object.values(s.sessions)) {
    if (!isVisibleLive(sess) || !needsYou(sess.status)) continue
    out.push({ kind: "session", id: sess.id, status: sess.status, at: sess.statusObservedAt })
  }
  for (const sub of Object.values(s.subagents)) {
    if (sub.status !== "waiting_permission") continue
    const parent = s.sessions[sub.sessionId]
    if (!parent || !isVisibleLive(parent)) continue
    out.push({ kind: "subagent", id: sub.id, sessionId: sub.sessionId, status: "waiting_permission", at: sub.startedAt })
  }
  out.sort((a, b) => STATUS_TIER[a.status] - STATUS_TIER[b.status] || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return out
})
export const useAttention = () => useApp(selectAttention)

/** Number of items that need the user right now: waiting (tier 0) + errors (tier 1). One definition everywhere. */
export const selectWaitingCount = (s: AppState) =>
  selectAttention(s).filter((e) => STATUS_TIER[e.status] <= 1).length

// ---------- status counts ----------
export type StatusCounts = Record<SessionStatus, number> & { background: number }
export const selectStatusCounts = memoOn(sv, (s) => {
  const c: StatusCounts = {
    starting: 0, working: 0, waiting_permission: 0, waiting_input: 0,
    idle: 0, done_unseen: 0, error: 0, stopped: 0, background: 0,
  }
  for (const sess of Object.values(s.sessions)) {
    if (sess.archived || sess.control === "history") continue
    c[sess.status]++
    if (sess.backgroundTasks > 0) c.background++
  }
  return c
})
export const useStatusCounts = () => useApp(selectStatusCounts)

// ---------- per repo ----------
/** Live (non-archived, non-history) sessions of a repo, stable order (oldest first). */
export const selectLiveSessionIds = memoKeyed(
  (s) => s.structVersion,
  (s, repoId) => {
    const ids = (s.sessionIdsByRepo[repoId] ?? []).filter((id) => isVisibleLive(s.sessions[id]))
    return ids.sort((a, b) => {
      const x = s.sessions[a].createdAt
      const y = s.sessions[b].createdAt
      return x < y ? -1 : x > y ? 1 : 0
    })
  },
)
export const useLiveSessionIds = (repoId: ID) => useApp((s) => selectLiveSessionIds(s, repoId))

export type Rollup = { total: number } & Partial<Record<SessionStatus, number>>
// last rollup per repo: returned again when the counts are unchanged, so subscribers (sidebar
// repo rows, map groups, inspector) don't re-render on status changes in other repos
const lastRollup = new Map<ID, Rollup>()
function sameRollup(a: Rollup, b: Rollup) {
  const ka = Object.keys(a) as (keyof Rollup)[]
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => a[k] === b[k])
}
export const selectRepoRollup = memoKeyed(sv, (s, repoId) => {
  const r: Rollup = { total: 0 }
  for (const id of selectLiveSessionIds(s, repoId)) {
    const st = s.sessions[id].status
    r[st] = (r[st] ?? 0) + 1
    r.total++
  }
  const prev = lastRollup.get(repoId)
  if (prev && sameRollup(prev, r)) return prev
  lastRollup.set(repoId, r)
  return r
})
export const useRepoRollup = (repoId: ID) => useApp((s) => selectRepoRollup(s, repoId))

// ---------- subagents ----------
export const useSubagentIds = (sessionId: ID) =>
  useApp(useShallow((s) => s.subagentIdsBySession[sessionId] ?? EMPTY))

export function subagentAsStatus(sub: Subagent): SessionStatus {
  return SUBAGENT_STATUS_AS_SESSION[sub.status]
}

// ---------- requests ----------
export const selectPendingRequestsForSession = memoKeyed(
  (s) => `${s.statusVersion}`,
  (s, sessionId) =>
    Object.values(s.requests)
      .filter((r) => r.sessionId === sessionId && r.state === "pending")
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)),
)
export const usePendingRequests = (sessionId: ID) =>
  useApp((s) => selectPendingRequestsForSession(s, sessionId))

// ---------- all sessions for tables ----------
export const selectAllSessionIds = memoOn(
  (s) => s.structVersion,
  (s) => Object.keys(s.sessions),
)

export const EMPTY: ID[] = []

/** Archived session count, recomputed only on structural changes (not on every engine tick). */
export const selectArchivedCount = memoOn(
  (s) => s.structVersion,
  (s) => {
    let n = 0
    for (const id in s.sessions) if (s.sessions[id].archived) n++
    return n
  },
)

export function sortByAttention(sessions: Session[]) {
  return sessions.slice().sort(compareAttention)
}
