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
import { compact, duration, plural } from "@/lib/format"
import { useShallow } from "zustand/react/shallow"
import { ArrowUpRight } from "lucide-react"
import { Markdown } from "../markdown/Markdown"
import { setUiValue, useExpanded } from "../sessionStore"
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
export const SubagentCard = memo(function SubagentCard({ sessionId, call, itemId }: { sessionId: ID; call: ToolCall; itemId: ID }) {
  // the subagent this call started: its id (mock world), else the agent whose meta names this call
  const sub = useApp((s) => (call.subagentId ? s.subagents[call.subagentId] : (s.subagentIdsBySession[sessionId] ?? []).map((a) => s.subagents[a]).find((a) => a?.parentToolUseId === call.id)))
  const [open, setOpen] = useExpanded(`tool:${itemId}`, false)
  const display = sub ? DISPLAY[sub.status] : call.display
  const input = inputOf(call)
  const type = sub?.agentType ?? (typeof input.subagent_type === "string" ? input.subagent_type : undefined)
  const label = type && type !== "general-purpose" ? `Agent: ${type}` : "Agent"
  const what = sub?.description ?? (typeof input.description === "string" ? input.description : call.title)
  const prompt = typeof input.prompt === "string" ? input.prompt : ""
  // a background agent's call returns at once ("launched"): its report is its own last answer
  const report = sub?.summary ?? (sub?.background ? undefined : call.output)
  const running = display === "running" || display === "awaiting_permission"
  return (
    <div className="overflow-hidden rounded-[10px] bg-cc-card">
      <div className={cn(STEP_ROW, "min-h-11 px-1.5 hover:bg-cc-card-hover")}>
        <button type="button" aria-expanded={open} aria-label={`${label}: ${what}`} onClick={() => setOpen(!open)} className={STEP_TOGGLE} />
        <span className={cn(STEP_MARK, running && "text-cc-clay")}>{running ? <WorkingMark /> : <ToolIcon family="agent" />}</span>
        <span className={cn(STEP_LABEL, "shrink-0")}>{label}</span>
        <span className="pointer-events-none min-w-0 truncate text-foreground">{what}</span>
        <span className="pointer-events-none flex shrink-0 items-center gap-2">
          <ToolStatus display={display} />
          <Chevron open={open} />
        </span>
        {sub && (
          <span className="pointer-events-none ml-auto shrink-0 pl-2 whitespace-nowrap text-cc-fg2 tabular">
            {sub.finishedAt ? (
              `${plural(sub.toolCount, "tool")} · took ${duration(Math.max(0, Date.parse(sub.finishedAt) - Date.parse(sub.startedAt)))}`
            ) : (
              <>
                {plural(sub.toolCount, "tool")} · <SubElapsed since={sub.startedAt} />
              </>
            )}
          </span>
        )}
        {sub?.path && <OpenAgent sessionId={sessionId} agentId={sub.id} />}
      </div>
      {/* what it does right now, under its name, while it works */}
      {sub && running && sub.activity && <div className="truncate px-1.5 pb-2 pl-9 text-[13px] text-cc-fg2">{sub.activity}</div>}
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

/** Opens the agent's own chat in place of the session's (Esc or Back returns). */
function OpenAgent({ sessionId, agentId }: { sessionId: ID; agentId: ID }) {
  return (
    <button
      type="button"
      onClick={() => openSubagent(sessionId, agentId)}
      className="relative z-10 ml-2 flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[13px] text-cc-fg2 hover:bg-cc-wash hover:text-foreground"
      title="Open this agent's chat"
    >
      Open <ArrowUpRight size={13} />
    </button>
  )
}

/** Open a subagent's chat in its session's view. */
export function openSubagent(sessionId: ID, agentId: ID) {
  setUiValue(`subview:${sessionId}`, agentId)
  void import("@/backend/real").then((r) => r.realOpenSubagent(agentId))
}

/**
 * A Workflow run: its name, how far it is (phase by phase: agents done of started), its tokens;
 * opens to its agents, each of which opens its own chat.
 */
export const WorkflowCard = memo(function WorkflowCard({ sessionId, call, itemId }: { sessionId: ID; call: ToolCall; itemId: ID }) {
  const [open, setOpen] = useExpanded(`tool:${itemId}`, false)
  const input = inputOf(call)
  const runId = /\b(wf_[0-9a-f-]+)/.exec(call.output ?? "")?.[1]
  const run = useApp((s) => (runId ? s.workflowRuns?.[sessionId]?.find((r) => r.runId === runId) : undefined))
  const agents = useApp(useShallow((s) => (runId ? (s.subagentIdsBySession[sessionId] ?? []).map((a) => s.subagents[a]).filter((a): a is Subagent => a?.workflow === runId) : EMPTY_SUBS)))
  const name = run?.name ?? (typeof input.name === "string" ? input.name : "Workflow")
  const working = agents.filter((a) => a.status === "running" || a.status === "waiting_permission")
  const done = agents.filter((a) => a.status === "completed").length
  const finished = run?.status === "completed" || run?.status === "failed" || (agents.length > 0 && !working.length && !!run?.status)
  const display: ToolCall["display"] = run?.status === "failed" ? "failed" : finished ? "done" : agents.length && !working.length ? "cancelled" : call.display === "failed" ? "failed" : "running"
  // phases in the script's order, then any its agents named that the script did not list
  const phases = [...(run?.phases ?? []), ...new Set(agents.map((a) => a.phase).filter((p): p is string => !!p && !run?.phases.includes(p)))]
  const now = working.at(-1)?.phase
  return (
    <div className="overflow-hidden rounded-[10px] bg-cc-card">
      <div className={cn(STEP_ROW, "min-h-11 px-1.5 hover:bg-cc-card-hover")}>
        <button type="button" aria-expanded={open} aria-label={`Workflow: ${name}`} onClick={() => setOpen(!open)} className={STEP_TOGGLE} />
        <span className={cn(STEP_MARK, display === "running" && "text-cc-clay")}>{display === "running" ? <WorkingMark /> : <ToolIcon family="agent" />}</span>
        <span className={cn(STEP_LABEL, "shrink-0")}>Workflow</span>
        <span className="pointer-events-none min-w-0 truncate text-foreground">{name}</span>
        <span className="pointer-events-none flex shrink-0 items-center gap-2">
          <ToolStatus display={display} />
          <Chevron open={open} />
        </span>
        <span className="pointer-events-none ml-auto shrink-0 pl-2 whitespace-nowrap text-cc-fg2 tabular">
          {agents.length ? `${done}/${plural(agents.length, "agent")}` : ""}
          {run?.totalTokens ? ` · ${compact(run.totalTokens)} tokens` : ""}
        </span>
      </div>
      {display === "running" && (now || working.length > 0) && (
        <div className="truncate px-1.5 pb-2 pl-9 text-[13px] text-cc-fg2">
          {now ? `${now} · ` : ""}
          {plural(working.length, "agent")} working
        </div>
      )}
      {open && (
        <div className="flex flex-col border-t border-cc-wash px-1.5 pt-1 pb-2 pl-9 text-sm">
          {phases.length === 0 && !agents.length && <div className="flex h-9 items-center text-cc-fg3">No agents yet</div>}
          {(phases.length ? phases : [undefined]).map((p) => {
            const of = agents.filter((a) => (p ? a.phase === p : true))
            if (!of.length && !p) return null
            return (
              <div key={p ?? "-"} className="flex flex-col">
                {p && (
                  <div className="flex h-8 items-center justify-between text-cc-fg3">
                    <span>{p}</span>
                    <span className="tabular">{of.length ? `${of.filter((a) => a.status === "completed").length}/${of.length}` : "—"}</span>
                  </div>
                )}
                {of.slice(0, 60).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => openSubagent(sessionId, a.id)}
                    className="flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-[13px] hover:bg-cc-wash"
                    title="Open this agent's chat"
                  >
                    <span className={cn("shrink-0", a.status === "running" ? "text-cc-clay" : "text-cc-fg3")}>{a.status === "running" ? <WorkingMark /> : <ToolIcon family="agent" />}</span>
                    <span className="min-w-0 flex-1 truncate text-cc-fg">{a.description || a.agentType}</span>
                    <span className="shrink-0 text-cc-fg3 tabular">{a.status === "running" ? (a.activity ?? "") : plural(a.toolCount, "tool")}</span>
                  </button>
                ))}
                {of.length > 60 && <div className="px-1.5 text-[13px] text-cc-fg3">and {of.length - 60} more</div>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
})
const EMPTY_SUBS: Subagent[] = []

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
