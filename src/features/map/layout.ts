// Adapted from kubernetes-sigs/headlamp@e16a575:frontend/src/components/resourceMap/graph/graphLayout.tsx (Apache-2.0). Modified for session-dashboard.
// Deterministic, stable map layout — UI_PLAN §5.1 "Layout" and §12.3.
//
// - Main agent centered on top; repo groups in a wrapping grid of columns (pinned first, then by
//   name). A repo keeps its column (index % cols); repos stack per column, so a structural change
//   in one repo only shifts the repos below it in the same column.
// - Inside a repo: active session cards stacked vertically (pinned, then oldest first), each
//   followed by its subagent subtree as an indented tree (simple indent pass), then one stack node
//   holding idle and history sessions (Argo CD "N collapsed" sibling grouping, Apache-2.0).
// - Positions change only on structural events (session added/archived, collapse/expand, filters).
//   Status ticks never re-layout: which sessions sit in a repo's stack is frozen per repo and
//   re-evaluated only when that repo's structure changes.
// - Edges are routed after layout through the column gutters, so they never cross a card.
// - Results are cached by a structure hash (Headlamp resource map, Apache-2.0: djb2 framed hash in
//   kubernetes-sigs/headlamp@e16a575:frontend/src/components/resourceMap/graph/graphLayout.tsx
//   `hashString`/`getGraphCacheKey`, plus its small bounded layout cache).
import { MarkerType, Position, type Edge, type Node, type NodeHandle } from "@xyflow/react"
import type { ID, RepoLink, Session } from "@/lib/model"
import type { AppState, HistoryRange } from "@/store/app"
import { isVisibleLive } from "@/store/selectors"
import type { StackMeta } from "./mapStore"

// ---------- geometry (world px) ----------
// Calm UI (UI_PLAN §2.5): cards carry glyph + title + at most one context line, so they are much
// shorter than the old metrics cards. Every size below is mirrored by the node components.
export const MAIN_W = 340
export const MAIN_H = 136
export const GROUP_W = 296
export const GROUP_PAD = 8
export const HEADER_H = 40
export const CARD_W = GROUP_W - GROUP_PAD * 2
/** session card anatomy: 12px padding, 17px title lines, one 20px context row */
export const CARD_PAD = 12
export const TITLE_LINE = 17
export const CTX_GAP = 6
export const CTX_H = 20
/** status glyph box + gaps + age column of the title row (SessionNode mirrors these) */
const GLYPH_W = 14
const ROW_GAP = 8
export const AGE_W = 26
export const TITLE_W = CARD_W - CARD_PAD * 2 - GLYPH_W - ROW_GAP * 2 - AGE_W
export const SUB_H = 32
const SUB_INDENT = 20
const SUB_GAP = 6
export const STACK_H = 32
/** room for the two offset "cards" drawn behind a collapsed stack */
const STACK_LAYERS = 8
export const STACK_OPEN_H = 28
const GAP = 8
const EMPTY_H = 36
export const COL_GAP = 56
const GRID_TOP = MAIN_H + 88
const BUS_Y = MAIN_H + 40
const HISTORY_CAP = 40

/** Height of a session card: title lines plus the context row when reserved. */
export function sessionHeight(lines: 1 | 2, ctx: boolean) {
  return CARD_PAD * 2 + lines * TITLE_LINE + (ctx ? CTX_GAP + CTX_H : 0)
}
/** Shortest card: one title line, no context (history rows, short idle titles). */
export const SESSION_MIN_H = sessionHeight(1, false)
/** Tallest card, the size of the hover glance at compact LOD. */
export const SESSION_MAX_H = sessionHeight(2, true)

/** Inverse of `sessionHeight`: what a card of this height has room for. */
export function sessionVariant(h: number): { lines: 1 | 2; ctx: boolean } {
  const ctx = h >= sessionHeight(1, true)
  const body = h - CARD_PAD * 2 - (ctx ? CTX_GAP + CTX_H : 0)
  return { lines: body >= 2 * TITLE_LINE ? 2 : 1, ctx }
}

/**
 * Whether a session's status carries a context line (Calm UI glance rule): what it waits for, an
 * error, what it is doing right now, or an idle session that still runs a background shell.
 * Finished and idle cards are title-only.
 */
export function hasContextLine(s: Pick<Session, "status" | "backgroundTasks">) {
  switch (s.status) {
    case "working":
    case "starting":
    case "waiting_permission":
    case "waiting_input":
    case "error":
      return true
    case "idle":
      return s.backgroundTasks > 0
    default:
      return false
  }
}

/** Subagent cards keep the session cards' right edge: each tree level is indented, never wider. */
export const subagentWidth = (depth: number) => CARD_W - SUB_INDENT * Math.min(depth, 3)

// ---------- title measurement (structure-time only) ----------
export const TITLE_FONT = '500 13px "IBM Plex Sans Variable", "IBM Plex Sans", system-ui, sans-serif'
let measureCtx: CanvasRenderingContext2D | null | undefined
const linesCache = new Map<string, 1 | 2>()

export function titleFontReady() {
  try {
    return typeof document !== "undefined" && !!document.fonts?.check(TITLE_FONT)
  } catch {
    return false
  }
}

/**
 * 1 or 2 title lines at full LOD. Measured once per title with a canvas (no DOM layout); before
 * the UI font has loaded, a conservative per-character estimate is used and not cached. A card
 * planned for one line renders its title with an ellipsis, so an estimate can never overflow.
 */
export function titleLines(title: string): 1 | 2 {
  const hit = linesCache.get(title)
  if (hit) return hit
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null
    } catch {
      measureCtx = null
    }
  }
  if (measureCtx && titleFontReady()) {
    measureCtx.font = TITLE_FONT
    const lines = measureCtx.measureText(title).width <= TITLE_W - 2 ? 1 : 2
    linesCache.set(title, lines)
    return lines
  }
  return title.length * 7 <= TITLE_W ? 1 : 2
}

// ---------- handle anchors ----------
/**
 * Static handle anchors on every node (React Flow `node.handles`), the same 1px points React Flow
 * measures from the invisible `MapHandles` (centered on the top and bottom edges). Without them a
 * node object React Flow hasn't measured yet has no handle bounds, and `getNodesInside` then
 * force-renders it even off-screen just to measure it. Every new node object resets that: each
 * layout change and, above all, every card un-hidden when zooming in from the overview tier, so
 * crossing the threshold mounted all ~400 cards of the stress fixture at once (then culled them).
 */
const anchorCache = new Map<string, NodeHandle[]>()
export function anchors(w: number, h: number): NodeHandle[] {
  const key = `${w}x${h}`
  let a = anchorCache.get(key)
  if (!a) {
    a = [
      { type: "target", position: Position.Top, x: w / 2 - 0.5, y: -0.5, width: 1, height: 1 },
      { type: "source", position: Position.Bottom, x: w / 2 - 0.5, y: h - 0.5, width: 1, height: 1 },
    ]
    anchorCache.set(key, a)
  }
  return a
}

// ---------- types ----------
export type MapNodeType = "main" | "repo" | "session" | "subagent" | "stack"
export type MapNodeData = { id: ID }
export type MapNode = Node<MapNodeData, MapNodeType>

export type OrthoKind = "hierarchy" | "delegated" | "spawned" | "forked"
export type OrthoEdgeData = {
  kind: OrthoKind
  points: [number, number][]
  /** sessions whose `working` status animates a delegated edge */
  childIds?: ID[]
  curve?: "ortho" | "bezier"
}
export type LinkEdgeData = { kind: "link"; label: string; linkKind: RepoLink["kind"]; weight?: number }
export type MapEdge = Edge<OrthoEdgeData, "ortho"> | Edge<LinkEdgeData, "link">

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export interface NavRect extends Rect {
  type: MapNodeType
  repoId?: ID
}

export interface LayoutResult {
  key: string
  nodes: MapNode[]
  edges: MapEdge[]
  linkEdges: MapEdge[]
  /** absolute rects of focusable nodes (repo = its header strip) */
  rects: Map<ID, NavRect>
  stacks: Record<ID, StackMeta>
  bounds: Rect
  cols: number
  /** main + the first repo of each column: the initial viewport */
  topIds: ID[]
}

export interface LayoutUi {
  collapsedRepos: Record<ID, true>
  expandedStacks: Record<ID, true>
  expandedSubagents: Record<ID, true>
  historyRange: HistoryRange
  statusFilter: string[]
  repoFilter: ID[]
}

// ---------- hashing (Headlamp graphLayout.tsx, Apache-2.0) ----------
function hashString(str: string, seed = 5381): number {
  let hash = seed
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  return hash
}
function hashFramed(str: string, seed: number): number {
  return hashString(str, hashString(`${str.length}:`, seed))
}

const layoutCache = new Map<string, LayoutResult>()
/** Counters for the perf harness: `computed` = structure passes, `placed` = cache misses. */
export const layoutStats = { computed: 0, placed: 0 }
const MAX_CACHE = 10

// ---------- frozen stack membership ----------
// Which sessions sit in the stack and which cards reserve a context row are frozen per repo and
// re-evaluated only when that repo's structure changes, so a status tick never moves a card.
const classCache = new Map<ID, { key: string; idle: Set<ID>; ctx: Set<ID> }>()

function isIdleish(s: Session) {
  return (s.status === "idle" || s.status === "stopped") && s.backgroundTasks === 0 && !s.pinned
}

const RANGE_MS: Record<HistoryRange, number> = { off: 0, "1d": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 }

// ---------- plan (structure only; hashed) ----------
type PlanItem =
  | { t: "session"; id: ID; h: number; subs: PlanSub[] }
  | { t: "stack"; id: ID; open: boolean }
interface PlanSub {
  id: ID
  depth: number
  parent: ID
}
interface RepoPlan {
  repoId: ID
  collapsed: boolean
  items: PlanItem[]
  /** session id → node id that represents it (card, stack, or repo when collapsed) */
  host: Map<ID, ID>
}

export function computeLayout(s: AppState, ui: LayoutUi, cols: number, now = Date.now()): LayoutResult {
  layoutStats.computed++
  const filter = ui.statusFilter
  const matches = (sess: Session) => !filter.length || filter.includes(sess.status)
  const range = RANGE_MS[ui.historyRange]
  const filterKey = filter.length ? `${filter.join(",")}@${s.statusVersion}` : ""

  // repo order: pinned first, then name
  let repoIds = s.repoOrder.slice()
  if (ui.repoFilter.length) repoIds = repoIds.filter((r) => ui.repoFilter.includes(r))
  repoIds.sort((a, b) => {
    const ra = s.repos[a]
    const rb = s.repos[b]
    return Number(rb.pinned) - Number(ra.pinned) || ra.name.localeCompare(rb.name)
  })

  const plans: RepoPlan[] = []
  const stacks: Record<ID, StackMeta> = {}
  let sig = 5381

  for (const repoId of repoIds) {
    const all = s.sessionIdsByRepo[repoId] ?? []
    const live: Session[] = []
    const history: Session[] = []
    for (const id of all) {
      const sess = s.sessions[id]
      if (!sess || sess.archived) continue
      if (isVisibleLive(sess)) live.push(sess)
      else if (range && sess.control === "history" && now - Date.parse(sess.updatedAt) <= range) history.push(sess)
    }
    live.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.createdAt.localeCompare(b.createdAt))
    history.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    const stackOpen = !!ui.expandedStacks[repoId]
    const collapsed = !!ui.collapsedRepos[repoId]
    const ckey = `${live.map((x) => (x.pinned ? `${x.id}p` : x.id)).join(",")}|${stackOpen}|${collapsed}|${filterKey}`
    let cls = classCache.get(repoId)
    if (!cls || cls.key !== ckey) {
      cls = {
        key: ckey,
        idle: new Set(live.filter(isIdleish).map((x) => x.id)),
        ctx: new Set(live.filter(hasContextLine).map((x) => x.id)),
      }
      classCache.set(repoId, cls)
    }
    const idleSet = cls.idle
    const ctxSet = cls.ctx
    const visibleLive = live.filter(matches)
    const active = visibleLive.filter((x) => !idleSet.has(x.id))
    const idle = visibleLive
      .filter((x) => idleSet.has(x.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const hist = history.filter(matches)
    if (filter.length && !active.length && !idle.length && !hist.length) continue

    const host = new Map<ID, ID>()
    const items: PlanItem[] = []
    const liveH = (sess: Session) => sessionHeight(titleLines(sess.title), ctxSet.has(sess.id))
    const cardItem = (sess: Session, h: number): PlanItem => {
      host.set(sess.id, sess.id)
      const subs: PlanSub[] = []
      if (ui.expandedSubagents[sess.id]) collectSubs(s, sess.id, subs)
      return { t: "session", id: sess.id, h, subs }
    }
    for (const sess of active) items.push(cardItem(sess, liveH(sess)))
    const stackId = `stack:${repoId}`
    if (idle.length || hist.length) {
      stacks[repoId] = {
        idle: idle.map((x) => x.id),
        history: hist.slice(0, HISTORY_CAP).map((x) => x.id),
        historyTotal: hist.length,
        expanded: stackOpen,
      }
      items.push({ t: "stack", id: stackId, open: stackOpen })
      if (stackOpen) {
        for (const sess of idle) items.push(cardItem(sess, liveH(sess)))
        for (const sess of hist.slice(0, HISTORY_CAP)) items.push(cardItem(sess, SESSION_MIN_H))
      } else {
        for (const sess of idle) host.set(sess.id, stackId)
        for (const sess of hist) host.set(sess.id, stackId)
      }
    }
    if (collapsed) for (const k of host.keys()) host.set(k, repoId)
    plans.push({ repoId, collapsed, items: collapsed ? [] : items, host })

    sig = hashFramed(repoId, sig)
    sig = hashFramed(collapsed ? "c" : "e", sig)
    if (!collapsed)
      for (const it of items) {
        sig = hashFramed(it.t === "session" ? `${it.id}:${it.h}:${it.subs.map((x) => `${x.id}/${x.depth}`).join(";")}` : `${it.id}:${it.open}`, sig)
      }
    // hosts matter for edge endpoints (delegated targets)
    for (const [k, v] of host) if (k !== v) sig = hashFramed(`${k}>${v}`, sig)
  }

  // relations that produce edges
  const mainId = s.mainSessionId
  const relations: { child: ID; parent: ID; kind: "delegated" | "forked" }[] = []
  for (const p of plans) {
    for (const sid of p.host.keys()) {
      const sess = s.sessions[sid]
      if (!sess.parent || sess.parent.kind === "teammate") continue
      relations.push({ child: sid, parent: sess.parent.sessionId, kind: sess.parent.kind })
      sig = hashFramed(`${sess.parent.kind}:${sess.parent.sessionId}>${sid}`, sig)
    }
  }
  const includedRepos = new Set(plans.map((p) => p.repoId))
  const links = s.links.filter((l) => includedRepos.has(l.from) && includedRepos.has(l.to))
  for (const l of links) sig = hashFramed(l.id, sig)

  const key = `${cols}:${plans.length}:${sig}`
  const cached = layoutCache.get(key)
  if (cached) return cached

  layoutStats.placed++
  const result = place(plans, relations, links, stacks, cols, mainId, key)
  layoutCache.set(key, result)
  if (layoutCache.size > MAX_CACHE) layoutCache.delete(layoutCache.keys().next().value!)
  return result
}

function collectSubs(s: AppState, sessionId: ID, out: PlanSub[]) {
  const ids = s.subagentIdsBySession[sessionId] ?? []
  if (!ids.length) return
  const set = new Set(ids)
  const byParent = new Map<ID, ID[]>()
  const roots: ID[] = []
  for (const id of ids) {
    const a = s.subagents[id]
    if (!a) continue
    if (a.parentSubagentId && set.has(a.parentSubagentId)) {
      const list = byParent.get(a.parentSubagentId) ?? []
      list.push(id)
      byParent.set(a.parentSubagentId, list)
    } else roots.push(id)
  }
  const byStart = (a: ID, b: ID) => s.subagents[a].startedAt.localeCompare(s.subagents[b].startedAt)
  const walk = (id: ID, depth: number, parent: ID) => {
    out.push({ id, depth, parent })
    for (const c of (byParent.get(id) ?? []).sort(byStart)) walk(c, depth + 1, id)
  }
  for (const r of roots.sort(byStart)) walk(r, 1, sessionId)
}

// ---------- positions, nodes, edges ----------
function place(
  plans: RepoPlan[],
  relations: { child: ID; parent: ID; kind: "delegated" | "forked" }[],
  links: RepoLink[],
  stacks: Record<ID, StackMeta>,
  colsWanted: number,
  mainId: ID,
  key: string,
): LayoutResult {
  const cols = Math.max(1, Math.min(colsWanted, plans.length || 1))
  const colX = (c: number) => c * (GROUP_W + COL_GAP)
  const gridW = cols * GROUP_W + (cols - 1) * COL_GAP
  const mainX = Math.round((gridW - MAIN_W) / 2)
  const mainCX = mainX + MAIN_W / 2

  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  const rects = new Map<ID, NavRect>()
  const abs = new Map<ID, Rect>() // every node's absolute rect (for edge endpoints)
  const nodeRepo = new Map<ID, { repoId: ID; col: number }>()
  const topIds: ID[] = [mainId]

  nodes.push({ id: mainId, type: "main", position: { x: mainX, y: 0 }, width: MAIN_W, height: MAIN_H, handles: anchors(MAIN_W, MAIN_H), data: { id: mainId } })
  rects.set(mainId, { x: mainX, y: 0, w: MAIN_W, h: MAIN_H, type: "main" })
  abs.set(mainId, { x: mainX, y: 0, w: MAIN_W, h: MAIN_H })

  const colY = new Array(cols).fill(GRID_TOP) as number[]
  let maxY = MAIN_H

  plans.forEach((plan, i) => {
    const col = i % cols
    const gx = colX(col)
    const gy = colY[col]
    if (gy === GRID_TOP) topIds.push(plan.repoId)
    const children: MapNode[] = []
    let y = HEADER_H + GROUP_PAD

    const addChild = (id: ID, type: MapNodeType, x: number, h: number, w: number) => {
      children.push({ id, type, parentId: plan.repoId, position: { x, y }, width: w, height: h, handles: anchors(w, h), data: { id: type === "stack" ? plan.repoId : id } })
      const r = { x: gx + x, y: gy + y, w, h }
      abs.set(id, r)
      rects.set(id, { ...r, type, repoId: plan.repoId })
      nodeRepo.set(id, { repoId: plan.repoId, col })
    }

    for (const it of plan.items) {
      if (it.t === "stack") {
        addChild(it.id, "stack", GROUP_PAD, it.open ? STACK_OPEN_H : STACK_H, CARD_W)
        y += (it.open ? STACK_OPEN_H : STACK_H + STACK_LAYERS) + GAP
        continue
      }
      addChild(it.id, "session", GROUP_PAD, it.h, CARD_W)
      y += it.h + GAP
      if (it.subs.length) {
        y -= GAP - SUB_GAP
        for (const sub of it.subs) {
          const x = GROUP_PAD + SUB_INDENT * Math.min(sub.depth, 3)
          addChild(sub.id, "subagent", x, SUB_H, subagentWidth(sub.depth))
          const p = abs.get(sub.parent)!
          const c = abs.get(sub.id)!
          const px = p.x + 10
          const cy = c.y + SUB_H / 2
          edges.push({
            id: `sp:${sub.id}`,
            source: sub.parent,
            target: sub.id,
            type: "ortho",
            markerEnd: { type: MarkerType.ArrowClosed, width: 10, height: 10, color: "var(--border-default)" },
            data: { kind: "spawned", points: [[px, p.y + p.h], [px, cy], [c.x, cy]] },
          })
          y += SUB_H + SUB_GAP
        }
        y += GAP - SUB_GAP
      }
    }
    if (!plan.collapsed && !plan.items.length) y += EMPTY_H + GAP
    const h = plan.collapsed ? HEADER_H : y - GAP + GROUP_PAD

    nodes.push({
      id: plan.repoId,
      type: "repo",
      position: { x: gx, y: gy },
      width: GROUP_W,
      height: h,
      handles: anchors(GROUP_W, h),
      data: { id: plan.repoId },
    })
    nodes.push(...children)
    abs.set(plan.repoId, { x: gx, y: gy, w: GROUP_W, h })
    rects.set(plan.repoId, { x: gx, y: gy, w: GROUP_W, h: HEADER_H, type: "repo", repoId: plan.repoId })
    nodeRepo.set(plan.repoId, { repoId: plan.repoId, col })
    colY[col] = gy + h + COL_GAP
    maxY = Math.max(maxY, gy + h)

    // hierarchy: main → repo through the bus and the column gutter
    const gutter = gx - COL_GAP / 2
    const cx = gx + GROUP_W / 2
    const pts: [number, number][] =
      gy === GRID_TOP
        ? [[mainCX, MAIN_H], [mainCX, BUS_Y], [cx, BUS_Y], [cx, gy]]
        : [[mainCX, MAIN_H], [mainCX, BUS_Y], [gutter, BUS_Y], [gutter, gy + HEADER_H / 2], [gx, gy + HEADER_H / 2]]
    edges.push({ id: `h:${plan.repoId}`, source: mainId, target: plan.repoId, type: "ortho", data: { kind: "hierarchy", points: pts } })
  })

  // host lookup across repos
  const hostOf = new Map<ID, ID>()
  for (const p of plans) for (const [sid, nid] of p.host) hostOf.set(sid, nid)

  // delegated from main: through the bus (offset) and the gutter, into the card's left side
  const delegatedByTarget = new Map<ID, ID[]>()
  for (const r of relations) {
    if (r.kind !== "delegated" || r.parent !== mainId) continue
    const target = hostOf.get(r.child)
    if (!target) continue
    const list = delegatedByTarget.get(target) ?? []
    list.push(r.child)
    delegatedByTarget.set(target, list)
  }
  for (const [target, childIds] of delegatedByTarget) {
    const t = abs.get(target)
    const meta = nodeRepo.get(target)
    if (!t || !meta) continue
    const gutter = colX(meta.col) - COL_GAP / 2 + 6
    const ty = target === meta.repoId ? t.y + HEADER_H / 2 : t.y + CARD_PAD + TITLE_LINE / 2
    const sx = mainCX + 28
    edges.push({
      id: `d:${target}`,
      source: mainId,
      target,
      type: "ortho",
      markerEnd: { type: MarkerType.ArrowClosed, width: 10, height: 10, color: "var(--border-strong)" },
      data: { kind: "delegated", childIds, points: [[sx, MAIN_H], [sx, BUS_Y + 6], [gutter, BUS_Y + 6], [gutter, ty], [t.x, ty]] },
    })
  }

  // session → session (forked, or delegated by a standard session)
  for (const r of relations) {
    if (r.parent === mainId) continue
    const src = abs.get(r.parent)
    const tgt = abs.get(r.child)
    if (!src || !tgt || hostOf.get(r.child) !== r.child || hostOf.get(r.parent) !== r.parent) continue
    const sameRepo = nodeRepo.get(r.parent)?.repoId === nodeRepo.get(r.child)?.repoId
    const markerColor = r.kind === "forked" ? "var(--fg-faint)" : "var(--border-strong)"
    let points: [number, number][]
    let curve: "ortho" | "bezier" = "ortho"
    if (sameRepo) {
      const bx = src.x + src.w + 5
      const oy = CARD_PAD + TITLE_LINE / 2
      points = [[src.x + src.w, src.y + oy], [bx, src.y + oy], [bx, tgt.y + oy], [tgt.x + tgt.w, tgt.y + oy]]
    } else {
      curve = "bezier"
      points = [[src.x + src.w / 2, src.y + src.h], [tgt.x + tgt.w / 2, tgt.y]]
    }
    edges.push({
      id: `${r.kind === "forked" ? "f" : "d"}:${r.child}`,
      source: r.parent,
      target: r.child,
      type: "ortho",
      markerEnd: { type: MarkerType.ArrowClosed, width: 10, height: 10, color: markerColor },
      data: { kind: r.kind, childIds: [r.child], points, curve },
    })
  }

  const linkEdges: MapEdge[] = links.map((l) => ({
    id: `l:${l.id}`,
    source: l.from,
    target: l.to,
    type: "link",
    zIndex: 1,
    data: { kind: "link", label: l.label, linkKind: l.kind, weight: l.weight },
  }))

  return {
    key,
    nodes,
    edges,
    linkEdges,
    rects,
    stacks,
    bounds: { x: Math.min(0, mainX), y: 0, w: Math.max(gridW, MAIN_W), h: maxY },
    cols,
    topIds,
  }
}

/**
 * Zoom the default view opens at: 100%, so card text renders at its design size (titles 13px,
 * context lines 12px). Small workspaces get as many columns as fit the viewport at this zoom.
 */
export const INITIAL_ZOOM_TARGET = 1
/** Lowest zoom the default view may open at: 13px titles still render at ≥ 12px. */
export const READABLE_ZOOM = 0.92
/** Highest zoom the default view may use to keep a partial neighbor column out of view. */
const MAX_INITIAL_ZOOM = 1.1
const VIEW_PAD = 24

/**
 * The default viewport (QA: no repo column may be cut off at the edges). If the whole grid fits at
 * a readable zoom, fit it (≤ 100%). Otherwise show the most whole columns that fit at a readable
 * zoom, centered under the main agent, choosing a zoom at which the neighbor columns stay hidden
 * in the gutters, so the edges never show half a repo. Returns the zoom and the world x to center.
 */
export function initialView(width: number, l: Pick<LayoutResult, "bounds" | "cols">): { zoom: number; centerX: number } {
  const b = l.bounds
  const fitAll = (width - 2 * VIEW_PAD) / b.w
  if (fitAll >= READABLE_ZOOM) return { zoom: Math.min(1, fitAll), centerX: b.x + b.w / 2 }
  const pitch = GROUP_W + COL_GAP
  for (let k = l.cols - 1; k >= 1; k--) {
    const span = k * pitch - COL_GAP
    // the k columns fit with padding …
    const hi = Math.min(MAX_INITIAL_ZOOM, (width - 2 * VIEW_PAD) / span)
    // … and the side margins are no wider than a gutter, so no neighbor column peeks in
    const lo = Math.max(READABLE_ZOOM, width / (span + 2 * COL_GAP))
    if (lo > hi) continue
    const start = Math.floor((l.cols - k) / 2)
    return { zoom: Math.min(hi, Math.max(lo, 1)), centerX: start * pitch + span / 2 }
  }
  return { zoom: 1, centerX: b.x + b.w / 2 }
}

/** typical card height, for the column-count estimate only */
const AVG_CARD_H = 72

/**
 * Column count, chosen once when the map is created (UI_PLAN §5.1). Small workspaces fit the
 * viewport width at a readable full-LOD zoom; large ones get a grid whose overall shape matches
 * the viewport, so "fit" lands on a usable compact/overview zoom instead of a thin strip.
 */
export function columnsFor(s: AppState, width: number, height: number) {
  const n = s.repoOrder.length
  const byWidth = Math.max(2, Math.floor((width / INITIAL_ZOOM_TARGET + COL_GAP) / (GROUP_W + COL_GAP)))
  if (n <= 16) return Math.min(byWidth, Math.max(2, n))
  let total = 0
  for (const repoId of s.repoOrder) {
    let active = 0
    let idle = 0
    for (const id of s.sessionIdsByRepo[repoId] ?? []) {
      const x = s.sessions[id]
      if (!x || !isVisibleLive(x)) continue
      if (isIdleish(x)) idle++
      else active++
    }
    total += HEADER_H + GROUP_PAD * 2 + active * (AVG_CARD_H + GAP) + (idle ? STACK_H + STACK_LAYERS + GAP : 0) + COL_GAP
  }
  const target = width / Math.max(1, height)
  let best = byWidth
  let bestErr = Infinity
  for (let c = byWidth; c <= 16; c++) {
    const err = Math.abs(Math.log((c * (GROUP_W + COL_GAP)) / (total / c) / target))
    if (err < bestErr) {
      bestErr = err
      best = c
    }
  }
  return best
}
