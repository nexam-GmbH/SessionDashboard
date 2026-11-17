// One tool call as one quiet line (Claude Code desktop): kind icon, verb, target, and on the right
// a status only when it matters. The whole line toggles the call's details; a file path on it is
// its own button (stretched-button pattern: the toggle covers the line, the path sits above it).
import { memo, type ReactNode } from "react"
import type { ID, ToolCall } from "@/lib/model"
import { cn } from "@/lib/utils"
import { Chevron, PathLink, ToolIcon, ToolStatus } from "../common"
import { WorkingMark } from "../transcript/Spinner"
import type { ToolSummary } from "./toolSummary"

/**
 * A step row as Claude Code desktop draws it (thinking, a tool call, a run of them): at least 28 px
 * tall, a 20 px mark, the label muted (secondary on hover), the subject in the text colour, a caret,
 * and counts or time at the end. The whole row toggles; links on it sit above the toggle.
 */
export const STEP_ROW = "group/row relative flex min-h-7 min-w-0 items-center gap-2 text-sm leading-5"
export const STEP_MARK = "pointer-events-none inline-flex size-5 shrink-0 items-center justify-center"
export const STEP_LABEL = "pointer-events-none text-cc-fg3 transition-colors duration-200 group-hover/row:text-cc-fg2 group-focus-within/row:text-cc-fg2"
export const STEP_TOGGLE = "absolute inset-0 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-cc-accent focus-visible:ring-inset"
/** Expanded content lines up with the label (20 px mark + 8 px gap). */
export const STEP_BODY = "min-w-0 pt-1 pb-2 pl-7 text-sm text-cc-fg2"

/** "+12 −3": added in the diff green, removed in the diff red. */
export function DiffCount({ added, removed, className }: { added: number; removed: number; className?: string }) {
  if (!added && !removed) return null
  return (
    <span className={cn("tabular pointer-events-none inline-flex shrink-0 gap-2 font-medium", className)}>
      <span className="text-cc-add">+{added}</span>
      <span className="text-cc-del">−{removed}</span>
    </span>
  )
}

/** "Ran `npm test`", "Edited src/auth/retry.ts" (the path a link), "Searched the web for rate limits". */
export function ToolLabel({ sessionId, summary }: { sessionId: ID; summary: ToolSummary }) {
  const t = summary.target
  return (
    <>
      <span className={cn(STEP_LABEL, "shrink-0")}>{summary.verb}</span>
      {t?.kind === "path" && t.path ? (
        <PathLink sessionId={sessionId} path={t.path} className="text-foreground" />
      ) : t?.kind === "code" ? (
        <code className="pointer-events-none min-w-0 truncate font-mono text-[13px] text-foreground">{t.text}</code>
      ) : (
        t && <span className="pointer-events-none min-w-0 truncate text-foreground">{t.text}</span>
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
  /** muted detail at the end (duration, counts) */
  trailing?: ReactNode
  /** the call's details, shown while open */
  children?: ReactNode
}) {
  const label = [summary.verb, summary.target?.text, summary.detail].filter(Boolean).join(" ")
  return (
    <div className="min-w-0">
      <div className={STEP_ROW}>
        {onToggle && <button type="button" aria-expanded={open} aria-label={label} onClick={onToggle} className={STEP_TOGGLE} />}
        <span className={cn(STEP_MARK, display === "running" && "text-cc-clay")}>{display === "running" ? <WorkingMark /> : <ToolIcon family={summary.family} name={name} />}</span>
        <ToolLabel sessionId={sessionId} summary={summary} />
        {summary.detail && <span className={cn(STEP_LABEL, "max-w-[40%] shrink-0 truncate")}>{summary.detail}</span>}
        <span className="pointer-events-none flex shrink-0 items-center gap-2">
          <ToolStatus display={display} asks={asks} />
          {onToggle && <Chevron open={open} />}
        </span>
        <span className="tabular pointer-events-none ml-auto flex shrink-0 items-center gap-2 pl-2 text-cc-fg2">
          {summary.meta && <span className={summary.metaTone === "error" ? "text-cc-danger" : undefined}>{summary.meta}</span>}
          {trailing && <span className="whitespace-nowrap">{trailing}</span>}
          {summary.diff && <DiffCount added={summary.diff.added} removed={summary.diff.removed} />}
        </span>
      </div>
      {open && children && <div className={STEP_BODY}>{children}</div>}
    </div>
  )
})
