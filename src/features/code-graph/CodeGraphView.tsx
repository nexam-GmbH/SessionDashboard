// Code graph view — UI_PLAN §5.6. Adapted from HKUDS/LightRAG@377cd24:
// lightrag_webui/src/{features/GraphViewer.tsx, components/graph/{GraphControl,GraphSearch,
// FocusOnNode,Legend,ZoomControl}.tsx} (MIT): ForceAtlas2 in a Web Worker with inferred
// settings and a time budget, hover/selection neighborhood highlight via node/edge reducers,
// hideEdgesOnMove, label size threshold, search with camera focus, legend.
// Modified for session-dashboard: sigma v4 (WebGL2, passed the M0 check), Graphify graph.json
// data (RESEARCH §5), community aggregation above 5k nodes with drill-down into a subset graph
// (Graphify viewer behavior), our tokens and IDE layout (communities/filters left, inspector right).
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { setNewSessionPrefill } from "@/features/new-session/prefill"
import { clearGraphIntent, peekGraphIntent, useGraphIntent } from "./graphIntent"
import Graph from "graphology"
import type { Attributes } from "graphology-types"
import type forceAtlas2 from "graphology-layout-forceatlas2"
import type FA2LayoutSupervisor from "graphology-layout-forceatlas2/worker"
import type { Sigma as SigmaType } from "sigma"
import {
  ArrowLeft,
  ChevronDown,
  Ellipsis,
  ListFilter,
  LoaderCircle,
  Crosshair,
  FolderGit2,
  Maximize,
  Minus,
  Pause,
  Play,
  Plus,
  Search,
  Waypoints,
  X,
  MessageSquarePlus,
  FileCode,
} from "lucide-react"
import { getApp, useApp } from "@/store/app"
import { openGraph, openNewSession, togglePanel } from "@/store/actions"
import { Button } from "@/components/ui/button"
import { EmptyState, Kbd } from "@/components/common/bits"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { compact } from "@/lib/format"
import { cn } from "@/lib/utils"
import { fuzzyScore } from "@/features/palette/commands"
import { COMMUNITY_COLORS, graphTheme, loadGraph, toCommunityGraph, toGraphology, type GLink, type GNode, type GraphJson } from "./graphData"

/** Graphify's own viewer aggregates above this many visible nodes. */
const AGGREGATE_ABOVE = 5000
const RELATIONS: GLink["relation"][] = ["calls", "uses", "contains", "method", "inherits", "imports_from"]
const CONFIDENCE: GLink["confidence"][] = ["EXTRACTED", "INFERRED", "AMBIGUOUS"]
const positionCache = new Map<string, Map<string, { x: number; y: number }>>()
type IForceAtlas2Layout = typeof forceAtlas2
/** label size in the node graph; the community graph's labels are one size larger */
const NODE_LABEL_SIZE = 11
const COMMUNITY_LABEL = { labelSize: 12 }
/** sigma settings that differ between the community overview and the node graph */
const MODE_SETTINGS = {
  communities: { labelRenderedSizeThreshold: 0, labelDensity: 1, stagePadding: 48 },
  nodes: { labelRenderedSizeThreshold: 6, labelDensity: 0.6, stagePadding: 30 },
} as const
/** main-thread time per frame for adding nodes/edges to the renderer's graph */
const POPULATE_SLICE_MS = 8
/** printable ASCII plus the separators our labels use, rasterized when a renderer is set up */
const GLYPHS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("") + "·…"
const GLYPH_SLICE = 12
const GLYPH_PROBE = "__glyphs"
/** renderers killed by an effect cleanup (a stale state value must never be built into) */
const deadRenderers = new WeakSet<object>()

type Mode = "nodes" | "communities"

export default function CodeGraphView({ scope }: { scope: string }) {
  const repos = useApp((s) => s.repos)
  const repoOrder = useApp((s) => s.repoOrder)
  const [data, setData] = useState<GraphJson | null>(null)
  const [mode, setMode] = useState<Mode>("nodes")
  const [hiddenComms, setHiddenComms] = useState<Set<number>>(new Set())
  const [relations, setRelations] = useState<Set<string>>(new Set(RELATIONS))
  const [confidence, setConfidence] = useState<Set<string>>(new Set(CONFIDENCE))
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState(() => peekGraphIntent(scope))
  const [activeResult, setActiveResult] = useState(0)
  const [layoutRunning, setLayoutRunning] = useState(false)
  const [showReport, setShowReport] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sigmaRef = useRef<SigmaType | null>(null)
  const graphRef = useRef<Graph | null>(null)
  const hoveredRef = useRef<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  const neighborsRef = useRef<Set<string>>(new Set())
  const filtersRef = useRef({ hiddenComms, relations, confidence })
  const layoutRef = useRef<{ start: () => void; stop: () => void; kill: () => void } | null>(null)
  /** (re)start ForceAtlas2 for the current graph; set by the build effect */
  const startLayoutRef = useRef<(() => void) | null>(null)
  /** node to select + frame once the (re)built graph is ready (search → drill-down) */
  const pendingFocusRef = useRef<string | null>(null)
  const big = useMemo(() => {
    try {
      return Number(new URLSearchParams(location.search).get("graphNodes") ?? 0)
    } catch {
      return 0
    }
  }, [])

  // "/" focuses the symbol search from anywhere while this tab is visible (effects are torn down
  // while hidden under <Activity>), not only after clicking into the view
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (document.querySelector("[role=dialog],[role=menu]")) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // a search started elsewhere ("Find … in code graph" in the palette): picked up at mount
  // (initial query) or while mounted (subscription), then cleared
  useEffect(() => {
    // arrived with a query: focus the field so Enter opens the first match
    if (peekGraphIntent(scope)) searchRef.current?.focus()
    clearGraphIntent(scope)
    return useGraphIntent.subscribe((s, prev) => {
      if (s.seq === prev.seq || s.scope !== scope || !s.query) return
      setQuery(s.query)
      setActiveResult(0)
      clearGraphIntent(scope)
      searchRef.current?.focus()
    })
  }, [scope])

  // load data (scope never changes for a mounted view: each scope is its own tab)
  useEffect(() => {
    let alive = true
    void loadGraph(scope, big).then((d) => {
      if (!alive) return
      setData(d)
      setMode(d.nodes.length > AGGREGATE_ABOVE ? "communities" : "nodes")
    })
    return () => {
      alive = false
    }
  }, [scope, big])

  // Large graphs: the node view renders only the visible communities (a subset graph), and only
  // while that subset stays under the aggregation cutoff. Small graphs filter in the reducers.
  const isLarge = !!data && data.nodes.length > AGGREGATE_ABOVE
  const visibleCount = useMemo(
    () => (data ? data.communities.reduce((n, c) => n + (hiddenComms.has(c.id) ? 0 : c.size), 0) : 0),
    [data, hiddenComms],
  )
  const nodesAllowed = !isLarge || visibleCount <= AGGREGATE_ABOVE
  const effMode: Mode = mode === "nodes" && !nodesAllowed ? "communities" : mode
  const subsetKey =
    isLarge && effMode === "nodes" && data
      ? data.communities.filter((c) => !hiddenComms.has(c.id)).map((c) => c.id).join(",")
      : "all"

  const frame = (ids: string[], duration = 450) => {
    const r = sigmaRef.current
    if (!r || !ids.length) return
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const id of ids) {
      const d = r.getNodeDisplayData(id)
      if (!d) continue
      x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x); y1 = Math.max(y1, d.y)
    }
    if (!Number.isFinite(x0)) return
    const ratio = Math.min(1.1, Math.max(0.08, Math.max(x1 - x0, y1 - y0) * 1.2))
    void r.getCamera().animate({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, ratio }, { duration })
  }

  const applySelection = (id: string | null) => {
    const g = graphRef.current
    // the node panel is this view's inspector: don't squeeze the canvas between two side panels
    if (id && getApp().panels.inspector) togglePanel("inspector", false)
    selectedRef.current = id
    neighborsRef.current = id && g?.hasNode(id) ? new Set(g.neighbors(id)) : new Set()
    setSelected(id)
    sigmaRef.current?.refresh({ skipIndexation: true })
  }

  const focusNode = (id: string) => {
    const g = graphRef.current
    if (!g || !g.hasNode(id)) return
    applySelection(id)
    frame([id, ...neighborsRef.current])
  }

  /** Show only one community in the node view (community node click, legend double-click). */
  const drill = (communityId: number) => {
    if (!data) return
    setHiddenComms(new Set(data.communities.filter((c) => c.id !== communityId).map((c) => c.id)))
    setMode("nodes")
  }

  // ---------- sigma: one renderer per mounted view ----------
  // A renderer's fixed cost (WebGL program compilation, canvases, label glyphs) is paid once per
  // mounted view, in its own task. Every graph the view shows afterwards (communities, a drilled-in
  // community, community filters) is written into that renderer's one graph (mixed type: the
  // community graph is undirected, the node graph directed), cleared and refilled a time slice per
  // frame, so no single task processes thousands of nodes. (sigma 4.0.6's `setGraph` keeps its
  // parallel-edge index on the old graph, so the graph object itself is kept.) The reducers and
  // handlers are installed once and read the current mode, filters, focus and actions through refs.
  const [renderer, setRenderer] = useState<SigmaType | null>(null)
  const libsRef = useRef<{ fa2: IForceAtlas2Layout; Supervisor: typeof FA2LayoutSupervisor } | null>(null)
  const modeRef = useRef<Mode>(effMode)
  /** `${mode}:${subset}` of the graph in the renderer (or being populated) */
  const builtKeyRef = useRef("")
  /** stops the label glyph warm-up of a new renderer (the first build takes over the graph) */
  const stopWarmRef = useRef<(() => void) | null>(null)
  const actionsRef = useRef({ drill, applySelection })
  useLayoutEffect(() => {
    actionsRef.current = { drill, applySelection }
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let killed = false
    let r: SigmaType | null = null
    let warmRaf = 0
    void (async () => {
      const [{ Sigma, DEFAULT_STYLES }, fa2mod, workerMod] = await Promise.all([
        import("sigma"),
        import("graphology-layout-forceatlas2"),
        import("graphology-layout-forceatlas2/worker"),
      ])
      if (killed) return
      libsRef.current = { fa2: fa2mod.default, Supervisor: workerMod.default }
      const t = graphTheme()
      const dimNode = { color: t.dimNode, labelVisibility: "hidden" as const, zIndex: 0 }
      const hidden = { visibility: "hidden" as const }
      const renderer = new Sigma(new Graph(), container, {
        styles: {
          ...DEFAULT_STYLES,
          nodes: {
            ...DEFAULT_STYLES.nodes,
            labelColor: t.label,
            labelSize: NODE_LABEL_SIZE,
            labelFont: '"IBM Plex Sans Variable", "IBM Plex Sans", sans-serif',
            backdropColor: t.backdrop,
            backdropBorderColor: t.backdropBorder,
            backdropBorderWidth: 1,
            backdropShadowColor: "rgba(0, 0, 0, 0.45)",
            backdropShadowBlur: 8,
            backdropPadding: 4,
            backdropCornerRadius: 4,
          },
        },
        settings: {
          hideEdgesOnMove: true,
          hideLabelsOnMove: false,
          renderEdgeLabels: false,
          zoomingRatio: 1.4,
          enableNodeDrag: false,
          // sigma v4 defaults to sizes in graph units, which made the 24-node community graph
          // render 3x larger than the node graph; screen px keep both views consistent.
          itemSizesReference: "screen",
          ...MODE_SETTINGS.nodes,
        },
        // Reducers return small partials (sigma v4 merges them). The community graph's labels are
        // one size larger than the node graph's (the styles are fixed per renderer).
        nodeReducer: (key, d, attrs) => {
          const f = filtersRef.current
          if (f.hiddenComms.size && f.hiddenComms.has(attrs.community as number)) return hidden
          const focus = hoveredRef.current ?? selectedRef.current
          const comm = modeRef.current === "communities"
          if (!focus) return comm ? COMMUNITY_LABEL : d
          if (key === focus) return { zIndex: 2, labelVisibility: "visible", labelColor: t.labelFocus, size: d.size * 1.4, ...(comm ? COMMUNITY_LABEL : null) }
          if (neighborsRef.current.has(key)) return comm ? { zIndex: 1, labelVisibility: "visible", ...COMMUNITY_LABEL } : { zIndex: 1, labelVisibility: "visible" }
          return dimNode
        },
        edgeReducer: (key, d, attrs, _state, _graphState, graph) => {
          const f = filtersRef.current
          if (attrs.relation && f.relations.size < RELATIONS.length && !f.relations.has(attrs.relation as string)) return hidden
          if (attrs.confidence && f.confidence.size < CONFIDENCE.length && !f.confidence.has(attrs.confidence as string)) return hidden
          const focus = hoveredRef.current ?? selectedRef.current
          if (!f.hiddenComms.size && !focus) return d
          const [s, tg] = graph.extremities(key)
          if (f.hiddenComms.size) {
            const sc = graph.getNodeAttribute(s, "community") as number
            const tc = graph.getNodeAttribute(tg, "community") as number
            if (f.hiddenComms.has(sc) || f.hiddenComms.has(tc)) return hidden
          }
          if (focus) {
            if (s === focus || tg === focus) return { color: t.edgeFocus, size: Math.max(d.size, 1.1), zIndex: 1 }
            return hidden
          }
          return d
        },
      })
      r = renderer
      const setFocusNeighbors = (node: string | null) => {
        const g = graphRef.current
        neighborsRef.current = node && g?.hasNode(node) ? new Set(g.neighbors(node)) : new Set()
      }
      renderer.on("enterNode" as never, (({ node }: { node: string }) => {
        hoveredRef.current = node
        setFocusNeighbors(node)
        renderer.refresh({ skipIndexation: true })
      }) as never)
      renderer.on("leaveNode" as never, (() => {
        hoveredRef.current = null
        setFocusNeighbors(selectedRef.current)
        renderer.refresh({ skipIndexation: true })
      }) as never)
      renderer.on("clickNode" as never, (({ node }: { node: string }) => {
        const attrs = graphRef.current?.getNodeAttributes(node)
        if (!attrs) return
        if (attrs.isCommunity) {
          actionsRef.current.drill(attrs.community as number)
          return
        }
        hoveredRef.current = null
        actionsRef.current.applySelection(node)
      }) as never)
      renderer.on("clickStage" as never, (() => actionsRef.current.applySelection(null)) as never)
      sigmaRef.current = renderer
      // Label glyphs are rasterized on first use: 50-70 ms inside the first frame of the first
      // graph. While the graph data is still loading, rasterize the printable set a slice per
      // frame through a probe label on the hidden canvas; the first build stops this (it never
      // waits for it) and shows the canvas when its graph is complete.
      container.style.visibility = "hidden"
      const probe = renderer.getGraph()
      let at = 0
      const warm = () => {
        if (killed || at >= GLYPHS.length) return
        probe.clear()
        probe.addNode(GLYPH_PROBE, { x: 0, y: 0, size: 20, label: GLYPHS.slice(at, at + GLYPH_SLICE) })
        at += GLYPH_SLICE
        renderer.refresh()
        warmRaf = requestAnimationFrame(warm)
      }
      warmRaf = requestAnimationFrame(warm)
      stopWarmRef.current = () => {
        cancelAnimationFrame(warmRaf)
        stopWarmRef.current = null
      }
      setRenderer(renderer)
    })()
    // resize() clears the WebGL canvases; refresh() repaints (else the graph goes blank when a side panel closes)
    const ro = new ResizeObserver(() => {
      const r = sigmaRef.current
      if (!r) return
      r.resize()
      r.refresh()
    })
    ro.observe(container)
    return () => {
      killed = true
      cancelAnimationFrame(warmRaf)
      container.style.visibility = ""
      ro.disconnect()
      if (r) {
        deadRenderers.add(r)
        r.kill()
      }
      sigmaRef.current = null
      graphRef.current = null
      hoveredRef.current = null
    }
  }, [])

  // ---------- build the graph for the current mode into the renderer ----------
  useEffect(() => {
    const r = renderer
    const libs = libsRef.current
    const container = containerRef.current
    if (!data || !r || deadRenderers.has(r) || !libs || !container) return
    let cancelled = false
    let raf = 0
    let budgetTimer = 0
    const { fa2, Supervisor } = libs
    const cacheKey = `${scope}:${effMode}:${big}:${subsetKey}`
    const cached = positionCache.get(cacheKey)

    // the old graph leaves the screen at once (as a new renderer used to); the new one stays hidden
    // until complete, so no half-built frame shows. Camera and settings as a new renderer had them.
    stopWarmRef.current?.()
    const g = r.getGraph()
    builtKeyRef.current = `${effMode}:${subsetKey}`
    modeRef.current = effMode
    hoveredRef.current = null
    graphRef.current = g
    container.style.visibility = "hidden"
    // clear first: a settings change re-evaluates every node of the graph in the renderer
    g.clear()
    r.getCamera().cancelAnimation()
    r.getCamera().setState({ x: 0.5, y: 0.5, angle: 0, ratio: 1 })
    r.setSettings(MODE_SETTINGS[effMode])

    const pending = pendingFocusRef.current
    const finish = () => {
      if (pending && pendingFocusRef.current === pending && g.hasNode(pending)) {
        pendingFocusRef.current = null
        focusNode(pending)
      }
    }

    // ForceAtlas2 in a worker with a time budget (LightRAG GraphControl)
    const runLayout = (then?: () => void) => {
      if (cancelled) return
      if (!layoutRef.current) {
        layoutRef.current = new Supervisor(g, { settings: { ...fa2.inferSettings(g.order), linLogMode: true, outboundAttractionDistribution: true, scalingRatio: 24, gravity: 0.8, adjustSizes: false } })
      }
      const layout = layoutRef.current
      layout.start()
      setLayoutRunning(true)
      window.clearTimeout(budgetTimer)
      budgetTimer = window.setTimeout(() => {
        if (cancelled) return
        layout.stop()
        setLayoutRunning(false)
        const pos = new Map<string, { x: number; y: number }>()
        g.forEachNode((n, a) => pos.set(n, { x: a.x, y: a.y }))
        positionCache.set(cacheKey, pos)
        then?.()
      }, Math.min(6000, 1500 + g.order * 0.6))
    }

    const complete = () => {
      container.style.visibility = ""
      // dev/QA hook (scripts/perf-stress.mjs reads render stats from it)
      if (import.meta.env.DEV) (window as unknown as { __codeGraph?: unknown }).__codeGraph = { sigma: r, graph: g, mode: effMode }
      if (pending && g.hasNode(pending)) applySelection(pending)
      else if (selectedRef.current && !g.hasNode(selectedRef.current)) applySelection(null)
      startLayoutRef.current = effMode === "nodes" ? () => runLayout() : null
      if (!cached && effMode === "nodes") runLayout(finish)
      else requestAnimationFrame(finish)
    }

    // Next frame: build this mode's graph (communities, a drilled-in subset, or everything), off the
    // task of the click that asked for it, then populate the renderer's graph a time slice per
    // frame (sigma evaluates each added item right away and renders the batch on its next frame).
    let nodes: [string, Attributes][] = []
    let edges: [string, string, Attributes][] = []
    let undirected = false
    const build = () => {
      if (cancelled) return
      let full: Graph
      if (effMode === "communities") {
        full = toCommunityGraph(data, fa2)
      } else if (subsetKey !== "all") {
        const keep = new Set(subsetKey.split(",").map(Number))
        const subset = data.nodes.filter((n) => keep.has(n.community))
        const ids = new Set(subset.map((n) => n.id))
        full = toGraphology({ ...data, nodes: subset, links: data.links.filter((l) => ids.has(l.source) && ids.has(l.target)) })
      } else {
        full = toGraphology(data)
      }
      full.forEachNode((n, a) => {
        const p = cached?.get(n)
        nodes.push([n, p ? Object.assign(a, p) : a])
      })
      full.forEachEdge((_, a, s, t) => {
        edges.push([s, t, a])
      })
      undirected = full.type === "undirected"
      raf = requestAnimationFrame(step)
    }
    let ni = 0
    let ei = 0
    const step = () => {
      if (cancelled) return
      const t0 = performance.now()
      while (ni < nodes.length && performance.now() - t0 < POPULATE_SLICE_MS) {
        for (const end = Math.min(nodes.length, ni + 64); ni < end; ni++) g.addNode(nodes[ni][0], nodes[ni][1])
      }
      while (ni === nodes.length && ei < edges.length && performance.now() - t0 < POPULATE_SLICE_MS) {
        for (const end = Math.min(edges.length, ei + 128); ei < end; ei++) {
          const [a, b, attrs] = edges[ei]
          if (undirected) g.addUndirectedEdge(a, b, attrs)
          else g.addDirectedEdge(a, b, attrs)
        }
      }
      if (ni < nodes.length || ei < edges.length) raf = requestAnimationFrame(step)
      else {
        nodes = []
        edges = []
        complete()
      }
    }
    raf = requestAnimationFrame(build)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.clearTimeout(budgetTimer)
      container.style.visibility = ""
      layoutRef.current?.kill()
      layoutRef.current = null
      startLayoutRef.current = null
      setLayoutRunning(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, effMode, subsetKey, scope, big, renderer])

  // reducers read filters from a ref; sync it and re-render on filter changes, unless the same
  // change also selects another graph (drill in, back to all communities): the rebuild applies the
  // filters anyway, and re-evaluating the outgoing graph's thousands of nodes first was wasted
  const buildKey = `${effMode}:${subsetKey}`
  useLayoutEffect(() => {
    filtersRef.current = { hiddenComms, relations, confidence }
    if (builtKeyRef.current === buildKey) sigmaRef.current?.refresh({ skipIndexation: true, schedule: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenComms, relations, confidence])

  const deferredQuery = useDeferredValue(query)
  const results = useMemo(() => {
    const q = deferredQuery.trim()
    if (!data || !q) return []
    const top: { n: GNode; s: number }[] = []
    const exact = q.toLowerCase()
    for (const n of data.nodes) {
      let s = fuzzyScore(q, n.label)
      if (s <= 0) continue
      // the symbol itself ("withRetry" → withRetry()) before withRetryCache, withRetryError…
      if (n.label.toLowerCase().replace(/\(\)$/, "") === exact) s += 1000
      if (top.length < 8) top.push({ n, s })
      else if (s > top[7].s) top[7] = { n, s }
      else continue
      top.sort((a, b) => b.s - a.s)
    }
    return top.map((x) => x.n)
  }, [data, deferredQuery])

  const commIndex = useMemo(() => new Map(data?.communities.map((c, i) => [c.id, i]) ?? []), [data])
  const colorOf = (community: number) => COMMUNITY_COLORS[(commIndex.get(community) ?? 0) % COMMUNITY_COLORS.length]

  const openResult = (n: GNode) => {
    setQuery("")
    setActiveResult(0)
    const g = graphRef.current
    if (effMode === "nodes" && !hiddenComms.has(n.community) && g?.hasNode(n.id)) {
      focusNode(n.id)
      return
    }
    pendingFocusRef.current = n.id
    if (isLarge) drill(n.community)
    else {
      if (hiddenComms.has(n.community)) setHiddenComms((s) => { const x = new Set(s); x.delete(n.community); return x })
      setMode("nodes")
    }
  }

  const report = useMemo(() => {
    if (!data) return null
    const deg = new Map<string, number>()
    for (const l of data.links) {
      deg.set(l.source, (deg.get(l.source) ?? 0) + 1)
      deg.set(l.target, (deg.get(l.target) ?? 0) + 1)
    }
    const byId = new Map(data.nodes.map((n) => [n.id, n]))
    const god = [...deg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, d]) => ({ n: byId.get(id)!, d })).filter((x) => x.n)
    const surprising = data.links
      .filter((l) => byId.get(l.source)?.community !== byId.get(l.target)?.community && l.relation !== "contains")
      .slice(0, 3)
      .map((l) => ({ a: byId.get(l.source)!, b: byId.get(l.target)!, rel: l.relation, conf: l.confidence }))
    return { god, surprising }
  }, [data])

  const filterCount = RELATIONS.length - relations.size + (CONFIDENCE.length - confidence.size)
  const graphable = repoOrder.filter((id) => repos[id].graphify?.state && repos[id].graphify?.state !== "none")
  const scopeName = scope === "global" ? "All repos (global graph)" : (repos[scope]?.name ?? scope)
  const allVisible = hiddenComms.size === 0

  const onKeyDown = (e: React.KeyboardEvent) => {
    const typing = (e.target as HTMLElement).tagName === "INPUT"
    if (e.key === "Escape" && !typing && selected) {
      applySelection(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas" onKeyDown={onKeyDown}>
      {/* toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-subtle bg-chrome px-2 text-xs whitespace-nowrap text-fg hover:border-line">
            {scope === "global" ? <Waypoints size={13} className="text-fg-faint" /> : <FolderGit2 size={13} className="text-fg-faint" />}
            {scopeName}
            <ChevronDown size={12} className="text-fg-faint" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-y-auto">
            <DropdownMenuItem onSelect={() => openGraph("global")} className="text-xs">
              <Waypoints /> All repos (global graph)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {graphable.map((id) => (
              <DropdownMenuItem key={id} onSelect={() => openGraph(id)} className="text-xs">
                <FolderGit2 /> {repos[id].name}
                <span className="tabular ml-auto text-[10.5px] text-fg-faint">{compact(repos[id].graphify?.nodes ?? 0)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="relative w-56 shrink-0">
          <div className="flex h-7 items-center rounded-md border border-line-subtle bg-chrome px-2 focus-within:border-line-strong">
            <Search size={13} className="shrink-0 text-fg-faint" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActiveResult(0) }}
              placeholder="Find symbol or file…"
              className="h-full min-w-0 flex-1 bg-transparent pl-1.5 text-xs text-fg outline-none placeholder:text-fg-faint"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActiveResult((i) => Math.min(results.length - 1, i + 1)) }
                else if (e.key === "ArrowUp") { e.preventDefault(); setActiveResult((i) => Math.max(0, i - 1)) }
                else if (e.key === "Enter" && results[activeResult]) openResult(results[activeResult])
                else if (e.key === "Escape") { setQuery(""); e.currentTarget.blur() }
              }}
            />
            {query ? (
              <button onClick={() => setQuery("")} className="text-fg-faint hover:text-fg" aria-label="Clear search"><X size={12} /></button>
            ) : (
              <Kbd className="h-4 min-w-4 text-[10px]">/</Kbd>
            )}
          </div>
          {results.length > 0 && data && (
            <div className="absolute top-8 left-0 z-20 w-80 overflow-hidden rounded-md border border-line bg-elevated py-1 shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
              {results.map((n, i) => (
                <button
                  key={n.id}
                  onMouseEnter={() => setActiveResult(i)}
                  onClick={() => openResult(n)}
                  className={cn("flex h-7 w-full items-center gap-2 px-2.5 text-left text-xs", i === activeResult && "bg-selected")}
                >
                  <span className="size-2 shrink-0 rounded-full" style={{ background: colorOf(n.community) }} />
                  <span className="max-w-[65%] shrink-0 truncate font-mono text-[11px] text-fg">{n.label}</span>
                  {/* file, not community (the dot has the community color): tells same-named symbols apart */}
                  <span className="min-w-0 flex-1 truncate pl-2 text-right font-mono text-[10.5px] text-fg-faint" title={n.source_file}>
                    {n.label === n.source_file ? n.community_name : n.source_file}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center rounded-md border border-line-subtle bg-chrome p-0.5">
          {(["nodes", "communities"] as const).map((m) => {
            const disabled = m === "nodes" && !nodesAllowed
            return (
              <button
                key={m}
                disabled={disabled}
                onClick={() => setMode(m)}
                title={disabled ? `${compact(visibleCount)} nodes visible: drill into a community (click it) to see its nodes` : undefined}
                className={cn(
                  "h-6 rounded-sm px-2 text-xs disabled:cursor-not-allowed disabled:opacity-40",
                  effMode === m ? "bg-selected text-fg" : "text-fg-faint enabled:hover:text-fg-muted",
                )}
              >
                {m === "nodes" ? "Nodes" : "Communities"}
              </button>
            )
          })}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={effMode !== "nodes"}
            title={effMode !== "nodes" ? "Edge filters apply to the node view" : "Filter edges by relation and confidence"}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors disabled:opacity-40",
              filterCount ? "border-line bg-elevated text-fg" : "border-line-subtle text-fg-faint enabled:hover:text-fg-muted",
            )}
          >
            <ListFilter size={13} />
            Filter
            {filterCount > 0 && <span className="tabular rounded-sm bg-selected px-1 text-[10.5px]">{filterCount}</span>}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuLabel className="text-[11px] text-fg-faint">Relation</DropdownMenuLabel>
            {RELATIONS.map((r) => (
              <DropdownMenuCheckboxItem key={r} checked={relations.has(r)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => setRelations((s) => toggleSet(s, r))} className="font-mono text-[11px]">
                {r}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] text-fg-faint">Confidence</DropdownMenuLabel>
            {CONFIDENCE.map((c) => (
              <DropdownMenuCheckboxItem key={c} checked={confidence.has(c)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => setConfidence((s) => toggleSet(s, c))} className="text-xs">
                {c.charAt(0) + c.slice(1).toLowerCase()}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex items-center gap-1">
          {layoutRunning && <LoaderCircle size={13} className="animate-spin-slow text-fg-faint" aria-label="Layout running" />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More" title="More">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem
                className="text-xs"
                disabled={effMode !== "nodes" || !data}
                onSelect={() => {
                  if (layoutRunning) { layoutRef.current?.stop(); setLayoutRunning(false) } else startLayoutRef.current?.()
                }}
              >
                {layoutRunning ? <Pause /> : <Play />} {layoutRunning ? "Pause layout" : "Re-run layout"}
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem className="text-xs" checked={showReport} onCheckedChange={(v) => {
                  setShowReport(!!v)
                  // the report shares the right panel with the node inspector: showing it must be visible
                  if (v) applySelection(null)
                }}>
                Report
              </DropdownMenuCheckboxItem>
              {data && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="tabular text-[11px] font-normal text-fg-faint">
                    {compact(data.nodes.length)} nodes · {compact(data.links.length)} edges{data.source === "graphify-fixture" ? " · httpx example" : ""}
                  </DropdownMenuLabel>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* left: communities only (§2.5: edge filters live in the Filter menu) */}
        <aside className="flex w-44 shrink-0 flex-col border-r border-line-subtle bg-chrome">
          <div className="flex h-8 shrink-0 items-center px-3">
            <span className="section-label">{scope === "global" ? "Repositories" : "Communities"}</span>
            {!allVisible && (
              <button className="ml-auto text-[11px] text-fg-faint hover:text-fg" onClick={() => setHiddenComms(new Set())}>
                All
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {data?.communities.map((c, i) => {
              const hidden = hiddenComms.has(c.id)
              return (
                <button
                  key={c.id}
                  onClick={() => setHiddenComms((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n })}
                  onDoubleClick={() => drill(c.id)}
                  className="group flex h-6 w-full items-center gap-2 px-3 text-left text-xs hover:bg-hover"
                  title={`${c.name} · ${c.size.toLocaleString()} nodes\nClick to show or hide · double-click to open only this one`}
                >
                  <span
                    className={cn("size-2.5 shrink-0 rounded-sm border", hidden && "bg-transparent!")}
                    style={{ background: COMMUNITY_COLORS[i % COMMUNITY_COLORS.length], borderColor: COMMUNITY_COLORS[i % COMMUNITY_COLORS.length] }}
                  />
                  <span className={cn("truncate", hidden ? "text-fg-faint" : "text-fg-muted group-hover:text-fg")}>{c.name}</span>
                </button>
              )
            })}
          </div>
        </aside>

        {/* canvas */}
        <div className="relative min-w-0 flex-1">
          {!data && <EmptyState>Loading graph…</EmptyState>}
          <div ref={containerRef} className="absolute inset-0" />
          {data && effMode === "nodes" && isLarge && (
            <button
              className="absolute top-3 left-3 flex h-7 items-center gap-1.5 rounded-md border border-line-subtle bg-chrome px-2 text-xs text-fg-muted hover:bg-hover hover:text-fg"
              onClick={() => { setHiddenComms(new Set()); setMode("communities") }}
              title={`${compact(visibleCount)} of ${compact(data.nodes.length)} nodes shown`}
            >
              <ArrowLeft size={12} /> All communities
            </button>
          )}
          <div className="absolute right-3 bottom-3 flex flex-col overflow-hidden rounded-md border border-line-subtle bg-chrome">
            <ZoomBtn label="Zoom in" onClick={() => void sigmaRef.current?.getCamera().zoomIn({ duration: 200 })}><Plus size={13} /></ZoomBtn>
            <ZoomBtn label="Zoom out" onClick={() => void sigmaRef.current?.getCamera().zoomOut({ duration: 200 })}><Minus size={13} /></ZoomBtn>
            <ZoomBtn label="Fit" onClick={() => void sigmaRef.current?.getCamera().reset({ duration: 300 })}><Maximize size={12} /></ZoomBtn>
            {selected && <ZoomBtn label="Frame selection" onClick={() => focusNode(selected)}><Crosshair size={12} /></ZoomBtn>}
          </div>
        </div>

        {/* right: node inspector + report */}
        {(selected || showReport) && data && (
          <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line-subtle bg-chrome">
            {selected ? (
              <NodeInspector data={data} id={selected} color={colorOf} onFocus={(id) => (graphRef.current?.hasNode(id) ? focusNode(id) : undefined)} onClose={() => applySelection(null)} scope={scope} />
            ) : (
              report && (
                <div className="p-3 text-xs">
                  <div className="mb-2 flex items-center">
                    <span className="section-label">GRAPH_REPORT.md</span>
                    <button onClick={() => setShowReport(false)} className="ml-auto text-fg-faint hover:text-fg" aria-label="Close report"><X size={13} /></button>
                  </div>
                  <div className="mb-1 text-[11px] text-fg-faint">God nodes (most connected)</div>
                  {report.god.map(({ n, d }) => (
                    <button key={n.id} onClick={() => openResult(n)} className="flex h-6 w-full items-center gap-2 rounded-sm px-1 text-left hover:bg-hover">
                      <span className="size-2 shrink-0 rounded-full" style={{ background: colorOf(n.community) }} />
                      <span className="truncate font-mono text-[11px] text-fg">{n.label}</span>
                      <span className="tabular ml-auto text-[11px] text-fg-faint">{d}</span>
                    </button>
                  ))}
                  <div className="mt-3 mb-1 text-[11px] text-fg-faint">Surprising connections</div>
                  {report.surprising.map((s, i) => (
                    <div key={i} className="mb-1.5 rounded-sm border border-line-subtle px-2 py-1.5">
                      <div className="truncate font-mono text-[11px] text-fg-muted">{s.a.label}</div>
                      <div className="text-[11px] text-fg-faint">{s.rel} · {s.conf} · {s.a.community_name} → {s.b.community_name}</div>
                      <div className="truncate font-mono text-[11px] text-fg-muted">{s.b.label}</div>
                    </div>
                  ))}
                  <div className="mt-3 mb-1 text-[11px] text-fg-faint">Suggested questions</div>
                  <ul className="list-disc space-y-1 pl-4 text-fg-muted">
                    <li>What breaks if {report.god[0]?.n.label} changes its signature?</li>
                    <li>Why does {report.surprising[0]?.a.community_name} depend on {report.surprising[0]?.b.community_name}?</li>
                  </ul>
                </div>
              )
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

function toggleSet(s: Set<string>, v: string) {
  const n = new Set(s)
  if (n.has(v)) n.delete(v)
  else n.add(v)
  return n
}

function ZoomBtn({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="flex size-7 items-center justify-center border-b border-line-subtle text-fg-muted last:border-0 hover:bg-hover hover:text-fg">
      {children}
    </button>
  )
}

function NodeInspector({ data, id, color, onFocus, onClose, scope }: { data: GraphJson; id: string; color: (community: number) => string; onFocus: (id: string) => void; onClose: () => void; scope: string }) {
  const node = useMemo(() => data.nodes.find((n) => n.id === id), [data, id])
  const { incoming, outgoing } = useMemo(() => {
    const byId = new Map<string, GNode>()
    const inc: { n: GNode; rel: string }[] = []
    const out: { n: GNode; rel: string }[] = []
    const want = new Set<string>()
    for (const l of data.links) {
      if (l.target === id) want.add(l.source)
      if (l.source === id) want.add(l.target)
    }
    for (const n of data.nodes) if (want.has(n.id)) byId.set(n.id, n)
    for (const l of data.links) {
      if (l.target === id && byId.get(l.source)) inc.push({ n: byId.get(l.source)!, rel: l.relation })
      if (l.source === id && byId.get(l.target)) out.push({ n: byId.get(l.target)!, rel: l.relation })
    }
    return { incoming: inc, outgoing: out }
  }, [data, id])
  if (!node) return null
  return (
    <div className="text-xs">
      <div className="border-b border-line-subtle px-3 py-3">
        <div className="flex items-start gap-2">
          <FileCode size={14} className="mt-0.5 shrink-0 text-fg-faint" />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[12px] break-all text-fg">{node.label}</div>
            <div className="mt-1 truncate font-mono text-[11px] text-fg-faint" title={`${node.source_file}:${node.source_location.replace("L", "")}`}>
              {node.source_file}:{node.source_location.replace("L", "")}
            </div>
          </div>
          <button onClick={onClose} className="text-fg-faint hover:text-fg" aria-label="Close (Esc)" title="Close (Esc)"><X size={13} /></button>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-fg-muted" title={node.file_type}>
          <span className="size-2 rounded-full" style={{ background: color(node.community) }} />
          {node.community_name}
        </div>
        <div className="mt-3 flex items-center gap-1">
          <Button
            size="sm"
            variant="default"
            onClick={() => {
              setNewSessionPrefill(`About \`${node.label}\` (${node.source_file}:${node.source_location.replace("L", "")}): `)
              // global graph nodes carry their repo's name
              openNewSession(scope === "global" ? Object.values(getApp().repos).find((r) => r.name === node.repo)?.id : scope)
            }}
            title="Start a session with this symbol as context"
          >
            <MessageSquarePlus /> Ask a session
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => onFocus(id)} title="Frame in view" aria-label="Frame in view"><Crosshair /></Button>
        </div>
      </div>
      {([["Used by", incoming], ["Uses", outgoing]] as const).map(([title, list]) => (
        <div key={title} className="border-b border-line-subtle px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="section-label">{title}</span>
            <span className="tabular text-[11px] text-fg-faint">{list.length}</span>
          </div>
          {list.slice(0, 14).map(({ n, rel }, i) => (
            <button key={`${n.id}${i}`} onClick={() => onFocus(n.id)} className="flex h-6 w-full items-center gap-2 rounded-sm px-1 text-left hover:bg-hover">
              <span className="w-20 shrink-0 truncate font-mono text-[10.5px] text-fg-faint">{rel}</span>
              <span className="truncate font-mono text-[11px] text-fg-muted">{n.label}</span>
            </button>
          ))}
          {list.length > 14 && <div className="px-1 pt-0.5 text-[11px] text-fg-faint">+{list.length - 14} more</div>}
          {list.length === 0 && <div className="text-[11px] text-fg-faint">None</div>}
        </div>
      ))}
    </div>
  )
}
