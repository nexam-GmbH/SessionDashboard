// Adapted from xyflow React Flow UI (ui.reactflow.dev registry, fetched 2026-11-14 via shadcn@4.23.0):node-status-indicator.tsx (MIT).
// Modified for session-dashboard: statuses are our SessionStatus (UI_PLAN §2.3) and colors come
// from the status tokens. The conic-gradient "loading" spinner border and the blurred overlay
// were removed (no gradients, no blur on WebKitGTK: §2.1); working state is shown by the glyph.
// Two variants: `border` (1px status border around the card, attention states only) and `bar`
// (3px left bar, the compact LOD pill).
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import type { SessionStatus } from "@/lib/model"
import { STATUS_COLOR } from "@/lib/status"

export type NodeStatusVariant = "border" | "bar"

export type NodeStatusIndicatorProps = {
  status?: SessionStatus
  variant?: NodeStatusVariant
  className?: string
  children: ReactNode
}

/** Statuses that earn a colored border at full LOD; the rest stay neutral. */
const BORDERED: Partial<Record<SessionStatus, true>> = {
  waiting_permission: true,
  waiting_input: true,
  error: true,
}

export function StatusBorder({ status, className }: { status: SessionStatus; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute -inset-px rounded-[inherit] border opacity-70", className)}
      style={{ borderColor: STATUS_COLOR[status] }}
    />
  )
}

export function StatusBar({ status, className }: { status: SessionStatus; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-y-0 left-0 w-[3px] rounded-l-[inherit]", className)}
      style={{ backgroundColor: STATUS_COLOR[status] }}
    />
  )
}

export function NodeStatusIndicator({ status, variant = "border", className, children }: NodeStatusIndicatorProps) {
  if (!status) return <>{children}</>
  if (variant === "bar") {
    return (
      <>
        <StatusBar status={status} className={className} />
        {children}
      </>
    )
  }
  return (
    <>
      {BORDERED[status] && <StatusBorder status={status} className={className} />}
      {children}
    </>
  )
}
