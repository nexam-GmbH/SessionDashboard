// Adapted from xyflow React Flow UI (ui.reactflow.dev registry, fetched 2026-11-14 via shadcn@4.23.0):button-edge.tsx (MIT).
// Modified for session-dashboard: the caller passes the path and label point (our floating repo
// links compute them from node rects, not from handles), the label slot is optional and can be
// hidden (repo-link labels show on hover), and hover callbacks come from a wide transparent
// interaction path.
import type { CSSProperties, ReactNode } from "react"
import { BaseEdge, EdgeLabelRenderer } from "@xyflow/react"

export function ButtonEdge({
  id,
  path,
  labelX,
  labelY,
  style,
  className,
  markerEnd,
  showLabel = true,
  onHoverChange,
  children,
}: {
  id: string
  path: string
  labelX: number
  labelY: number
  style?: CSSProperties
  className?: string
  markerEnd?: string
  showLabel?: boolean
  onHoverChange?: (hovered: boolean) => void
  children?: ReactNode
}) {
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} className={className} interactionWidth={0} />
      {onHoverChange && (
        <path
          d={path}
          fill="none"
          stroke="transparent"
          strokeWidth={14}
          className="react-flow__edge-interaction"
          onMouseEnter={() => onHoverChange(true)}
          onMouseLeave={() => onHoverChange(false)}
        />
      )}
      {children && showLabel && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
          >
            {children}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
