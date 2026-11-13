// Adapted from xyflow React Flow examples (example-apps.xyflow.com, fetched 2026-11-14):react/examples/edges/simple-floating-edges/utils.js (MIT). Modified for session-dashboard.
// Repo link edge: floating bezier between two repo groups, dashed, label on hover.
// Floating geometry adapted from the React Flow "Simple Floating Edges" example (MIT,
// example-apps.xyflow.com/react/examples/edges/simple-floating-edges: utils.js `getParams`,
// `getEdgeParams`, SimpleFloatingEdge.jsx). Modified: anchors are the side centers of the node
// rect (groups have no side handles), and the label is rendered through our ButtonEdge.
import { memo, useState } from "react"
import { getBezierPath, Position, useInternalNode, type Edge, type EdgeProps, type InternalNode } from "@xyflow/react"
import { ButtonEdge } from "@/components/flow/button-edge"
import { useApp } from "@/store/app"
import { HEADER_H, type LinkEdgeData } from "../layout"

type LinkEdgeType = Edge<LinkEdgeData, "link">

function rectOf(n: InternalNode) {
  const { x, y } = n.internals.positionAbsolute
  return { x, y, w: n.width ?? n.measured.width ?? 0, h: n.height ?? n.measured.height ?? 0 }
}

// returns the anchor point and side of nodeA facing nodeB
function getParams(a: InternalNode, b: InternalNode): [number, number, Position] {
  const ra = rectOf(a)
  const rb = rectOf(b)
  const ca = { x: ra.x + ra.w / 2, y: ra.y + Math.min(ra.h, 120) / 2 }
  const cb = { x: rb.x + rb.w / 2, y: rb.y + Math.min(rb.h, 120) / 2 }
  const horizontal = Math.abs(ca.x - cb.x) > Math.abs(ca.y - cb.y)
  if (horizontal) {
    // anchor on the header band so links between neighbors read as repo-to-repo
    const y = ra.y + HEADER_H / 2
    return ca.x > cb.x ? [ra.x, y, Position.Left] : [ra.x + ra.w, y, Position.Right]
  }
  return ca.y > cb.y ? [ca.x, ra.y, Position.Top] : [ca.x, ra.y + ra.h, Position.Bottom]
}

/**
 * Same column: a vertical bezier would run through the groups in between, so both ends anchor on
 * the right edge of the header strip and the curve bulges into the column gutter instead.
 */
function sameColumnPath(a: InternalNode, b: InternalNode): [string, number, number] | null {
  const ra = rectOf(a)
  const rb = rectOf(b)
  if (Math.abs(ra.x - rb.x) > ra.w / 2) return null
  const sx = ra.x + ra.w
  const tx = rb.x + rb.w
  const sy = ra.y + HEADER_H / 2
  const ty = rb.y + HEADER_H / 2
  const bulge = Math.min(22, 12 + Math.abs(ty - sy) * 0.02)
  const path = `M ${sx},${sy} C ${sx + bulge},${sy} ${tx + bulge},${ty} ${tx},${ty}`
  return [path, Math.max(sx, tx) + bulge * 0.75, (sy + ty) / 2]
}

export const LinkEdge = memo(function LinkEdge({ id, source, target, data }: EdgeProps<LinkEdgeType>) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  const [hover, setHover] = useState(false)
  const highlighted = useApp((s) => s.selection?.kind === "repo" && (s.selection.id === source || s.selection.id === target))
  if (!sourceNode || !targetNode || !data) return null

  let geom = sameColumnPath(sourceNode, targetNode)
  if (!geom) {
    const [sx, sy, sourcePos] = getParams(sourceNode, targetNode)
    const [tx, ty, targetPos] = getParams(targetNode, sourceNode)
    const [p, lx, ly] = getBezierPath({ sourceX: sx, sourceY: sy, sourcePosition: sourcePos, targetX: tx, targetY: ty, targetPosition: targetPos })
    geom = [p, lx, ly]
  }
  const [path, labelX, labelY] = geom
  const strong = hover || highlighted

  return (
    <ButtonEdge
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      style={{
        stroke: strong ? "var(--fg-muted)" : "var(--fg-faint)",
        strokeWidth: strong ? 1.5 : 1.25,
        strokeDasharray: data.linkKind === "shared-rules" ? "2 4" : "6 4",
        strokeLinecap: "round",
        opacity: strong ? 1 : 0.75,
      }}
      showLabel={strong}
      onHoverChange={setHover}
    >
      <div className="flex h-5 items-center gap-1.5 rounded-sm border border-line bg-elevated px-1.5 text-[11px] whitespace-nowrap text-fg-muted">
        <span className="text-fg-faint">{data.linkKind}</span>
        <span>{data.label}</span>
      </div>
    </ButtonEdge>
  )
})
