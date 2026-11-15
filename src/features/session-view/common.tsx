// Adapted from BloopAI/vibe-kanban@5f06193:packages/ui/src/components/ToolStatusDot.tsx (Apache-2.0). Modified for session-dashboard.
// Changes: our ToolCall.display states and status tokens; a 10px
// spinner for running tools instead of a ping; shape differs per state so the
// state never relies on color alone; finished tools are a neutral dot (calm color
// budget: color only for attention and the working spinner).
import { memo, type ReactNode } from "react"
import { ChevronRight, LoaderCircle } from "lucide-react"
import type { ToolCall } from "@/lib/model"
import { cn } from "@/lib/utils"

const DOT_TITLE: Record<ToolCall["display"], string> = {
  awaiting_permission: "Waiting for permission",
  running: "Running",
  done: "Done",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
}

export const ToolStatusDot = memo(function ToolStatusDot({
  display,
  className,
  tone,
}: {
  display: ToolCall["display"]
  className?: string
  /** awaiting an answer (AskUserQuestion) rather than a permission */
  tone?: "input"
}) {
  return (
    <span title={DOT_TITLE[display]} className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", className)}>
      {display === "running" ? (
        <LoaderCircle size={11} strokeWidth={2.5} className="animate-spin-steps text-st-working" />
      ) : display === "awaiting_permission" ? (
        <span className={cn("size-[7px] rotate-45 rounded-sm", tone === "input" ? "bg-st-input" : "bg-st-perm")} />
      ) : display === "failed" ? (
        <span className="size-[7px] rounded-full bg-st-error" />
      ) : display === "done" ? (
        <span className="size-[5px] rounded-full bg-muted-foreground/50" />
      ) : (
        <span className="size-[7px] rounded-full border border-muted-foreground/70" />
      )}
    </span>
  )
})

export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      size={12}
      strokeWidth={2}
      className={cn("shrink-0 text-muted-foreground/70 transition-transform duration-150", open && "rotate-90", className)}
    />
  )
}

/** Indented detail panel under a row, on a 1px rail (Cline disclosure "rail" presentation). */
export function Rail({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("ml-[7px] border-l border-border pt-1 pb-1.5 pl-[18px]", className)}>{children}</div>
}

/** Small mono block for tool output. */
export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "overflow-auto rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs leading-[18px] whitespace-pre text-muted-foreground select-text",
        className,
      )}
    >
      {children}
    </pre>
  )
}

/** VS Code-style 11px uppercase sub-label. */
export function MicroLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-xs font-medium text-muted-foreground mb-1 text-xs", className)}>{children}</div>
}
