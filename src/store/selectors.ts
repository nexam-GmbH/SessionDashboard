import { useShallow } from "zustand/react/shallow"
import { REAL } from "@/backend/mode"
import type { ID, Session, SessionStatus, Subagent } from "@/lib/model"
import { compareAttention, SUBAGENT_STATUS_AS_SESSION } from "@/lib/status"
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

const sv = (s: AppState) => `${s.structVersion}:${s.statusVersion}:${s.settings.workspace}`
const stv = (s: AppState) => `${s.structVersion}:${s.settings.workspace}`

/** The active workspace (Settings → Workspaces), or undefined when everything is shown. */
export function activeWorkspace(s: AppState) {
  const id = s.settings.workspace
  return id ? s.settings.workspaces.find((w) => w.id === id) : undefined
}

/**
 * Whether a project is on screen in the active workspace: only the workspace's repositories
 * ("All workspaces" shows everything).
 */
export function repoInView(s: AppState, repoId: ID | null | undefined) {
  if (!activeWorkspace(s)) return true
  const r = repoId ? s.repos[repoId] : undefined
  if (!r) return false
  return r.workspace === s.settings.workspace
}

export function isVisibleLive(s: Session) {
  return !s.archived && s.control !== "history"
}

// ---------- single records ----------
export const useSession = (id: ID | undefined) => useApp((s) => (id ? s.sessions[id] : undefined))
export const useRepo = (id: ID | undefined | null) => useApp((s) => (id ? s.repos[id] : undefined))
export const useSubagent = (id: ID | undefined) => useApp((s) => (id ? s.subagents[id] : undefined))

// ---------- order & attention ----------
/**
 * Live sessions in the order the session list shows them: main agent, then each repo's sessions
 * oldest first. Stable: a session keeps its place (and its Ctrl+number) while it lives.
 */
export const selectSessionOrder = memoOn(
  stv,
  (s) => {
    const out: ID[] = []
    const main = s.sessions[s.mainSessionId]
    if (main && isVisibleLive(main)) out.push(main.id)
    // main folders first (they sit on top of the overview), then the repos in their order
    const order = [...s.repoOrder.filter((id) => s.repos[id]?.isHome), ...s.repoOrder.filter((id) => !s.repos[id]?.isHome)]
    for (const repoId of order) if (repoInView(s, repoId)) out.push(...selectLiveSessionIds(s, repoId).filter((id) => id !== s.mainSessionId))
    return out
  },
)

/** Projects with at least one live session, in project order: what the overview and the list show. */
export const selectVisibleRepos = memoOn(
  stv,
  (s) => s.repoOrder.filter((id) => !s.repos[id]?.isHome && repoInView(s, id) && (s.repos[id]?.inWorkspace || hasLive(s, id))),
)
/** The main folders on screen (the active workspace's; all of them under "All workspaces"). */
export const selectHomeRepos = memoOn(
  stv,
  (s) => Object.values(s.repos).filter((r) => r.isHome && repoInView(s, r.id)).map((r) => r.id),
)
export const useHomeRepos = () => useApp(useShallow(selectHomeRepos))

/** Per workspace: how many sessions need you (the switcher shows the other workspaces' count). */
export const selectNeedsByWorkspace = memoOn(
  (s) => `${s.structVersion}:${s.statusVersion}`,
  (s) => {
    const out: Record<string, number> = {}
    for (const sess of Object.values(s.sessions)) {
      if (!isVisibleLive(sess) || !(NEEDS.has(sess.status) || childWaiting(s, sess.id))) continue
      const ws = sess.repoId ? s.repos[sess.repoId]?.workspace : undefined
      if (ws) out[ws] = (out[ws] ?? 0) + 1
    }
    return out
  },
)
export const useVisibleRepos = () => useApp(selectVisibleRepos)

/** A subagent of this session is waiting for a permission (it surfaces on the parent). */
const NEEDS = new Set<SessionStatus>(["waiting_permission", "waiting_input", "error"])

export function childWaiting(s: AppState, id: ID) {
  return (s.subagentIdsBySession[id] ?? []).some((a) => s.subagents[a]?.status === "waiting_permission")
}

/**
 * The status a session is drawn with: a running session whose subagent waits for a permission is
 * drawn as waiting for permission, so every surface (tree, list, search, Ctrl+Tab) agrees with the
 * "need you" count.
 */
export function shownStatus(s: AppState, id: ID): SessionStatus {
  const st = s.sessions[id]?.status ?? "idle"
  return (st === "working" || st === "starting" || st === "idle") && childWaiting(s, id) ? "waiting_permission" : st
}
export const useShownStatus = (id: ID) => useApp((s) => shownStatus(s, id))

/**
 * The one "needs you" definition: waiting for permission, a question or a plan; failed; or a
 * subagent waiting for permission. Longest waiting first (the order Ctrl+J walks).
 */
export const selectNeedsYou = memoOn(sv, (s) =>
  selectSessionOrder(s)
    .filter((id) => NEEDS.has(s.sessions[id].status) || childWaiting(s, id))
    .sort((a, b) => s.sessions[a].statusObservedAt.localeCompare(s.sessions[b].statusObservedAt)),
)
export const selectNeedsYouCount = (s: AppState) => selectNeedsYou(s).length

/** Whether this session needs the user (same definition as the count). */
export const useNeedsYou = (id: ID) => useApp((s) => selectNeedsYou(s).includes(id))

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
/**
 * The sessions a project shows (overview column, list group). In the desktop app: every running
 * session in start order, then the most recent finished ones, up to Settings → "Recent sessions per
 * project". The mock world shows the running ones only.
 */
export const selectLiveSessionIds = memoKeyed(
  (s) => `${s.structVersion}:${s.settings.recentPerRepo}`,
  (s, repoId) => {
    const all = (s.sessionIdsByRepo[repoId] ?? []).map((id) => s.sessions[id]).filter((x) => x && !x.archived)
    // running sessions in start order: a row (and its Ctrl+number) never moves while it lives
    const started = (a: Session, b: Session) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1)
    const live = all.filter((x) => x.control !== "history").sort(started)
    if (!REAL) return live.map((x) => x.id)
    // then the latest finished ones, newest first, up to Settings → "Recent sessions per project"
    const n = s.settings.recentPerRepo ?? 5
    const recent = (a: Session, b: Session) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)
    const past = all.filter((x) => x.control === "history").sort(recent).slice(0, Math.max(0, n - live.length))
    return [...live, ...past].map((x) => x.id)
  },
)
/** Running sessions only (what makes a project show up on the overview). */
const hasLive = (s: AppState, repoId: ID) => (s.sessionIdsByRepo[repoId] ?? []).some((id) => s.sessions[id] && isVisibleLive(s.sessions[id]) && id !== s.mainSessionId)
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
