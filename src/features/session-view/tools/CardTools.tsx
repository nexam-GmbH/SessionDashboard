// Adapted from BloopAI/vibe-kanban@5f06193:packages/ui/src/components/ChatSubagentEntry.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from vercel/ai-elements@ca8be60:packages/elements/src/plan.tsx (Apache-2.0); subagent card fields after
// agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/subagents/model.ts (MIT): type, description, status, tool count, last tool.
// Changes: both render as one 24px row like the other tools (calm rules §2.5). The
// subagent row links to the live Subagent record (select → inspector); type, tool
// count and time show on hover, a waiting permission or failure stays visible. The
// plan row expands to the plan's markdown; approval itself lives in the attention dock.
import { memo } from "react"
import { ChevronRight } from "lucide-react"
import type { ID, Subagent, ToolCall } from "@/lib/model"
import { useApp } from "@/store/app"
import { select } from "@/store/actions"
import { useNow } from "@/components/common/RelativeTime"
import { cn } from "@/lib/utils"
import { duration } from "@/lib/format"
import { Markdown } from "../markdown/Markdown"
import { Chevron, Rail, ToolStatusDot } from "../common"
import { useExpanded } from "../sessionStore"

const DOT: Record<Subagent["status"], ToolCall["display"]> = {
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

const ROW = "group/tool flex h-6 w-full min-w-0 items-center gap-2 rounded-[3px] pr-1.5 pl-0.5 text-left text-[12.5px] outline-none hover:bg-hover/60 focus-visible:bg-hover/60"
const ON_HOVER = "hidden group-hover/tool:inline group-focus-visible/tool:inline"

export const SubagentCard = memo(function SubagentCard({ call }: { call: ToolCall }) {
  const sub = useApp((s) => (call.subagentId ? s.subagents[call.subagentId] : undefined))
  const input = call.input as { subagent_type?: string; description?: string }
  const type = sub?.agentType ?? input.subagent_type ?? "agent"
  const desc = sub?.description ?? input.description ?? call.title
  const display = sub ? DOT[sub.status] : call.display
  const open = () => sub && select({ kind: "subagent", id: sub.id })
  const tip = [type, sub && `${sub.toolCount} tools`, sub?.summary].filter(Boolean).join(" · ")
  return (
    <button type="button" onClick={open} disabled={!sub} title={tip} className={cn(ROW, "disabled:hover:bg-transparent")}>
      <ToolStatusDot display={display} />
      <span className="w-[52px] shrink-0 truncate text-[12px] text-fg-faint">Agent</span>
      <span className="min-w-0 flex-1 truncate text-fg-muted group-hover/tool:text-fg">{desc}</span>
      {sub?.status === "waiting_permission" && <span className="shrink-0 text-[11px] text-st-perm-fg">needs permission</span>}
      {sub?.status === "failed" && <span className="shrink-0 text-[11px] text-st-error-fg">failed</span>}
      {sub && (
        <span className={cn("tabular shrink-0 text-[11px] text-fg-faint", ON_HOVER)}>
          <span className="font-mono">{type}</span> · {sub.toolCount} tools ·{" "}
          {sub.finishedAt ? duration(Math.max(0, Date.parse(sub.finishedAt) - Date.parse(sub.startedAt))) : <SubElapsed since={sub.startedAt} />}
        </span>
      )}
      {sub && <ChevronRight size={12} className="shrink-0 text-fg-faint opacity-0 group-hover/tool:opacity-100" />}
    </button>
  )
})

/** ExitPlanMode: the plan as markdown; approval itself lives in the attention dock. */
export const PlanCard = memo(function PlanCard({ call, itemId }: { call: ToolCall; itemId: ID }) {
  const pending = call.display === "awaiting_permission"
  // Collapsed by default: a pending plan is shown in full in the attention dock.
  const [open, setOpen] = useExpanded(`plan:${itemId}`, false)
  const plan = typeof (call.input as { plan?: unknown }).plan === "string" ? (call.input as { plan: string }).plan : ""
  return (
    <div className="min-w-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={ROW}>
        <ToolStatusDot display={call.display} tone={pending ? "input" : undefined} />
        <span className="w-[52px] shrink-0 truncate text-[12px] text-fg-faint">Plan</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted group-hover/tool:text-fg">{pending ? "Ready for approval" : "Presented plan"}</span>
        <Chevron open={open} className={open ? undefined : "opacity-0 group-hover/tool:opacity-100"} />
      </button>
      {open && plan && (
        <Rail>
          <div className="max-h-[320px] overflow-auto">
            <Markdown content={plan} />
          </div>
        </Rail>
      )}
    </div>
  )
})
