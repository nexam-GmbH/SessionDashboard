// One tool call as one quiet line (Claude Code desktop): kind icon, verb, target, and on the right
// a status only when it matters. The whole line toggles the call's details; a file path on it is
// its own button (stretched-button pattern: the toggle covers the line, the path sits above it).
import { memo, type ReactNode } from "react"
import type { ID, ToolCall } from "@/lib/model"
import { DiffStat } from "@/components/common/bits"
import { cn } from "@/lib/utils"
import { Chevron, PathLink, ToolIcon, ToolStatus } from "../common"
import type { ToolSummary } from "./toolSummary"

/** Shown only while the line is hovered or focused; it keeps its space, so nothing reflows. */
const ON_HOVER = "opacity-0 transition-opacity duration-100 group-hover/tool:opacity-100 group-focus-within/tool:opacity-100"

/** "Ran `npm test`", "Edited src/auth/retry.ts" (the path a link), "Searched the web for rate limits". */
export function ToolLabel({ sessionId, summary, className }: { sessionId: ID; summary: ToolSummary; className?: string }) {
  const t = summary.target
  const verb = cn("pointer-events-none shrink-0", className)
  if (!t || t.kind === "text")
    return (
      <span className={cn("pointer-events-none min-w-0 truncate", className)}>
        {summary.verb}
        {t && ` ${t.text}`}
      </span>
    )
  return (
    <>
      <span className={verb}>{summary.verb}</span>
      {t.kind === "path" && t.path ? (
        <PathLink sessionId={sessionId} path={t.path} className="text-muted-foreground" />
      ) : (
        <code className="pointer-events-none min-w-0 truncate font-mono text-xs text-muted-foreground">{t.text}</code>
      )}
    </>
  )
}

export const ToolLine = memo(function ToolLine({
  sessionId,
  summary,
  name,
  display,
  asks,
  open,
  onToggle,
  trailing,
  children,
}: {
  sessionId: ID
  summary: ToolSummary
  /** tool name, for the icon variant (Write → a new file) */
  name?: string
  display: ToolCall["display"]
  asks?: boolean
  open: boolean
  onToggle?: () => void
  /** extra muted detail on the right, shown on hover (duration, counts) */
  trailing?: ReactNode
  /** the call's details, shown while open */
  children?: ReactNode
}) {
  const label = [summary.verb, summary.target?.text, summary.detail].filter(Boolean).join(" ")
  const errorMeta = summary.metaTone === "error"
  return (
    <div className="min-w-0">
      <div className="group/tool relative -mx-1.5 flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-sm hover:bg-accent/40">
        {onToggle && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={label}
            onClick={onToggle}
            className="absolute inset-0 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        )}
        <ToolIcon family={summary.family} name={name} className="pointer-events-none group-hover/tool:text-muted-foreground" />
        <ToolLabel sessionId={sessionId} summary={summary} className="text-muted-foreground group-hover/tool:text-foreground" />
        {summary.detail && <span className="pointer-events-none max-w-[40%] shrink-0 truncate text-muted-foreground/60">{summary.detail}</span>}
        <span className="pointer-events-none ml-auto flex shrink-0 items-center gap-2 pl-2">
          {summary.meta && (
            <span className={cn("tabular text-xs", errorMeta ? "text-st-error-fg" : cn("text-muted-foreground/70", ON_HOVER))}>{summary.meta}</span>
          )}
          {trailing && <span className={cn("tabular text-xs whitespace-nowrap text-muted-foreground/70", ON_HOVER)}>{trailing}</span>}
          {summary.diff && <DiffStat added={summary.diff.added} removed={summary.diff.removed} />}
          <ToolStatus display={display} asks={asks} />
          {onToggle && <Chevron open={open} className={open ? undefined : "opacity-0 group-hover/tool:opacity-100"} />}
        </span>
      </div>
      {open && children && <div className="min-w-0 pt-0.5 pr-1 pb-2 pl-[22px]">{children}</div>}
    </div>
  )
})
