// Adapted from dagster-io/dagster@56029e3:js_modules/ui-core/src/asset-graph/AssetGraphExplorer.tsx (Apache-2.0). Modified for session-dashboard.
// Spatial keyboard navigation and "next item that needs you" on the map.
// Direction picking follows the idea of Dagster's `closestNodeInDirection` (asset graph keyboard
// navigation, Apache-2.0): only nodes strictly on that side count, nearest edge gap wins, and
// sideways offset is penalized. Re-implemented on our layout rects.
import type { ID } from "@/lib/model"
import { getApp } from "@/store/app"
import { selectAttention } from "@/store/selectors"
import { STATUS_TIER } from "@/lib/status"
import type { NavRect } from "./layout"

export type Dir = "up" | "down" | "left" | "right"

const gap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.max(a1, b1) - Math.min(a2, b2))

export function pickInDirection(rects: Map<ID, NavRect>, curId: ID, dir: Dir, allow: (r: NavRect) => boolean): ID | null {
  const cur = rects.get(curId)
  if (!cur) return null
  let best: ID | null = null
  let bestScore = Infinity
  for (const [id, r] of rects) {
    if (id === curId || !allow(r)) continue
    let along: number
    let across: number
    switch (dir) {
      case "down":
        if (r.y < cur.y + cur.h - 1) continue
        along = r.y - (cur.y + cur.h)
        across = gap(cur.x, cur.x + cur.w, r.x, r.x + r.w)
        break
      case "up":
        if (r.y + r.h > cur.y + 1) continue
        along = cur.y - (r.y + r.h)
        across = gap(cur.x, cur.x + cur.w, r.x, r.x + r.w)
        break
      case "right":
        if (r.x < cur.x + cur.w - 1) continue
        along = r.x - (cur.x + cur.w)
        across = gap(cur.y, cur.y + cur.h, r.y, r.y + r.h)
        break
      case "left":
        if (r.x + r.w > cur.x + 1) continue
        along = cur.x - (r.x + r.w)
        across = gap(cur.y, cur.y + cur.h, r.y, r.y + r.h)
        break
    }
    const score = along + across * 3
    if (score < bestScore) {
      bestScore = score
      best = id
    }
  }
  return best
}

export type AttentionTarget = { kind: "session" | "subagent"; id: ID }

/** The waiting item after `current` (tier 0 first; falls back to errors and unseen). */
export function nextAttention(current: ID | null): AttentionTarget | null {
  const all = selectAttention(getApp())
  const waiting = all.filter((e) => STATUS_TIER[e.status] === 0)
  const list = waiting.length ? waiting : all
  if (!list.length) return null
  const idx = current ? list.findIndex((e) => e.id === current) : -1
  const e = list[(idx + 1) % list.length]
  return { kind: e.kind, id: e.id }
}
