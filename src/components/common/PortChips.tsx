// The dev servers a session runs, as ":5173" chips that open in the browser.
import { memo } from "react"
import { usePorts, openPort } from "@/backend/ports"
import type { ID } from "@/lib/model"
import { cn } from "@/lib/utils"

const NONE: number[] = []

export const PortChips = memo(function PortChips({ id, className }: { id: ID; className?: string }) {
  const ports = usePorts((s) => s[id] ?? NONE)
  if (!ports.length) return null
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {ports.slice(0, 4).map((p) => (
        <button
          key={p}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            openPort(p)
          }}
          title={`Listening on port ${p}: open http://localhost:${p}`}
          className="pointer-events-auto relative z-10 h-5 rounded-sm border border-border px-1 font-mono text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          :{p}
        </button>
      ))}
    </span>
  )
})
