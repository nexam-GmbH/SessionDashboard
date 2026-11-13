// Adapted from argoproj/argo-cd@ae2e784:ui/src/app/applications/components/application-resource-tree/node-update-animation.tsx (Apache-2.0). Modified for session-dashboard.
// Shared bits for map nodes: invisible handles, selection, the status-change flash, spinner gating.
import { memo, useCallback, useState } from "react"
import { useStore, type ReactFlowState } from "@xyflow/react"
import { Circle, CircleCheck, CircleDashed, CircleSlash, LoaderCircle, MessageCircleQuestion, OctagonX, ShieldAlert, type LucideIcon } from "lucide-react"
import { useApp } from "@/store/app"
import type { ID, SessionStatus } from "@/lib/model"
import { STATUS_COLOR, STATUS_LABEL, STATUS_TINT } from "@/lib/status"
import { nodeOnScreen, type LodTier } from "../lod"

/**
 * React Flow needs a handle on each end of an edge; our edges are routed by the layout, so the
 * handles are invisible anchors (Headlamp does the same with `opacity: 0` handles). Plain elements
 * with the classes `<Handle isConnectable={false}>` renders: React Flow only measures the `.source`
 * / `.target` elements of a node (position from `data-handlepos`), while each `<Handle>` adds two
 * store subscriptions that run on every pan and zoom frame, four per card.
 */
export function MapHandles() {
  return (
    <>
      <div data-handlepos="top" className="react-flow__handle react-flow__handle-top nodrag nopan map-handle target connectablestart connectableend" />
      <div data-handlepos="bottom" className="react-flow__handle react-flow__handle-bottom nodrag nopan map-handle source connectablestart connectableend" />
    </>
  )
}

export function useIsSelected(kind: "session" | "repo" | "subagent", id: ID) {
  return useApp((s) => s.selection?.kind === kind && s.selection.id === id)
}

/**
 * Status-change flash — UI_PLAN §2.1: one 600ms `--st-*-tint` background pulse when the status
 * changes. Idea from Argo CD's NodeUpdateAnimation (argoproj/argo-cd@ae2e784:
 * ui/src/app/applications/components/application-resource-tree/node-update-animation.tsx,
 * Apache-2.0): a keyed overlay remounts on each change so the CSS animation replays. Here the
 * change is detected with the "adjust state while rendering" pattern instead of an effect, so a
 * first mount never flashes. The overlay sits at z-index -1 inside the card's isolated stacking
 * context: above the card background, under its content.
 */
export function StatusFlash({ status }: { status: SessionStatus }) {
  const [seen, setSeen] = useState({ status, n: 0 })
  const reduce = useApp((s) => s.settings.reduceMotion)
  if (seen.status !== status) setSeen({ status, n: seen.n + 1 })
  if (!seen.n || reduce) return null
  return (
    <div
      key={`${status}:${seen.n}`}
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 animate-flash rounded-[inherit]"
      style={{ "--flash-color": STATUS_TINT[status] ?? "var(--bg-hover)" } as React.CSSProperties}
    />
  )
}

/** Animate the working spinner only at full LOD and while the node is on screen (UI_PLAN §8). */
export function useSpin(id: ID, status: SessionStatus, tier: LodTier) {
  const reduce = useApp((s) => s.settings.reduceMotion)
  const want = !reduce && tier === "full" && status === "working"
  const sel = useCallback((s: ReactFlowState) => want && nodeOnScreen(s, id), [want, id])
  return useStore(sel)
}

// Same glyph set as components/common/StatusGlyph (UI_PLAN §2.3), drawn at its native size.
const COMPACT_ICON: Record<SessionStatus, LucideIcon> = {
  waiting_permission: ShieldAlert,
  waiting_input: MessageCircleQuestion,
  error: OctagonX,
  done_unseen: CircleCheck,
  working: LoaderCircle,
  starting: CircleDashed,
  idle: Circle,
  stopped: CircleSlash,
}

/**
 * Status glyph for compact LOD cards, rendered at the size it is shown instead of a CSS-scaled
 * small glyph: hundreds of these are painted on every pan frame at compact zoom, and a scaled SVG
 * is the most expensive thing on a compact card (measured on the stress fixture). Never animated.
 */
export const CompactGlyph = memo(function CompactGlyph({ status, size = 26 }: { status: SessionStatus; size?: number }) {
  const Icon = COMPACT_ICON[status]
  const idle = status === "idle" || status === "stopped"
  return (
    <Icon
      role="img"
      aria-label={STATUS_LABEL[status]}
      size={idle ? size - 4 : size}
      strokeWidth={2}
      className="shrink-0"
      color={status === "stopped" ? "var(--fg-faint)" : STATUS_COLOR[status]}
      fill={status === "done_unseen" ? "var(--st-done-tint)" : "none"}
    />
  )
})
