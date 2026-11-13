import type { ID, SessionStatus } from "@/lib/model"
import { STATUS_TIER } from "@/lib/status"
import type { AppState } from "@/store/app"
import { isVisibleLive, selectAttention, selectLiveSessionIds, type AttentionEntry } from "@/store/selectors"

/**
 * Flat row model for the virtualized sidebar tree. Derivation idea from
 * Agent of Empires web/src/components/sidebar/rowModel.ts (MIT): derive every
 * row's display props from the store, render rows dumb.
 */
export type SidebarRow =
  | { type: "section"; key: "needs" | "done" | "main" | "repos" | "group"; label: string; count?: number; open: boolean; groupKey?: string }
  | { type: "attention"; key: string; entry: AttentionEntry; index: number }
  | { type: "session"; key: string; id: ID; depth: number; hasChildren: boolean; open: boolean; twoLine: boolean }
  | { type: "subagent"; key: string; id: ID; depth: number }
  | { type: "repo"; key: string; id: ID; open: boolean }
  | { type: "empty"; key: string; text: string }
  | { type: "more"; key: string; text: string }
  | { type: "idle"; key: string; repoId: ID; count: number; open: boolean }

const ROW_H_BY_TYPE: Record<SidebarRow["type"], number> = {
  section: 28,
  attention: 28,
  session: 28,
  subagent: 26,
  repo: 28,
  empty: 26,
  more: 24,
  idle: 26,
}

/** Calm UI rule 1/8: one line at rest, a second line only when it carries signal. */
export function rowHeight(row: SidebarRow) {
  if (row.type === "session" && row.twoLine) return 44
  return ROW_H_BY_TYPE[row.type]
}

/**
 * Second line only on the main agent (what it is coordinating). Repo-tree rows stay one line:
 * what a waiting/failed session needs is already spelled out in "Needs you" right above, and
 * live activity text changes every few seconds, which reads as noise in a navigation list.
 * The map and the session itself show the activity; the row tooltip has it too.
 */
export function hasSignal(s: AppState, id: ID) {
  const x = s.sessions[id]
  if (!x || x.role !== "main") return false
  return x.status === "waiting_permission" || x.status === "waiting_input" || x.status === "error" || (x.status === "working" && !!x.activity)
}

export interface SidebarUi {
  needsOpen: boolean
  needsAll: boolean
  doneOpen: boolean
  mainOpen: boolean
  reposOpen: boolean
  closedGroups: Record<string, true>
}

export function buildRows(s: AppState, ui: SidebarUi): SidebarRow[] {
  const rows: SidebarRow[] = []
  const attention = selectAttention(s)

  const needs = attention.filter((e) => STATUS_TIER[e.status] <= 1)
  const done = attention.filter((e) => e.status === "done_unseen")
  rows.push({ type: "section", key: "needs", label: "Needs you", count: needs.length, open: ui.needsOpen })
  if (ui.needsOpen) {
    if (!needs.length) rows.push({ type: "empty", key: "needs-empty", text: "Nothing needs you." })
    const limit = ui.needsAll ? 60 : 6
    needs.slice(0, limit).forEach((entry, index) =>
      rows.push({ type: "attention", key: `att:${entry.kind}:${entry.id}`, entry, index }),
    )
    if (needs.length > 6) {
      rows.push({ type: "more", key: "needs-more", text: ui.needsAll ? "Show fewer" : `${needs.length - 6} more` })
    }
  }
  if (done.length) {
    // finished but not looked at: a quiet, collapsed-by-default list
    rows.push({ type: "section", key: "done", label: "Done", count: done.length, open: ui.doneOpen })
    if (ui.doneOpen) done.slice(0, 20).forEach((entry, index) => rows.push({ type: "attention", key: `done:${entry.id}`, entry, index }))
  }

  rows.push({ type: "section", key: "main", label: "Main agent", open: ui.mainOpen })
  if (ui.mainOpen) {
    const mainId = s.mainSessionId
    const subs = s.subagentIdsBySession[mainId] ?? []
    const open = !!s.sidebarExpanded[mainId]
    rows.push({ type: "session", key: `s:${mainId}`, id: mainId, depth: 0, hasChildren: subs.length > 0, open, twoLine: hasSignal(s, mainId) })
  }

  if (s.sidebarGroupBy === "repo") {
    rows.push({ type: "section", key: "repos", label: "Repos", count: s.repoOrder.length, open: ui.reposOpen })
    if (!ui.reposOpen) return rows
    const order = s.repoOrder.slice().sort((a, b) => {
      const pa = s.repos[a].pinned ? 0 : 1
      const pb = s.repos[b].pinned ? 0 : 1
      return pa - pb || s.repos[a].name.localeCompare(s.repos[b].name)
    })
    for (const repoId of order) {
      const open = !!s.sidebarExpanded[repoId]
      rows.push({ type: "repo", key: `r:${repoId}`, id: repoId, open })
      if (!open) continue
      // Calm UI rule 4: active sessions first, idle ones collapse into one "N idle" line
      const ids = selectLiveSessionIds(s, repoId)
      const idle = ids.filter((id) => s.sessions[id].status === "idle" && !s.sessions[id].pinned)
      for (const sid of ids) if (!idle.includes(sid)) pushSession(s, rows, sid, 1)
      if (idle.length) {
        const idleOpen = !!s.sidebarExpanded[`idle:${repoId}`]
        rows.push({ type: "idle", key: `i:${repoId}`, repoId, count: idle.length, open: idleOpen })
        if (idleOpen) for (const sid of idle) pushSession(s, rows, sid, 1)
      }
    }
  } else {
    const live = Object.values(s.sessions).filter((x) => isVisibleLive(x) && x.role !== "main")
    if (s.sidebarGroupBy === "recent") {
      rows.push({ type: "section", key: "repos", label: "Recent", count: live.length, open: ui.reposOpen })
      if (!ui.reposOpen) return rows
      live.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      for (const x of live) pushSession(s, rows, x.id, 0)
    } else {
      const groups = new Map<SessionStatus, ID[]>()
      for (const x of live) groups.set(x.status, [...(groups.get(x.status) ?? []), x.id])
      const sorted = [...groups.entries()].sort((a, b) => STATUS_TIER[a[0]] - STATUS_TIER[b[0]])
      for (const [status, ids] of sorted) {
        const open = !ui.closedGroups[status]
        rows.push({ type: "section", key: "group", groupKey: status, label: status.replace("_", " "), count: ids.length, open })
        if (open) for (const id of ids) pushSession(s, rows, id, 0)
      }
    }
  }
  return rows
}

function pushSession(s: AppState, rows: SidebarRow[], sid: ID, depth: number) {
  const subs = s.subagentIdsBySession[sid] ?? []
  const open = !!s.sidebarExpanded[sid]
  rows.push({ type: "session", key: `s:${sid}`, id: sid, depth, hasChildren: subs.length > 0, open, twoLine: hasSignal(s, sid) })
  if (!open) return
  // top-level subagents first, nested (spawnDepth 2) directly under their parent
  const top = subs.filter((id) => !s.subagents[id].parentSubagentId)
  for (const aid of top) {
    rows.push({ type: "subagent", key: `a:${aid}`, id: aid, depth: depth + 1 })
    for (const nid of subs.filter((id) => s.subagents[id].parentSubagentId === aid)) {
      rows.push({ type: "subagent", key: `a:${nid}`, id: nid, depth: depth + 2 })
    }
  }
}
