// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-chat/index.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from BloopAI/vibe-kanban@5f06193:packages/ui/src/components/ChatToolSummary.tsx (Apache-2.0).
// Changes: Cline's ToolActivity/ToolActivityTrigger/ToolActivityContent become one 24px
// row = status dot · tool name column · one-line summary; meta, ± and duration show on
// hover (calm rules §2.5, errors stay visible). Every row starts collapsed; a click
// opens the per-tool body on a rail. Selects only its own item from the store;
// disclosure state survives virtualization.
import { memo } from "react"
import type { ID, ToolCall } from "@/lib/model"
import { DiffStat } from "@/components/common/bits"
import { cn } from "@/lib/utils"
import { duration } from "@/lib/format"
import { Chevron, Rail, ToolStatusDot } from "../common"
import { useExpanded, useItem } from "../sessionStore"
import { buildToolSummary, toolDurationMs, type ToolLabelPart } from "./toolSummary"
import { ToolBody } from "./ToolBodies"
import { PlanCard, SubagentCard } from "./CardTools"

function LabelParts({ parts }: { parts: ToolLabelPart[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <span
          key={i}
          className={cn(p.code && "font-mono text-xs", p.muted ? "text-muted-foreground/70" : "text-muted-foreground group-hover/tool:text-foreground")}
        >
          {p.text}
        </span>
      ))}
    </>
  )
}

export const ToolRow = memo(function ToolRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useItem(sessionId, itemId)
  if (item?.type !== "tool_call") return null
  return <ToolRowInner call={item.call} itemId={itemId} />
})

/** Shown only while the row is hovered or focused; it keeps its space, so the label never reflows. */
const ON_HOVER = "opacity-0 transition-opacity duration-100 group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100"

const ToolRowInner = memo(function ToolRowInner({ call, itemId }: { call: ToolCall; itemId: ID }) {
  const summary = buildToolSummary(call)
  // Inputs and outputs are one click away: every row starts collapsed.
  const [open, setOpen] = useExpanded(`tool:${itemId}`, false)
  if (summary.family === "agent") return <SubagentCard call={call} />
  if (summary.family === "plan") return <PlanCard call={call} itemId={itemId} />
  const ms = toolDurationMs(call)
  const waiting = call.display === "awaiting_permission"
  // AskUserQuestion waits for an answer (input, amber), everything else for permission (orange).
  const asks = summary.family === "question"
  const errorMeta = summary.metaTone === "error"
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={waiting ? (asks ? "Waiting for your answer" : "Waiting for your approval") : undefined}
        className="group/tool flex h-6 w-full min-w-0 items-center gap-2 rounded-sm pr-1.5 pl-0.5 text-left text-xs outline-none hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring/60"
      >
        <ToolStatusDot display={call.display} tone={asks ? "input" : undefined} />
        <span className="w-[52px] shrink-0 truncate text-xs text-muted-foreground/70">{summary.name}</span>
        <span className="min-w-0 flex-1 truncate">
          <LabelParts parts={summary.parts} />
        </span>
        {(call.display === "rejected" || call.display === "cancelled") && (
          <span className="shrink-0 text-xs text-muted-foreground/70">{call.display === "rejected" ? "denied" : "cancelled"}</span>
        )}
        {summary.meta && (
          <span className={cn("tabular shrink-0 text-xs", errorMeta ? "text-st-error-fg" : cn("text-muted-foreground/70", ON_HOVER))}>{summary.meta}</span>
        )}
        {summary.diff && <DiffStat added={summary.diff.added} removed={summary.diff.removed} className={cn("shrink-0", ON_HOVER)} />}
        {ms !== undefined && <span className={cn("tabular shrink-0 text-xs whitespace-nowrap text-muted-foreground/70", ON_HOVER)}>{duration(ms)}</span>}
        <Chevron open={open} className={open ? undefined : "opacity-0 group-hover/tool:opacity-100"} />
      </button>
      {open && (
        <Rail>
          <ToolBody call={call} family={summary.family} />
        </Rail>
      )}
    </div>
  )
})
