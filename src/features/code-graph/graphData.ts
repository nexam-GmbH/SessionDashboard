import Graph from "graphology"
import type forceAtlas2 from "graphology-layout-forceatlas2"
type IForceAtlas2Layout = typeof forceAtlas2
import { getApp } from "@/store/app"
import { Rng } from "@/mocks/rng"
import type { RepoSpec } from "@/mocks/catalog"

/**
 * Code graph data in Graphify's graph.json shape (node-link JSON, RESEARCH §5):
 * nodes {id, label, file_type, source_file, source_location, community},
 * links {source, target, relation, confidence, weight}.
 * - llm-router uses Graphify's real worked example (httpx, Apache-2.0) as fixture
 * - other repos: deterministic synthetic graphs sized from repo.graphify
 * - "global": every repo's graph + cross-repo `calls` edges (global-graph.json)
 */
export interface GNode {
  id: string
  label: string
  file_type: "code" | "document" | "concept"
  source_file: string
  source_location: string
  community: number
  community_name?: string
  repo?: string
}
export interface GLink {
  source: string
  target: string
  relation: "calls" | "uses" | "contains" | "method" | "inherits" | "imports_from"
  confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS"
  weight: number
}
export interface GraphJson {
  nodes: GNode[]
  links: GLink[]
  communities: { id: number; name: string; size: number }[]
  source: "graphify-fixture" | "synthetic"
}

// Radix Colors dark step 11 (MIT): categorical, readable on dark canvas. 24 hues so the
// synthetic graphs (up to 24 communities) and the global graph (up to 24 repos) never repeat.
export const COMMUNITY_COLORS = [
  "#70b8ff", "#0bd8b6", "#baa7ff", "#ffca16", "#ffa057", "#ff92ad", "#71d083", "#4ccce6",
  "#e796f3", "#9eb1ff", "#cbb99f", "#75c7f0", "#bde56c", "#ff8dcc", "#58d5ba", "#b1a9ff",
  "#d19dff", "#3dd68c", "#ff977d", "#f5e147", "#dbb594", "#1fd8a4", "#ff949d", "#d4b3a5",
]

/** Graph chrome colors from the design tokens (WebGL can't read CSS variables). */
export interface GraphTheme {
  label: string
  labelFocus: string
  dimNode: string
  edge: string
  edgeStrong: string
  edgeFocus: string
  backdrop: string
  backdropBorder: string
}
let theme: GraphTheme | null = null
export function graphTheme(): GraphTheme {
  if (theme) return theme
  const cs = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null
  const v = (name: string, fallback: string) => cs?.getPropertyValue(name).trim() || fallback
  theme = {
    label: v("--fg-muted", "#b0b4ba"),
    labelFocus: v("--fg", "#edeef0"),
    dimNode: v("--border-subtle", "#2b2e32"),
    edge: v("--border-default", "#363a3f"),
    edgeStrong: v("--border-strong", "#43484e"),
    edgeFocus: v("--link", "#70b8ff"),
    backdrop: v("--bg-elevated", "#212225"),
    backdropBorder: v("--border-default", "#363a3f"),
  }
  return theme
}

const RELATIONS: GLink["relation"][] = ["calls", "uses", "contains", "method", "inherits", "imports_from"]

const cache = new Map<string, GraphJson>()

export async function loadGraph(scope: string, big = 0): Promise<GraphJson> {
  const key = `${scope}:${big}`
  const hit = cache.get(key)
  if (hit) return hit
  let g: GraphJson
  if (scope === "repo_llm-router" && !big) {
    const raw = (await import("@/mocks/fixtures/httpx-graph.json")).default as unknown as { nodes: GNode[]; links: GLink[] }
    const names = ["client & transports", "models", "auth", "config", "exceptions", "utils"]
    const sizes = new Map<number, number>()
    for (const n of raw.nodes) sizes.set(n.community, (sizes.get(n.community) ?? 0) + 1)
    g = {
      nodes: raw.nodes.map((n) => ({ ...n, community_name: names[n.community] ?? `community ${n.community}` })),
      links: raw.links.map((l) => ({ source: l.source, target: l.target, relation: l.relation, confidence: l.confidence, weight: l.weight ?? 1 })),
      communities: [...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([id, size]) => ({ id, name: names[id] ?? `community ${id}`, size })),
      source: "graphify-fixture",
    }
  } else if (scope === "global") {
    g = globalGraph()
  } else {
    const st = getApp()
    const repo = st.repos[scope]
    const spec = st.repoSpecs[scope]
    const n = big || Math.min(repo?.graphify?.nodes ?? 800, st.fixture === "stress" ? 20_000 : 2600)
    g = synthetic(scope, spec, n, Math.min(repo?.graphify?.communities ?? 12, 24))
  }
  cache.set(key, g)
  return g
}

function synthetic(seed: string, spec: RepoSpec | undefined, nodeCount: number, communities: number, prefix = ""): GraphJson {
  const rng = new Rng(seed)
  const files = spec?.files ?? ["src/index.ts"]
  const symbols = spec?.symbols ?? ["main"]
  const dirs = [...new Set(files.map((f) => f.split("/").slice(0, -1).join("/") || "."))]
  const MODULES = ["auth", "routes", "middleware", "config", "metrics", "upstreams", "tickets", "retry", "rate-limit", "tracing", "errors", "models", "handlers", "storage", "cache", "queue", "telemetry", "schemas", "clients", "validation", "jobs", "webhooks", "sessions", "search"]
  const dirNames = dirs.map((d) => d.split("/").pop() || "core")
  const pool = [...new Set([...dirNames, ...rng.shuffle(MODULES)])]
  const commNames = Array.from({ length: communities }, (_, i) => pool[i % pool.length] + (i >= pool.length ? `-${i}` : ""))
  const nodes: GNode[] = []
  const members: string[][] = Array.from({ length: communities }, () => [])
  const ext = files[0]?.split(".").pop() ?? "ts"
  // the first code node of each catalog symbol is the symbol itself (withRetry()), so searching
  // for a name the sessions talk about finds it; labels only, the rng sequence is unchanged
  const named = new Set<string>()
  for (let i = 0; i < nodeCount; i++) {
    // power-law-ish community sizes
    const c = Math.min(communities - 1, Math.floor(Math.pow(rng.float(), 1.7) * communities))
    const isFile = i < communities * 4 || rng.chance(0.12)
    const base = symbols[i % symbols.length]
    const label = isFile
      ? `${commNames[c]}/${["index", "client", "types", "handler", "store", "utils", "config", "service"][i % 8]}${i > 30 ? i : ""}.${ext}`
      : !named.has(base)
        ? (named.add(base), `${base}()`)
        : `${base}${["Helper", "Options", "Error", "Config", "Builder", "Result", "Cache", "Client"][i % 8]}${i % 7 === 0 ? "" : i}`
    const id = `${prefix}n${i}`
    nodes.push({
      id,
      label,
      file_type: isFile ? "code" : rng.chance(0.05) ? "concept" : "code",
      source_file: isFile ? label : files[c % files.length],
      source_location: `L${rng.int(1, 400)}`,
      community: c,
      community_name: commNames[c],
    })
    members[c].push(id)
  }
  const links: GLink[] = []
  const seen = new Set<string>()
  const add = (a: string, b: string, relation: GLink["relation"], confidence: GLink["confidence"] = "EXTRACTED") => {
    if (a === b) return
    const k = `${a}>${b}`
    if (seen.has(k)) return
    seen.add(k)
    links.push({ source: a, target: b, relation, confidence, weight: 1 })
  }
  for (let c = 0; c < communities; c++) {
    const m = members[c]
    for (let i = 1; i < m.length; i++) {
      // preferential attachment inside the community (hubs = god nodes)
      const t = m[Math.floor(Math.pow(rng.float(), 2.2) * i)]
      add(m[i], t, rng.pick(RELATIONS))
      if (rng.chance(0.7)) add(m[i], m[rng.int(0, i - 1)], rng.pick(["calls", "uses"] as const), rng.chance(0.85) ? "EXTRACTED" : "INFERRED")
      if (rng.chance(0.35)) add(m[i], m[Math.floor(Math.pow(rng.float(), 1.5) * i)], "calls", rng.chance(0.85) ? "EXTRACTED" : "INFERRED")
    }
  }
  // sparse cross-community edges
  const cross = Math.floor(nodeCount * 0.03)
  for (let i = 0; i < cross; i++) {
    const a = rng.pick(nodes).id
    const b = rng.pick(nodes).id
    add(a, b, rng.pick(["calls", "imports_from", "inherits"] as const), rng.chance(0.6) ? "EXTRACTED" : rng.chance(0.7) ? "INFERRED" : "AMBIGUOUS")
  }
  return {
    nodes,
    links,
    communities: members.map((m, id) => ({ id, name: commNames[id], size: m.length })).filter((c) => c.size > 0),
    source: "synthetic",
  }
}

function globalGraph(): GraphJson {
  const st = getApp()
  const nodes: GNode[] = []
  const links: GLink[] = []
  const repos = st.repoOrder.filter((id) => st.repos[id].graphify?.state !== "none").slice(0, 24)
  repos.forEach((repoId, ri) => {
    const sub = synthetic(repoId, st.repoSpecs[repoId], st.fixture === "stress" ? 600 : 160, 4, `${ri}_`)
    const name = st.repos[repoId].name
    for (const n of sub.nodes) nodes.push({ ...n, community: ri, community_name: name, repo: name })
    links.push(...sub.links)
  })
  const rng = new Rng("global")
  for (const l of st.links) {
    const a = repos.indexOf(l.from)
    const b = repos.indexOf(l.to)
    if (a < 0 || b < 0) continue
    const count = Math.min(40, l.weight ?? 6)
    for (let i = 0; i < count; i++) {
      links.push({ source: `${a}_n${rng.int(0, 60)}`, target: `${b}_n${rng.int(0, 60)}`, relation: "calls", confidence: "INFERRED", weight: 1 })
    }
  }
  return {
    nodes,
    links,
    communities: repos.map((id, i) => ({ id: i, name: st.repos[id].name, size: nodes.filter((n) => n.community === i).length })),
    source: "synthetic",
  }
}

/** Build a graphology graph with initial positions (communities on a circle). */
export function toGraphology(data: GraphJson) {
  const g = new Graph({ multi: false, type: "directed" })
  const rng = new Rng(data.nodes.length)
  const cCount = Math.max(1, data.communities.length)
  const degree = new Map<string, number>()
  for (const l of data.links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
  }
  const R = Math.sqrt(data.nodes.length) * 4
  const commIndex = new Map(data.communities.map((c, i) => [c.id, i]))
  const edgeColor = graphTheme().edge
  for (const n of data.nodes) {
    const ci = commIndex.get(n.community) ?? -1
    const a = ((ci < 0 ? 0 : ci) / cCount) * Math.PI * 2
    const spread = R * 0.35
    const d = degree.get(n.id) ?? 0
    g.addNode(n.id, {
      ...n,
      x: Math.cos(a) * R + (rng.float() - 0.5) * spread,
      y: Math.sin(a) * R + (rng.float() - 0.5) * spread,
      size: Math.min(14, 2 + Math.sqrt(d) * 1.5),
      color: COMMUNITY_COLORS[(ci < 0 ? 0 : ci) % COMMUNITY_COLORS.length],
      degree: d,
    })
  }
  for (const l of data.links) {
    if (!g.hasNode(l.source) || !g.hasNode(l.target) || g.hasEdge(l.source, l.target)) continue
    g.addEdge(l.source, l.target, { relation: l.relation, confidence: l.confidence, size: 0.5, color: edgeColor })
  }
  return g
}

/**
 * Aggregated community graph (Graphify's own viewer does this above 5k nodes): one node per
 * community sized by member count (screen px, so big graphs stay readable), and for each
 * community only its strongest links, so the overview shows structure instead of a mesh.
 * Positions come from a short synchronous ForceAtlas2 run (a few dozen nodes, < 5 ms).
 */
export function toCommunityGraph(data: GraphJson, fa2?: IForceAtlas2Layout) {
  const g = new Graph({ multi: false, type: "undirected" })
  const cCount = Math.max(1, data.communities.length)
  const maxSize = Math.max(1, ...data.communities.map((c) => c.size))
  data.communities.forEach((c, i) => {
    const a = (i / cCount) * Math.PI * 2
    g.addNode(`c${c.id}`, {
      label: `${c.name} · ${c.size.toLocaleString()}`,
      x: Math.cos(a) * 100,
      y: Math.sin(a) * 100,
      size: 5 + 12 * Math.sqrt(c.size / maxSize),
      color: COMMUNITY_COLORS[i % COMMUNITY_COLORS.length],
      community: c.id,
      isCommunity: true,
    })
  })
  const comm = new Map(data.nodes.map((n) => [n.id, n.community]))
  const w = new Map<string, number>()
  for (const l of data.links) {
    const a = comm.get(l.source)
    const b = comm.get(l.target)
    if (a === undefined || b === undefined || a === b) continue
    const k = a < b ? `${a}|${b}` : `${b}|${a}`
    w.set(k, (w.get(k) ?? 0) + 1)
  }
  // keep each community's 3 heaviest links
  const byComm = new Map<string, [string, number][]>()
  for (const [k, weight] of w) {
    for (const c of k.split("|")) {
      const list = byComm.get(c) ?? []
      list.push([k, weight])
      byComm.set(c, list)
    }
  }
  const keep = new Set<string>()
  for (const list of byComm.values()) for (const [k] of list.sort((x, y) => y[1] - x[1]).slice(0, 3)) keep.add(k)
  const maxW = Math.max(1, ...[...keep].map((k) => w.get(k)!))
  const t = graphTheme()
  for (const k of keep) {
    const weight = w.get(k)!
    const [a, b] = k.split("|")
    if (g.hasNode(`c${a}`) && g.hasNode(`c${b}`))
      g.addEdge(`c${a}`, `c${b}`, { size: 0.6 + 3 * (weight / maxW), color: t.edgeStrong, weight, label: `${weight} cross-community edges` })
  }
  if (fa2 && g.order > 2) {
    fa2.assign(g, { iterations: 400, settings: { ...fa2.inferSettings(g.order), scalingRatio: 12, gravity: 0.6, linLogMode: false, edgeWeightInfluence: 0.5 } })
  }
  return g
}
