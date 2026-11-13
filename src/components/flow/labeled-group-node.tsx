// Adapted from xyflow React Flow UI (ui.reactflow.dev registry, fetched 2026-11-14 via shadcn@4.23.0):labeled-group-node.tsx (MIT).
// Modified for session-dashboard: the label is a full-width header row (repo name, branch, git
// chips, roll-up) instead of a corner tag inside a <Panel>; the body is a flat `bg-chrome`
// surface with a 1px border (no translucent white); selection via `data-selected`.
import type { ComponentProps, ReactNode } from "react"

import { BaseNode } from "./base-node"
import { cn } from "@/lib/utils"

export type GroupNodeLabelProps = ComponentProps<"div">

/** Header strip at the top of a group. */
export function GroupNodeLabel({ children, className, ...props }: GroupNodeLabelProps) {
  return (
    <div className={cn("relative border-b border-line-subtle", className)} {...props}>
      {children}
    </div>
  )
}

export type GroupNodeProps = Omit<ComponentProps<"div">, "children"> & {
  label?: ReactNode
  children?: ReactNode
  selected?: boolean
}

export function GroupNode({ label, children, selected, className, ...props }: GroupNodeProps) {
  return (
    <BaseNode
      data-selected={selected || undefined}
      className={cn("flex h-full flex-col overflow-visible bg-chrome hover:border-line-subtle", className)}
      {...props}
    >
      {label && <GroupNodeLabel>{label}</GroupNodeLabel>}
      {children}
    </BaseNode>
  )
}
