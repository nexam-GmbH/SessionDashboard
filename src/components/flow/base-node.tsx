// Adapted from xyflow React Flow UI (ui.reactflow.dev registry, fetched 2026-11-14 via shadcn@4.23.0):base-node.tsx (MIT).
// Modified for session-dashboard: our tokens (UI_PLAN §2.2), 4px radius, no hover ring or
// selection shadow (borders, not shadows: §2.1), selection driven by `data-selected` from our
// store instead of React Flow's `.selected` class, IDE density paddings, no tabIndex (the map
// canvas owns keyboard focus).
import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

export function BaseNode({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative isolate rounded-md border border-line-subtle bg-elevated text-fg",
        "hover:border-line",
        // selection: a 1px accent ring outside the card (blue is focus/primary only), so it never
        // fights the status border; no shadow
        "data-[selected=true]:outline data-[selected=true]:outline-1 data-[selected=true]:outline-offset-2 data-[selected=true]:outline-brand",
        className,
      )}
      {...props}
    />
  )
}

/** Header row: glyph · title · trailing meta. */
export function BaseNodeHeader({ className, ...props }: ComponentProps<"header">) {
  return <header {...props} className={cn("flex min-w-0 flex-row items-start gap-1.5 px-2.5 pt-2", className)} />
}

/** Title text; not selectable, to keep a native application feel. */
export function BaseNodeHeaderTitle({ className, ...props }: ComponentProps<"h3">) {
  return (
    <h3
      data-slot="base-node-title"
      className={cn("min-w-0 flex-1 text-[13px] leading-[17px] font-medium select-none", className)}
      {...props}
    />
  )
}

export function BaseNodeContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="base-node-content" className={cn("flex flex-col gap-y-1.5 px-2.5", className)} {...props} />
}

export function BaseNodeFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="base-node-footer"
      className={cn("flex h-7 items-center gap-2 border-t border-line-subtle px-2.5", className)}
      {...props}
    />
  )
}
