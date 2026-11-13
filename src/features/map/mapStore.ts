// Adapted from kubernetes-sigs/headlamp@e16a575:frontend/src/components/resourceMap/graphViewContext.tsx (Apache-2.0). Modified for session-dashboard.
// Map-local state and small store helpers. Structural layout metadata that node components need
// (stack membership, which subagents a card shows) lives here so React Flow `nodes` can stay
// structure-only (`data: { id }`), the Headlamp resource-map idea of id-only nodes that read
// their live data from a store (kubernetes-sigs/headlamp@e16a575, Apache-2.0).
import { create } from "zustand"
import type { ID } from "@/lib/model"
import { getApp, setApp } from "@/store/app"
import { isVisibleLive } from "@/store/selectors"

export interface StackMeta {
  /** live idle sessions collapsed into the stack, most recent first */
  idle: ID[]
  /** history sessions inside the History range, most recent first */
  history: ID[]
  /** history sessions in range before the display cap */
  historyTotal: number
  expanded: boolean
}

interface MapLocal {
  stacks: Record<ID, StackMeta>
  minimap: boolean
  /** bumps when the canvas should fit/center a node after the next layout */
  focus: { id: ID; seq: number } | null
  /** keyboard cursor on a node the app selection can't hold (a stack) */
  cursor: ID | null
}

export const useMapLocal = create<MapLocal>()(() => ({
  stacks: {},
  minimap: false,
  focus: null,
  cursor: null,
}))

export const setMapLocal = useMapLocal.setState
export const getMapLocal = useMapLocal.getState

let focusSeq = 0
export function requestFocus(id: ID) {
  setMapLocal({ focus: { id, seq: ++focusSeq } })
}

/**
 * One-time defaults for this app run: sessions with a running or waiting subagent start with
 * their subagent tree expanded (capped so the stress fixture stays light).
 */
let seeded = false
export function seedMapDefaults() {
  if (seeded) return
  seeded = true
  const s = getApp()
  if (Object.keys(s.map.expandedSubagents).length) return
  const next: Record<ID, true> = {}
  let n = 0
  for (const [sid, ids] of Object.entries(s.subagentIdsBySession)) {
    if (n >= 12) break
    const sess = s.sessions[sid]
    if (!sess || !isVisibleLive(sess)) continue
    if (ids.some((a) => s.subagents[a]?.status === "running" || s.subagents[a]?.status === "waiting_permission")) {
      next[sid] = true
      n++
    }
  }
  if (n) setApp((st) => ({ map: { ...st.map, expandedSubagents: next } }))
}

/**
 * Make a session/subagent/repo visible on the map: un-collapse its repo, expand the stack that
 * holds it, expand its parent's subagent tree, drop filters that hide it. Returns the node id to
 * focus (the item itself).
 */
export function revealOnMap(kind: "session" | "subagent" | "repo", id: ID): ID {
  const s = getApp()
  const map = { ...s.map }
  let changed = false
  const uncollapse = (repoId: ID) => {
    if (map.collapsedRepos[repoId]) {
      const c = { ...map.collapsedRepos }
      delete c[repoId]
      map.collapsedRepos = c
      changed = true
    }
    if (map.repoFilter.length && !map.repoFilter.includes(repoId)) {
      map.repoFilter = []
      changed = true
    }
  }
  const showSession = (sid: ID) => {
    const sess = s.sessions[sid]
    if (!sess || sess.role === "main" || !sess.repoId) return
    uncollapse(sess.repoId)
    if (map.statusFilter.length && !map.statusFilter.includes(sess.status)) {
      map.statusFilter = []
      changed = true
    }
    const stack = getMapLocal().stacks[sess.repoId]
    const inStack = stack && (stack.idle.includes(sid) || stack.history.includes(sid))
    if (inStack && !map.expandedStacks[sess.repoId]) {
      map.expandedStacks = { ...map.expandedStacks, [sess.repoId]: true }
      changed = true
    }
    if (sess.control === "history" && !inStack && map.historyRange !== "30d") {
      map.historyRange = "30d"
      map.expandedStacks = { ...map.expandedStacks, [sess.repoId]: true }
      changed = true
    }
  }
  if (kind === "repo") uncollapse(id)
  else if (kind === "session") showSession(id)
  else {
    const sub = s.subagents[id]
    if (sub) {
      showSession(sub.sessionId)
      if (!map.expandedSubagents[sub.sessionId]) {
        map.expandedSubagents = { ...map.expandedSubagents, [sub.sessionId]: true }
        changed = true
      }
    }
  }
  if (changed) setApp({ map })
  return id
}
