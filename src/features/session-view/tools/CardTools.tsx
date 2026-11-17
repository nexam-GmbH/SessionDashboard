// Adapted from BloopAI/vibe-kanban@5f06193:packages/ui/src/components/ChatSubagentEntry.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from vercel/ai-elements@ca8be60:packages/elements/src/plan.tsx (Apache-2.0); subagent card fields after
// agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/subagents/model.ts (MIT): type, description, status, tool count, last tool.
// Changes: the subagent is Claude Code desktop's agent card, following the live Subagent record
// (status, tool count, time) and opening to its brief and its report; the plan is one tool line
// that opens to the plan's markdown (approval itself lives in the attention dock).
import { memo } from "react"
import type { ID, Subagent, ToolCall } from "@/lib/model"
import { useApp } from "@/store/app"
import { useNow } from "@/components/common/RelativeTime"
import { duration } from "@/lib/format"
import { Markdown } from "../markdown/Markdown"
import { useExpanded } from "../sessionStore"
import { cn } from "@/lib/utils"
import { Chevron, ToolIcon, ToolStatus } from "../common"
import { WorkingMark } from "../transcript/Spinner"
import { buildToolSummary, inputOf } from "./toolSummary"
import { STEP_LABEL, STEP_MARK, STEP_ROW, STEP_TOGGLE, ToolLine } from "./ToolLine"

const DISPLAY: Record<Subagent["status"], ToolCall["display"]> = {
  running: "running",
  waiting_permission: "awaiting_permission",
  completed: "done",
  failed: "failed",
  stopped: "cancelled",
}

function SubElapsed({ since }: { since: string }) {
  const now = useNow()
  return <>{duration(Math.max(0, now - Date.parse(since)))}</>
}

/**
 * A subagent as Claude Code desktop's agent card: a card surface with 10 px corners, a 44 px header
 * (mark, "Agent: type", what it does, its time) that opens to its brief and its report.
 */
export const SubagentCard = memo(function SubagentCard({ call, itemId }: { sessionId: ID; call: ToolCall; itemId: ID }) {
  const sub = useApp((s) => (call.subagentId ? s.subagents[call.subagentId] : undefined))
  const [open, setOpen] = useExpanded(`tool:${itemId}`, false)
  const display = sub ? DISPLAY[sub.status] : call.display
  const input = inputOf(call)
  const type = sub?.agentType ?? (typeof input.subagent_type === "string" ? input.subagent_type : undefined)
  const label = type && type !== "general-purpose" ? `Agent: ${type}` : "Agent"
  const what = sub?.description ?? (typeof input.description === "string" ? input.description : call.title)
  const prompt = typeof input.prompt === "string" ? input.prompt : ""
  const report = sub?.summary ?? call.output
  return (
    <div className="overflow-hidden rounded-[10px] bg-cc-card">
      <div className={cn(STEP_ROW, "min-h-11 px-1.5 hover:bg-cc-card-hover")}>
        <button type="button" aria-expanded={open} aria-label={`${label}: ${what}`} onClick={() => setOpen(!open)} className={STEP_TOGGLE} />
        <span className={cn(STEP_MARK, display === "running" && "text-cc-clay")}>{display === "running" ? <WorkingMark /> : <ToolIcon family="agent" />}</span>
        <span className={cn(STEP_LABEL, "shrink-0")}>{label}</span>
        <span className="pointer-events-none min-w-0 truncate text-foreground">{what}</span>
        <span className="pointer-events-none flex shrink-0 items-center gap-2">
          <ToolStatus display={display} />
          <Chevron open={open} />
        </span>
        {sub && (
          <span className="tabular pointer-events-none ml-auto shrink-0 pl-2 whitespace-nowrap text-cc-fg2">
            {sub.finishedAt ? (
              `took ${duration(Math.max(0, Date.parse(sub.finishedAt) - Date.parse(sub.startedAt)))}`
            ) : (
              <>
                {sub.toolCount} {sub.toolCount === 1 ? "tool" : "tools"} · <SubElapsed since={sub.startedAt} />
              </>
            )}
          </span>
        )}
      </div>
      {open && (
        <div className="flex flex-col border-t border-cc-wash px-1.5 pb-2 pl-9 text-sm">
          {prompt && (
            <>
              <div className="flex h-9 items-center text-cc-fg3">Sent to the agent</div>
              <div className="line-clamp-6 whitespace-pre-wrap text-cc-fg2 select-text">{prompt}</div>
            </>
          )}
          {report && (
            <>
              <div className="flex h-9 items-center text-cc-fg3">Report from subagent</div>
              <div className="max-h-[320px] overflow-auto pr-2">
                <Markdown content={report} className="sd-markdown-muted" />
              </div>
            </>
          )}
          {!prompt && !report && <div className="flex h-9 items-center text-cc-fg3">Waiting for the result</div>}
        </div>
      )}
    </div>
  )
})

/** ExitPlanMode: the plan as markdown; approval itself lives in the attention dock. */
export const PlanCard = memo(function PlanCard({ sessionId, call, itemId }: { sessionId: ID; call: ToolCall; itemId: ID }) {
  const pending = call.display === "awaiting_permission"
  // Collapsed by default: a pending plan is shown in full in the attention dock.
  const [open, setOpen] = useExpanded(`plan:${itemId}`, false)
  const plan = typeof (call.input as { plan?: unknown }).plan === "string" ? (call.input as { plan: string }).plan : ""
  return (
    <ToolLine
      sessionId={sessionId}
      summary={buildToolSummary(call)}
      display={pending ? "awaiting_permission" : call.display === "rejected" ? "rejected" : "done"}
      asks={pending}
      open={open}
      onToggle={plan ? () => setOpen(!open) : undefined}
    >
      {plan && (
        <div className="max-h-[360px] overflow-auto rounded-xl bg-cc-card px-3 py-2 text-foreground">
          <Markdown content={plan} />
        </div>
      )}
    </ToolLine>
  )
})
