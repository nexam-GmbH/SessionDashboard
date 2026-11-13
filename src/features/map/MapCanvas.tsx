// Map canvas: React Flow 12 (MIT) wired to the store.
// - `nodes`/`edges` hold structure only and change only when the layout changes (structure hash).
// - LOD tier comes from a boolean-style zoom selector; at overview the cards are `hidden`.
// - Interactions: click selects, double-click / Enter opens, right-click menu, NodeToolbar on the
//   selected card, arrows move spatially, Space collapses, F fits, N next waiting, L links.
// - Calm UI (UI_PLAN §2.5): opens at 100% so card text is readable; details show in a hover
//   glance after 450ms; the minimap toggle lives in the toolbar's View menu.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  useReactFlow,
  useStore,
  useStoreApi,
  type Node,
  type NodeMouseHandler,
  type ReactFlowState,
} from "@xyflow/react"
import { getApp, useApp } from "@/store/app"
import { openRepo, openSession, patchMap, select, toggleRepoCollapsed, toggleStack, toggleSubagents } from "@/store/actions"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { ZoomSlider } from "@/components/flow/zoom-slider"
import type { ID } from "@/lib/model"
import { STATUS_COLOR } from "@/lib/status"
import { CARD_W, columnsFor, computeLayout, initialView, TITLE_FONT, titleFontReady, type LayoutResult, type MapEdge, type MapNode, type NavRect } from "./layout"
import { COMPACT_ZOOM, tierSelector } from "./lod"
import { getMapLocal, requestFocus, revealOnMap, seedMapDefaults, setMapLocal, useMapLocal } from "./mapStore"
import { nextAttention, pickInDirection, type Dir } from "./nav"
import { useProgressiveReveal } from "./reveal"
import { MapContextMenu, type MapTarget } from "./NodeActions"
import { MapToolbar, type SearchItem } from "./MapToolbar"
import { SessionGlance } from "./nodes/SessionNode"
import { GLANCE_DELAY } from "@/components/flow/node-tooltip"
import { edgeTypes, nodeTypes } from "./registry"

const EMPTY_NODES: MapNode[] = []
/** node count above which off-screen nodes are culled (and cards are revealed progressively) */
const CULL_ABOVE = 200
/**
 * One stable hidden copy per layout node, so React Flow skips unchanged nodes between reveal steps.
 * Without handle anchors, so edges into a hidden card aren't drawn (React Flow doesn't hide them).
 */
const hiddenCopies = new WeakMap<MapNode, MapNode>()
function hiddenCopy(n: MapNode): MapNode {
  let h = hiddenCopies.get(n)
  if (!h) {
    h = { ...n, hidden: true, handles: undefined }
    hiddenCopies.set(n, h)
  }
  return h
}
const EMPTY_EDGES: MapEdge[] = []
const ARROWS: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }

function isTyping(el: HTMLElement | null) {
  if (!el) return false
  if (el.closest(".xterm")) return true
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable
}

export function MapCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState<number | null>(null)
  const [ready, setReady] = useState(false)
  const rf = useReactFlow<MapNode, MapEdge>()
  const storeApi = useStoreApi<MapNode, MapEdge>()
  const getStoreState = storeApi.getState

  // column count fits the viewport width at creation, then stays put (stable layout). The first
  // layout waits (briefly) for the UI font, because card heights depend on measured title lines.
  useLayoutEffect(() => {
    seedMapDefaults()
    if (cols != null) return
    let done = false
    const go = () => {
      if (done) return
      done = true
      const el = wrapRef.current
      setCols(columnsFor(getApp(), el?.clientWidth || 1100, el?.clientHeight || 800))
    }
    if (titleFontReady() || typeof document === "undefined" || !document.fonts) {
      go()
      return
    }
    void document.fonts.load(TITLE_FONT).then(go, go)
    const t = window.setTimeout(go, 400)
    return () => {
      done = true
      window.clearTimeout(t)
    }
  }, [cols])

  // ---------- layout (structure only) ----------
  const structVersion = useApp((s) => s.structVersion)
  const collapsedRepos = useApp((s) => s.map.collapsedRepos)
  const expandedStacks = useApp((s) => s.map.expandedStacks)
  const expandedSubagents = useApp((s) => s.map.expandedSubagents)
  const historyRange = useApp((s) => s.map.historyRange)
  const statusFilter = useApp((s) => s.map.statusFilter)
  const repoFilter = useApp((s) => s.map.repoFilter)
  // a status filter is a status-defined view, so it may re-evaluate on status changes
  const statusTick = useApp((s) => (s.map.statusFilter.length ? s.statusVersion : 0))
  const layout = useMemo<LayoutResult | null>(
    () =>
      cols == null
        ? null
        : computeLayout(getApp(), { collapsedRepos, expandedStacks, expandedSubagents, historyRange, statusFilter, repoFilter }, cols),
    // structVersion / statusTick are the triggers; the store snapshot is read inside
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cols, structVersion, statusTick, collapsedRepos, expandedStacks, expandedSubagents, historyRange, statusFilter, repoFilter],
  )
  const layoutRef = useRef(layout)
  useLayoutEffect(() => {
    layoutRef.current = layout
    if (layout && getMapLocal().stacks !== layout.stacks) setMapLocal({ stacks: layout.stacks })
  }, [layout])

  // ---------- LOD: hide cards at overview (Dagster groups-only) ----------
  const overview = useStore(tierSelector) === "overview"
  // large maps: zooming back in from overview un-hides the cards in view a few per frame (reveal.ts)
  const culled = (layout?.nodes.length ?? 0) > CULL_ABOVE
  const revealed = useProgressiveReveal(layout, overview, culled, getStoreState)
  const nodes = useMemo(() => {
    if (!layout) return EMPTY_NODES
    if (!overview && !revealed) return layout.nodes
    return layout.nodes.map((n) => (n.type === "repo" || n.type === "main" || revealed?.has(n.id) ? n : hiddenCopy(n)))
  }, [layout, overview, revealed])

  const showLinks = useApp((s) => s.map.showLinks)
  const selectedRepo = useApp((s) => (s.selection?.kind === "repo" ? s.selection.id : null))
  const edges = useMemo(() => {
    if (!layout) return EMPTY_EDGES
    const base = overview ? layout.edges.filter((e) => e.data?.kind === "hierarchy") : layout.edges
    const links = showLinks ? layout.linkEdges : selectedRepo ? layout.linkEdges.filter((e) => e.source === selectedRepo || e.target === selectedRepo) : EMPTY_EDGES
    return links.length ? [...base, ...links] : base
  }, [layout, overview, showLinks, selectedRepo])

  // ---------- initial viewport: top of the map at a readable zoom ----------
  // Whole grid when it fits at a readable zoom; otherwise the most whole repo columns that fit,
  // centered under the main agent, never half a column at an edge (layout.ts `initialView`).
  const didInit = useRef(false)
  useEffect(() => {
    if (!layout || !ready || didInit.current) return
    didInit.current = true
    const W = wrapRef.current?.clientWidth ?? 1000
    const { zoom, centerX } = initialView(W, layout)
    // 44px of top margin leaves room for the selection toolbar above the main agent card
    void rf.setViewport({ x: W / 2 - centerX * zoom, y: 44, zoom })
  }, [layout, ready, rf])

  // ---------- focus requests (search, N, keyboard) ----------
  const focus = useMapLocal((s) => s.focus)
  const handledFocus = useRef(0)
  useEffect(() => {
    if (!focus || !layout || focus.seq === handledFocus.current) return
    const r = layout.rects.get(focus.id)
    if (!r) return
    handledFocus.current = focus.seq
    const zoom = Math.min(1, Math.max(rf.getZoom(), 0.8))
    requestAnimationFrame(() => void rf.setCenter(r.x + r.w / 2, r.y + Math.min(r.h, 400) / 2, { zoom, duration: 350 }))
  }, [focus, layout, rf])

  // ---------- selection helpers ----------
  const selectNode = useCallback((id: ID, r: NavRect, reveal: boolean) => {
    if (r.type === "stack") {
      select(null)
      setMapLocal({ cursor: id })
    } else {
      setMapLocal({ cursor: null })
      select({ kind: r.type === "main" ? "session" : r.type === "repo" ? "repo" : r.type === "subagent" ? "subagent" : "session", id })
    }
    if (!reveal) return
    const { transform, width, height } = getStoreState()
    const [tx, ty, k] = transform
    const sx = r.x * k + tx
    const sy = r.y * k + ty
    const visible = sx >= 0 && sy >= 0 && sx + r.w * k <= width && sy + Math.min(r.h, 240) * k <= height
    if (!visible) void rf.setCenter(r.x + r.w / 2, r.y + Math.min(r.h, 300) / 2, { zoom: k, duration: 200 })
  }, [rf, getStoreState])

  const currentId = useCallback((): ID | null => {
    const l = layoutRef.current
    if (!l) return null
    const sel = getApp().selection
    if (sel && l.rects.has(sel.id)) return sel.id
    const cursor = getMapLocal().cursor
    return cursor && l.rects.has(cursor) ? cursor : null
  }, [])

  const jumpNext = useCallback(() => {
    const t = nextAttention(getApp().selection?.id ?? null)
    if (!t) return
    revealOnMap(t.kind, t.id)
    select({ kind: t.kind, id: t.id })
    setMapLocal({ cursor: null })
    requestFocus(t.id)
  }, [])

  const fit = useCallback(() => void rf.fitView({ padding: 0.06, duration: 250 }), [rf])

  // Selecting something opens the inspector beside the canvas, which narrows it and can leave the
  // selected card under the new edge. When the canvas size settles, pan by the minimum that brings
  // the selected node (or keyboard cursor) fully back into view, at the same zoom; only if it was
  // in view before the resize (a node the user panned away from stays away).
  useEffect(() => {
    let timer = 0
    let before: { width: number; height: number } | null = null
    const unsub = storeApi.subscribe((st, prev) => {
      if (st.width === prev.width && st.height === prev.height) return
      if (!prev.width || !prev.height) return
      before ??= { width: prev.width, height: prev.height }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const was = before!
        before = null
        const id = currentId()
        const r = id ? layoutRef.current?.rects.get(id) : undefined
        if (!r) return
        const { transform, width, height } = getStoreState()
        const [tx, ty, k] = transform
        const sx = r.x * k + tx
        const sy = r.y * k + ty
        const sw = r.w * k
        const sh = Math.min(r.h, 400) * k
        if (sx > was.width || sx + sw < 0 || sy > was.height || sy + sh < 0) return
        const M = 12
        const dx = sx + sw > width - M ? Math.max(M - sx, width - M - (sx + sw)) : sx < M ? M - sx : 0
        const dy = sy + sh > height - M ? Math.max(M - sy, height - M - (sy + sh)) : sy < M ? M - sy : 0
        if (dx || dy) void rf.setViewport({ x: tx + dx, y: ty + dy, zoom: k }, { duration: 200 })
      }, 120)
    })
    return () => {
      unsub()
      window.clearTimeout(timer)
    }
  }, [storeApi, getStoreState, currentId, rf])

  // Tab can move focus into a card button that is off the canvas (cards outside the viewport stay
  // mounted near its edges): undo the browser's scroll-into-view of the overflow-hidden flow and
  // pan the focused card into view instead.
  const onFocusCapture = useCallback((e: React.FocusEvent) => {
    const t = e.target as HTMLElement
    const el = t.closest(".react-flow__node")
    const wrap = wrapRef.current
    if (!el || !wrap || t === wrap) return
    for (let p: HTMLElement | null = t; p && p !== wrap; p = p.parentElement) {
      if (p.scrollTop) p.scrollTop = 0
      if (p.scrollLeft) p.scrollLeft = 0
    }
    const id = el.getAttribute("data-id")
    const n = id ? getStoreState().nodeLookup.get(id) : undefined
    if (!n) return
    const { transform, width, height } = getStoreState()
    const [tx, ty, k] = transform
    const { x, y } = n.internals.positionAbsolute
    const w = (n.width ?? n.measured.width ?? 0) * k
    const h = Math.min(n.height ?? n.measured.height ?? 0, 400) * k
    const sx = x * k + tx
    const sy = y * k + ty
    if (sx >= 0 && sy >= 0 && sx + w <= width && sy + h <= height) return
    void rf.setCenter(x + w / k / 2, y + h / k / 2, { zoom: k, duration: 200 })
  }, [getStoreState, rf])

  const toggleAt = useCallback((id: ID) => {
    const l = layoutRef.current
    const r = l?.rects.get(id)
    if (!l || !r) return
    const st = getApp()
    if (r.type === "repo") toggleRepoCollapsed(id)
    else if (r.type === "stack" && r.repoId) toggleStack(r.repoId)
    else if (r.type === "subagent") {
      const sub = st.subagents[id]
      if (sub) {
        toggleSubagents(sub.sessionId)
        select({ kind: "session", id: sub.sessionId })
      }
    } else if (r.type === "session") {
      if (st.subagentIdsBySession[id]?.length) toggleSubagents(id)
      else if (r.repoId && getMapLocal().stacks[r.repoId]?.expanded) {
        const meta = getMapLocal().stacks[r.repoId]
        if (meta.idle.includes(id) || meta.history.includes(id)) {
          toggleStack(r.repoId)
          select(null)
          setMapLocal({ cursor: `stack:${r.repoId}` })
        }
      }
    }
  }, [])

  const openAt = useCallback((id: ID) => {
    const r = layoutRef.current?.rects.get(id)
    if (!r) return
    if (r.type === "session" || r.type === "main") openSession(id)
    else if (r.type === "repo") openRepo(id)
    else if (r.type === "stack" && r.repoId) toggleStack(r.repoId)
    else if (r.type === "subagent") {
      const sub = getApp().subagents[id]
      if (sub) openSession(sub.sessionId)
    }
  }, [])

  // ---------- keyboard (window capture, so map keys win over the global map while focused) ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target instanceof HTMLElement ? e.target : null
      const inMap = !!t && !!wrapRef.current?.contains(t)
      if (!inMap && t !== document.body) return
      const st = getApp()
      if (isTyping(t) || st.paletteOpen || st.newSession || document.querySelector("[role=dialog],[role=menu]")) return
      const l = layoutRef.current
      if (!l) return
      const key = e.key
      let handled = true
      if (ARROWS[key]) {
        const cur = currentId()
        const ov = tierSelector(getStoreState() as unknown as ReactFlowState) === "overview"
        const allow = (r: NavRect) => !ov || r.type === "repo" || r.type === "main"
        const next = cur ? pickInDirection(l.rects, cur, ARROWS[key], allow) : st.mainSessionId
        if (next) selectNode(next, l.rects.get(next)!, true)
      } else if (key === "Enter") {
        const cur = currentId()
        if (cur) openAt(cur)
      } else if (key === " ") {
        const cur = currentId()
        if (cur) toggleAt(cur)
      } else if (key === "Escape") {
        if (!st.selection && !getMapLocal().cursor) handled = false
        select(null)
        setMapLocal({ cursor: null })
      } else if (key === "f" || key === "F") fit()
      else if (key === "n" || key === "N") jumpNext()
      else if (key === "l" || key === "L") patchMap({ showLinks: !st.map.showLinks })
      else handled = false
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [currentId, fit, jumpNext, openAt, selectNode, toggleAt, getStoreState])

  // ---------- mouse ----------
  const onNodeClick: NodeMouseHandler<MapNode> = useCallback((_, node) => {
    const r = layoutRef.current?.rects.get(node.id)
    if (!r) return
    wrapRef.current?.focus({ preventScroll: true })
    if (node.type === "stack") {
      setMapLocal({ cursor: node.id })
      select(null)
      toggleStack(node.data.id)
      return
    }
    selectNode(node.id, r, false)
  }, [selectNode])

  const onNodeDoubleClick: NodeMouseHandler<MapNode> = useCallback((_, node) => openAt(node.id), [openAt])

  // one shared hover glance: the details line under a card at full LOD (Calm UI: details on
  // demand), the readable card plus details at compact LOD
  // No glance opens in the middle of a pan or zoom gesture (its mode follows the zoom tier at the
  // moment it opens, and the gesture carries the card away from it).
  const [glance, setGlance] = useState<{ id: ID; mode: "meta" | "card"; left: boolean } | null>(null)
  const glanceTimer = useRef<number | undefined>(undefined)
  const moving = useRef(false)
  const onNodeMouseEnter: NodeMouseHandler<MapNode> = useCallback((_, node) => {
    window.clearTimeout(glanceTimer.current)
    if (node.type !== "session" && node.type !== "main") return
    glanceTimer.current = window.setTimeout(() => {
      if (moving.current) return
      const st = getStoreState()
      const tier = tierSelector(st as unknown as ReactFlowState)
      const mode = tier === "full" ? "meta" : tier === "compact" && node.type === "session" ? "card" : null
      if (!mode) return
      setGlance({ id: node.id, mode, left: glanceOnLeft(st, node.id, wrapRef.current) })
    }, GLANCE_DELAY)
  }, [getStoreState])
  const hideGlance = useCallback(() => {
    window.clearTimeout(glanceTimer.current)
    setGlance(null)
  }, [])
  const onMoveStart = useCallback(() => {
    moving.current = true
    hideGlance()
  }, [hideGlance])
  const onMoveEnd = useCallback(() => {
    moving.current = false
  }, [])

  // overview labels size themselves from --map-zoom; only written while zoomed far out
  const onMove = useCallback((_: unknown, vp: { zoom: number }) => {
    const el = wrapRef.current
    if (el && vp.zoom < COMPACT_ZOOM) el.style.setProperty("--map-zoom", vp.zoom.toFixed(3))
  }, [])

  const onPaneClick = useCallback(() => {
    wrapRef.current?.focus({ preventScroll: true })
    select(null)
    setMapLocal({ cursor: null })
  }, [])

  const ctxRef = useRef<MapTarget | null>(null)
  const [ctxTarget, setCtxTarget] = useState<MapTarget | null>(null)
  const onContextMenuCapture = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest(".react-flow__node")
    const id = el?.getAttribute("data-id")
    const r = id ? layoutRef.current?.rects.get(id) : undefined
    ctxRef.current = id && r ? { type: r.type, id: r.type === "stack" ? r.repoId! : id } : null
    if (id && r && r.type !== "stack") selectNode(id, r, false)
  }, [selectNode])

  const minimap = useMapLocal((s) => s.minimap)

  return (
    <div className="sd-map flex h-full min-h-0 flex-col bg-canvas">
      <MapToolbar onSearchSelect={useSearchSelect()} />
      <ContextMenu onOpenChange={(o) => setCtxTarget(o ? ctxRef.current : null)}>
        <ContextMenuTrigger asChild>
          <div
            ref={wrapRef}
            tabIndex={0}
            aria-label="Agent map. Arrow keys move between cards, Enter opens, Space expands or collapses, F fits, N goes to the next waiting card, L shows repo links"
            // outline, not an inset ring: the flow's opaque background covers an inset box-shadow
            className="sd-map-canvas relative min-h-0 flex-1 outline-none focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring/60"
            onFocusCapture={onFocusCapture}
            onContextMenuCapture={onContextMenuCapture}
            onContextMenu={(e) => {
              if (!ctxRef.current) e.preventDefault()
            }}
          >
            {layout && (
              <ReactFlow<MapNode, MapEdge>
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={() => setReady(true)}
                onNodeClick={onNodeClick}
                onNodeDoubleClick={onNodeDoubleClick}
                onNodeMouseEnter={onNodeMouseEnter}
                onNodeMouseLeave={hideGlance}
                onMoveStart={onMoveStart}
                onMoveEnd={onMoveEnd}
                onPaneClick={onPaneClick}
                onMove={onMove}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                nodesFocusable={false}
                edgesFocusable={false}
                zoomOnDoubleClick={false}
                deleteKeyCode={null}
                selectionKeyCode={null}
                multiSelectionKeyCode={null}
                panActivationKeyCode={null}
                zoomActivationKeyCode={null}
                // measured on the stress fixture (445 nodes): culling off-screen cards cuts the cost of an
                // LOD switch from ~900ms to a few visible cards; small workspaces render everything
                onlyRenderVisibleElements={culled}
                minZoom={0.04}
                maxZoom={1.5}
                colorMode="dark"
                attributionPosition="bottom-left"
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border-default)" />
                <ZoomSlider position="bottom-right" onFit={fit} slider={false} />
                {glance && <SessionGlance id={glance.id} mode={glance.mode} left={glance.left} />}
                {minimap && (
                  <MiniMap<MapNode>
                    position="bottom-right"
                    style={{ bottom: 40, width: 200, height: 140 }}
                    pannable
                    zoomable
                    nodeColor={minimapColor}
                    nodeStrokeWidth={0}
                    nodeBorderRadius={2}
                  />
                )}
              </ReactFlow>
            )}
          </div>
        </ContextMenuTrigger>
        <MapContextMenu target={ctxTarget} />
      </ContextMenu>
    </div>
  )
}

/** width of the hover glance (SessionGlance) and its gap to the card */
const GLANCE_W = CARD_W + 10

/**
 * Which side of a card the hover glance opens on: the side with room for it inside the canvas
 * (the inspector narrows the canvas on the right), else the roomier one.
 */
function glanceOnLeft(st: ReactFlowState<MapNode, MapEdge>, id: ID, canvas: HTMLElement | null) {
  const n = st.nodeLookup.get(id)
  if (!n) return false
  const [tx, , k] = st.transform
  const width = canvas?.getBoundingClientRect().width ?? st.width
  const sx = n.internals.positionAbsolute.x * k + tx
  const right = width - (sx + (n.width ?? n.measured.width ?? 0) * k)
  if (right >= GLANCE_W) return false
  return sx >= GLANCE_W || sx > right
}

function minimapColor(n: Node) {
  if (n.type === "repo") return "#212225"
  if (n.type === "main") return "#43484e"
  if (n.type === "session") {
    const s = getApp().sessions[n.id]
    return s ? STATUS_COLOR[s.status] : "#363a3f"
  }
  return "#2e3135"
}

/** Search result → reveal (expand containers), select, center. */
function useSearchSelect() {
  return useCallback((item: SearchItem) => {
    revealOnMap(item.kind, item.id)
    if (item.kind === "repo") select({ kind: "repo", id: item.id })
    else select({ kind: item.kind, id: item.id })
    setMapLocal({ cursor: null })
    requestFocus(item.id)
  }, [])
}
