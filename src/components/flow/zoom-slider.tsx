// Adapted from xyflow React Flow UI (ui.reactflow.dev registry, fetched 2026-11-14 via shadcn@4.23.0):zoom-slider.tsx (MIT).
// Modified for session-dashboard: IDE density (20px icon buttons, 96px slider), chrome surface
// with a 1px border and no shadow, zoom readout reads from a boolean-free selector so the
// slider re-renders only itself, extra trailing slot (`children`) for map toggles, and
// `slider={false}` for the calm variant (− / % / + / fit, no track).
import type { ReactNode } from "react"
import { Maximize, Minus, Plus } from "lucide-react"
import { Panel, useReactFlow, useStore, type PanelProps, type ReactFlowState } from "@xyflow/react"

import { Slider } from "./slider"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const zoomSel = (s: ReactFlowState) => s.transform[2]
const minSel = (s: ReactFlowState) => s.minZoom
const maxSel = (s: ReactFlowState) => s.maxZoom

export function ZoomSlider({
  className,
  orientation = "horizontal",
  onFit,
  slider = true,
  children,
  ...props
}: Omit<PanelProps, "children"> & {
  orientation?: "horizontal" | "vertical"
  onFit?: () => void
  /** show the zoom track between − and + */
  slider?: boolean
  children?: ReactNode
}) {
  const zoom = useStore(zoomSel)
  const minZoom = useStore(minSel)
  const maxZoom = useStore(maxSel)
  const { zoomTo, zoomIn, zoomOut, fitView } = useReactFlow()

  return (
    <Panel
      className={cn(
        "flex items-center gap-0.5 rounded-md border border-line-subtle bg-chrome p-0.5 text-fg-muted",
        orientation === "horizontal" ? "flex-row" : "flex-col",
        className,
      )}
      {...props}
    >
      <Button variant="ghost" size="icon-xs" onClick={() => zoomOut({ duration: 200 })} title="Zoom out" aria-label="Zoom out">
        <Minus />
      </Button>
      {slider && (
        <Slider
          className={cn(orientation === "horizontal" ? "mx-1 w-24" : "my-1 h-24")}
          orientation={orientation}
          value={[zoom]}
          min={minZoom}
          max={maxZoom}
          step={0.01}
          onValueChange={(values) => zoomTo(values[0])}
          aria-label="Zoom"
        />
      )}
      <Button variant="ghost" size="icon-xs" onClick={() => zoomIn({ duration: 200 })} title="Zoom in" aria-label="Zoom in">
        <Plus />
      </Button>
      <Button
        variant="ghost"
        size="xs"
        className="tabular w-11 justify-center font-mono text-[11px]"
        onClick={() => zoomTo(1, { duration: 200 })}
        title="Reset to 100%"
      >
        {(100 * zoom).toFixed(0)}%
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => (onFit ? onFit() : void fitView({ duration: 200 }))}
        title="Fit view (F)"
        aria-label="Fit view"
      >
        <Maximize />
      </Button>
      {children}
    </Panel>
  )
}
