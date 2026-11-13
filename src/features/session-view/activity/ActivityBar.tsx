// Adapted from BloopAI/vibe-kanban@5f06193:packages/ui/src/components/TodoProgressPopup.tsx (Apache-2.0). Modified for session-dashboard.
// Activity bar above the composer (UI_PLAN §5.3, Zed render_activity_bar as an idea only).
// Calm rules (§2.5): small chips, only for things that carry signal — a plan that is in
// progress, running subagents, changed files (opens Review) and permission requests
// raised by subagents (with once-options). Hidden when there is nothing to show.
import { memo } from "react"
import { useShallow } from "zustand/react/shallow"
import { Bot, FileDiff, ListChecks, ShieldAlert } from "lucide-react"
import type { ID, PermissionRequest } from "@/lib/model"
import { useApp } from "@/store/app"
import { openReview, select } from "@/store/actions"
import { usePendingRequests, useSubagentIds, subagentAsStatus } from "@/store/selectors"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { DiffStat } from "@/components/common/bits"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { capabilities } from "@/lib/status"
import { plural } from "@/lib/format"
import { cn } from "@/lib/utils"
import { focusDockRequest, resolveRequest, useChangedFiles, useDockFocus, useTodos } from "../sessionStore"
import { TodoList } from "../tools/ToolBodies"

const CHIP =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[4px] border border-line-subtle px-1.5 text-[12px] text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-ring aria-expanded:bg-hover aria-expanded:text-fg"

/** In progress: something is being worked on, or part of it is done. A finished or untouched plan carries no signal. */
const planInProgress = (todos: readonly { status: string }[]) => {
  const done = todos.filter((t) => t.status === "completed").length
  return done < todos.length && (done > 0 || todos.some((t) => t.status === "in_progress"))
}

function PlanChip({ sessionId }: { sessionId: ID }) {
  const todos = useTodos(sessionId)
  if (!planInProgress(todos)) return null
  const done = todos.filter((t) => t.status === "completed").length
  const current = todos.find((t) => t.status === "in_progress")
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={CHIP} title={current?.content} aria-label={`Plan: ${done} of ${todos.length} done${current ? `, now: ${current.content}` : ""}`}>
          <ListChecks size={13} className="text-fg-faint" />
          <span className="tabular">
            {done}/{todos.length}
          </span>
          <span className="flex gap-[2px]" aria-hidden>
            {todos.map((t, i) => (
              <span
                key={i}
                className={cn("h-2 w-1 rounded-[1px]", t.status === "completed" ? "bg-fg-muted" : t.status === "in_progress" ? "bg-st-working" : "bg-line")}
              />
            ))}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 gap-2 rounded-md border border-line p-2.5 shadow-lg ring-0">
        <div className="flex items-center justify-between text-[12px]">
          <span className="font-medium text-fg">Plan</span>
          <span className="tabular text-fg-faint">
            {done}/{todos.length}
          </span>
        </div>
        <TodoList todos={todos} />
      </PopoverContent>
    </Popover>
  )
}

function AgentsChip({ sessionId }: { sessionId: ID }) {
  const ids = useSubagentIds(sessionId)
  const subs = useApp(useShallow((s) => ids.map((id) => s.subagents[id]).filter(Boolean)))
  const live = subs.filter((s) => s.status === "running" || s.status === "waiting_permission").length
  if (!live) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={CHIP} title="Subagents">
          <Bot size={13} className="text-fg-faint" />
          <span>{plural(live, "agent")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-96 gap-0 rounded-md border border-line p-1 shadow-lg ring-0">
        {subs.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => select({ kind: "subagent", id: s.id })}
            title={`${s.agentType} · ${s.toolCount} tools`}
            className="flex h-7 min-w-0 items-center gap-2 rounded-[3px] px-1.5 text-left text-[12px] outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-ring"
            style={{ paddingLeft: 6 + (s.spawnDepth - 1) * 14 }}
          >
            <StatusGlyph status={subagentAsStatus(s)} size="xs" />
            <span className="min-w-0 truncate text-fg-muted">{s.description}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function EditsChip({ sessionId }: { sessionId: ID }) {
  const files = useChangedFiles(sessionId)
  if (!files.length) return null
  const added = files.reduce((a, f) => a + f.added, 0)
  const removed = files.reduce((a, f) => a + f.removed, 0)
  return (
    <button type="button" className={CHIP} onClick={() => openReview(sessionId)} title="Review changes">
      <FileDiff size={13} className="text-fg-faint" />
      <span>{plural(files.length, "file")}</span>
      <DiffStat added={added} removed={removed} />
    </button>
  )
}

/** A permission request raised by a subagent, surfaced on the parent (Zed idea). */
function ChildRequest({ req, sessionId, canApprove, more }: { req: PermissionRequest; sessionId: ID; canApprove: boolean; more: number }) {
  const sub = useApp((s) => (req.subagentId ? s.subagents[req.subagentId] : undefined))
  const allow = req.options.find((o) => o.kind === "allow_once")
  const deny = req.options.find((o) => o.kind === "reject_once")
  const subject = req.subject?.type === "command" ? req.subject.command : (req.subject?.path ?? req.title)
  return (
    <div className="flex h-6 min-w-0 items-center gap-1.5 rounded-[4px] border border-st-perm/40 bg-st-perm-tint/60 pr-0.5 pl-1.5 text-[12px]">
      <button
        type="button"
        onClick={() => focusDockRequest(sessionId, req.id)}
        title={`${sub?.agentType ?? "Subagent"} wants ${req.toolName}: ${subject}`}
        className="flex min-w-0 items-center gap-1.5 rounded-[3px] text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ShieldAlert size={12} className="shrink-0 text-st-perm" />
        <span className="shrink-0 text-st-perm-fg">{sub?.agentType ?? "subagent"}</span>
        <code className="min-w-0 truncate font-mono text-[11.5px] text-fg">{subject}</code>
        {more > 0 && <span className="shrink-0 text-[11px] text-fg-faint">+{more}</span>}
      </button>
      <span className="ml-1 flex shrink-0 items-center gap-0.5">
        {allow && (
          <Button size="xs" variant="perm" disabled={!canApprove} onClick={() => resolveRequest(req, allow.id)} title={allow.name}>
            Allow once
          </Button>
        )}
        {deny && (
          <Button size="xs" variant="ghost" disabled={!canApprove} onClick={() => resolveRequest(req, deny.id)}>
            Deny
          </Button>
        )}
      </span>
    </div>
  )
}

export const ActivityBar = memo(function ActivityBar({ sessionId }: { sessionId: ID }) {
  const pending = usePendingRequests(sessionId)
  const control = useApp((s) => s.sessions[sessionId]?.control)
  const showPlan = useApp((s) => planInProgress(s.transcripts[sessionId]?.todos ?? []))
  const hasLiveSubs = useApp((s) =>
    (s.subagentIdsBySession[sessionId] ?? []).some((id) => s.subagents[id]?.status === "running" || s.subagents[id]?.status === "waiting_permission"),
  )
  const files = useChangedFiles(sessionId)
  const focusId = useDockFocus(sessionId)
  // a child request opened in the dock isn't repeated here
  const child = pending.filter((r): r is PermissionRequest => r.type === "permission" && !!r.subagentId && r.id !== focusId)
  if (!showPlan && !hasLiveSubs && !files.length && !child.length) return null
  return (
    <div className="mx-auto flex w-full max-w-[860px] min-w-0 flex-wrap items-center gap-1 px-5 pb-1.5">
      <PlanChip sessionId={sessionId} />
      <AgentsChip sessionId={sessionId} />
      <EditsChip sessionId={sessionId} />
      {child[0] && (
        <div className="ml-auto max-w-full min-w-0">
          <ChildRequest req={child[0]} sessionId={sessionId} canApprove={control ? capabilities(control).approve : false} more={child.length - 1} />
        </div>
      )}
    </div>
  )
})
