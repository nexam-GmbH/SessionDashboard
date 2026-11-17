// Adapted from BloopAI/vibe-kanban@5f06193:packages/ui/src/components/ChatSubagentEntry.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from vercel/ai-elements@ca8be60:packages/elements/src/plan.tsx (Apache-2.0); subagent card fields after
// agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/subagents/model.ts (MIT): type, description, status, tool count, last tool.
// Changes: both render as one tool line like the other calls. The subagent line follows the live
// Subagent record (status, tool count, time) and opens to its brief and its report; the plan line
// opens to the plan's markdown (approval itself lives in the attention dock).
import { memo } from "react"
import type { ID, Subagent, ToolCall } from "@/lib/model"
import { useApp } from "@/store/app"
import { useNow } from "@/components/common/RelativeTime"
import { duration } from "@/lib/format"
import { Markdown } from "../markdown/Markdown"
import { useExpanded } from "../sessionStore"
import { buildToolSummary } from "./toolSummary"
import { ToolLine } from "./ToolLine"

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

export const SubagentCard = memo(function SubagentCard({ sessionId, call, itemId }: { sessionId: ID; call: ToolCall; itemId: ID }) {
  const sub = useApp((s) => (call.subagentId ? s.subagents[call.subagentId] : undefined))
  const [open, setOpen] = useExpanded(`tool:${itemId}`, false)
  const display = sub ? DISPLAY[sub.status] : call.display
  const base = buildToolSummary({ ...call, display })
  const summary = { ...base, detail: sub?.agentType && sub.agentType !== "general-purpose" ? sub.agentType : base.detail, target: sub?.description ? { text: sub.description, kind: "text" as const } : base.target }
  const prompt = typeof (call.input as { prompt?: unknown }).prompt === "string" ? (call.input as { prompt: string }).prompt : ""
  const report = sub?.summary ?? call.output
  return (
    <ToolLine
      sessionId={sessionId}
      summary={summary}
      display={display}
      open={open}
      onToggle={() => setOpen(!open)}
      trailing={
        sub && (
          <>
            {sub.toolCount} {sub.toolCount === 1 ? "tool" : "tools"} ·{" "}
            {sub.finishedAt ? duration(Math.max(0, Date.parse(sub.finishedAt) - Date.parse(sub.startedAt))) : <SubElapsed since={sub.startedAt} />}
          </>
        )
      }
    >
      <div className="flex flex-col gap-2">
        {prompt && <div className="line-clamp-4 whitespace-pre-wrap text-cc-fg3 select-text">{prompt}</div>}
        {report && (
          <div className="max-h-[320px] overflow-auto rounded-xl bg-cc-card px-3 py-2">
            <Markdown content={report} className="sd-markdown-muted" />
          </div>
        )}
      </div>
    </ToolLine>
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
