// Adapted from xyflow React Flow UI (ui.reactflow.dev registry, fetched 2026-11-14 via shadcn@4.23.0):node-tooltip.tsx (MIT).
// Modified for session-dashboard: opens after a hover delay (450ms, the "glance" delay from
// Headlamp's KubeObjectNode, Apache-2.0), the content is a floating layer on our elevated
// surface (shadow allowed on floating layers only, UI_PLAN §2.1), `enabled` gates it, and the
// content also works without the context (`nodeId` + `isVisible`), so a canvas can run one shared
// glance instead of a tooltip provider per node.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentProps } from "react"
import { NodeToolbar, type NodeToolbarProps } from "@xyflow/react"

import { cn } from "@/lib/utils"

export const GLANCE_DELAY = 450

type TooltipContextType = {
  isVisible: boolean
  showTooltip: () => void
  hideTooltip: () => void
}

const TooltipContext = createContext<TooltipContextType | null>(null)

export function NodeTooltip({ children, enabled = true, delay = GLANCE_DELAY }: ComponentProps<"div"> & { enabled?: boolean; delay?: number }) {
  const [isVisible, setIsVisible] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const showTooltip = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setIsVisible(true), delay)
  }, [delay])
  const hideTooltip = useCallback(() => {
    window.clearTimeout(timer.current)
    setIsVisible(false)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <TooltipContext.Provider value={{ isVisible: enabled && isVisible, showTooltip, hideTooltip }}>{children}</TooltipContext.Provider>
  )
}

export function NodeTooltipTrigger({ onMouseEnter, onMouseLeave, ...props }: ComponentProps<"div">) {
  const ctx = useContext(TooltipContext)
  if (!ctx) throw new Error("NodeTooltipTrigger must be used within NodeTooltip")
  const { showTooltip, hideTooltip } = ctx
  return (
    <div
      onMouseEnter={(e) => {
        onMouseEnter?.(e)
        showTooltip()
      }}
      onMouseLeave={(e) => {
        onMouseLeave?.(e)
        hideTooltip()
      }}
      {...props}
    />
  )
}

export function NodeTooltipContent({ children, position, className, isVisible, ...props }: NodeToolbarProps) {
  const ctx = useContext(TooltipContext)
  if (!(isVisible ?? ctx?.isVisible)) return null
  return (
    <NodeToolbar
      isVisible
      className={cn("pointer-events-none rounded-md border border-line bg-elevated shadow-lg", className)}
      position={position}
      {...props}
    >
      {children}
    </NodeToolbar>
  )
}
