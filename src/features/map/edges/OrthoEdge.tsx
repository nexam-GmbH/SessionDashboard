// Adapted from kubernetes-sigs/headlamp@e16a575:frontend/src/components/resourceMap/edges/GraphEdgeComponent.tsx (Apache-2.0). Modified for session-dashboard.
// Routed map edges: hierarchy, delegated, spawned, forked — UI_PLAN §3 "Map edges".
// Geometry is computed by the layout (gutter routing), so the edge only draws a rounded
// orthogonal polyline. Structure-only: the one live input is the delegated child's status
// (animated only while the child is working).
// Edge component shape after Headlamp's GraphEdgeComponent (kubernetes-sigs/headlamp@e16a575,
// Apache-2.0: precomputed sections drawn through BaseEdge, memoized).
import { memo } from "react"
import { BaseEdge, useStore, type EdgeProps, type Edge } from "@xyflow/react"
import { useApp } from "@/store/app"
import type { OrthoEdgeData } from "../layout"
import { tierSelector } from "../lod"

type OrthoEdgeType = Edge<OrthoEdgeData, "ortho">

// Calm UI (UI_PLAN §2.5 rule 5): edges stay neutral; color is reserved for attention. A delegated
// edge is told apart by its dash, and its dashes flow only while the child works.
const STYLE: Record<OrthoEdgeData["kind"], React.CSSProperties> = {
  hierarchy: { stroke: "var(--border-default)", strokeWidth: 1 },
  spawned: { stroke: "var(--border-default)", strokeWidth: 1 },
  delegated: { stroke: "var(--border-strong)", strokeWidth: 1.25, strokeDasharray: "5 4", opacity: 0.9 },
  forked: { stroke: "var(--fg-faint)", strokeWidth: 1.5, strokeDasharray: "0.5 3.5", strokeLinecap: "round" },
}

/** Rounded orthogonal path through `pts`; collinear and duplicate points are dropped. */
export function roundedPath(pts: [number, number][], r = 6): string {
  const p: [number, number][] = []
  for (const pt of pts) {
    const last = p[p.length - 1]
    if (last && last[0] === pt[0] && last[1] === pt[1]) continue
    if (p.length >= 2) {
      const a = p[p.length - 2]
      const b = p[p.length - 1]
      if ((a[0] === b[0] && b[0] === pt[0]) || (a[1] === b[1] && b[1] === pt[1])) {
        p[p.length - 1] = pt
        continue
      }
    }
    p.push(pt)
  }
  if (p.length < 2) return ""
  let d = `M ${p[0][0]},${p[0][1]}`
  for (let i = 1; i < p.length - 1; i++) {
    const [x0, y0] = p[i - 1]
    const [x1, y1] = p[i]
    const [x2, y2] = p[i + 1]
    const r1 = Math.min(r, Math.hypot(x1 - x0, y1 - y0) / 2, Math.hypot(x2 - x1, y2 - y1) / 2)
    const ax = x1 - Math.sign(x1 - x0) * r1
    const ay = y1 - Math.sign(y1 - y0) * r1
    const bx = x1 + Math.sign(x2 - x1) * r1
    const by = y1 + Math.sign(y2 - y1) * r1
    d += ` L ${ax},${ay} Q ${x1},${y1} ${bx},${by}`
  }
  const end = p[p.length - 1]
  return `${d} L ${end[0]},${end[1]}`
}

function bezierPath([[sx, sy], [tx, ty]]: [number, number][]) {
  const dy = Math.max(40, Math.abs(ty - sy) / 2)
  return `M ${sx},${sy} C ${sx},${sy + dy} ${tx},${ty - dy} ${tx},${ty}`
}

function pathFor(data: OrthoEdgeData) {
  return data.curve === "bezier" ? bezierPath(data.points) : roundedPath(data.points)
}

const DelegatedEdge = memo(function DelegatedEdge({ id, data, markerEnd }: EdgeProps<OrthoEdgeType>) {
  const childIds = data!.childIds ?? []
  // the flowing dash repaints its whole path every frame, so it runs only at full LOD
  const full = useStore(tierSelector) === "full"
  const working = useApp((s) => full && !s.settings.reduceMotion && childIds.some((c) => s.sessions[c]?.status === "working"))
  return (
    <BaseEdge
      id={id}
      path={pathFor(data!)}
      markerEnd={markerEnd}
      style={STYLE.delegated}
      className={working ? "map-edge-flow" : undefined}
      interactionWidth={0}
    />
  )
})

export const OrthoEdge = memo(function OrthoEdge(props: EdgeProps<OrthoEdgeType>) {
  const { id, data, markerEnd } = props
  if (!data) return null
  if (data.kind === "delegated") return <DelegatedEdge {...props} />
  return <BaseEdge id={id} path={pathFor(data)} markerEnd={markerEnd} style={STYLE[data.kind]} interactionWidth={0} />
})
