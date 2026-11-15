// Adapted from BloopAI/vibe-kanban@5f06193:packages/ui/src/components/TodoProgressPopup.tsx (Apache-2.0). Modified for session-dashboard.
// Activity bar above the composer.
// Calm rules: small chips, only for things that carry signal — a plan that is in
// progress, running subagents, changed files (opens Review) and permission requests
// raised by subagents (with once-options). Hidden when there is nothing to show.
import { memo } from "react"
import { useShallow } from "zustand/react/shallow"
import { Bot, ChevronDown, CircleCheck, CircleDashed, CircleDot, ListChecks, Repeat, ShieldAlert } from "lucide-react"
import type { ID, PermissionRequest } from "@/lib/model"
import { useApp } from "@/store/app"
import { usePendingRequests, useSubagentIds, subagentAsStatus } from "@/store/selectors"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { capabilities } from "@/lib/status"
import { plural } from "@/lib/format"
import { cn } from "@/lib/utils"
import { focusDockRequest, useDockFocus, useExpanded, useTodos } from "../sessionStore"
import { STEP_BACK, useStuck } from "../signals"
import { useAway } from "@/store/away"
import { SinceCard } from "./SinceCard"
import { sendMessage } from "@/store/actions"
import { Button } from "@/components/ui/button"
import { onceOptions, OnceButtons } from "@/features/requests/OnceAnswers"

const CHIP =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-foreground"

/** A plan with work left: shown above the prompt box (Claude Code desktop's plan card). */
const planOpen = (todos: readonly { status: string }[]) => todos.length > 0 && todos.some((t) => t.status !== "completed")

/** Claude's todo list above the prompt box, while it has work left. Click the header to fold it. */
function PlanCard({ sessionId }: { sessionId: ID }) {
  const todos = useTodos(sessionId)
  const [open, setOpen] = useExpanded(`plan:${sessionId}`, true)
  if (!planOpen(todos)) return null
  const done = todos.filter((t) => t.status === "completed").length
  return (
    <div className="mb-2 rounded-xl bg-card px-3 py-2 ring-1 ring-foreground/10">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-6 w-full items-center gap-2 rounded-md text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ListChecks size={14} className="shrink-0" />
        <span className="font-medium">Plan</span>
        <span className="tabular text-muted-foreground/70">
          {done} of {todos.length} done
        </span>
        <ChevronDown size={13} className={cn("ml-auto shrink-0 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <ul className="mt-1 flex max-h-44 flex-col gap-0.5 overflow-y-auto pb-0.5">
          {todos.map((t, i) => (
            <li key={i} className="flex min-w-0 items-start gap-2 py-0.5 text-sm">
              {t.status === "completed" ? (
                <CircleCheck size={15} className="mt-0.5 shrink-0 text-muted-foreground/70" />
              ) : t.status === "in_progress" ? (
                <CircleDot size={15} className="mt-0.5 shrink-0 text-st-working" />
              ) : (
                <CircleDashed size={15} className="mt-0.5 shrink-0 text-muted-foreground/70" />
              )}
              <span className={cn("min-w-0", t.status === "completed" ? "text-muted-foreground/70 line-through" : t.status === "in_progress" ? "text-foreground" : "text-muted-foreground")}>{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
          <Bot size={13} className="text-muted-foreground/70" />
          <span>{plural(live, "agent")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-96 gap-0 rounded-md border border-border p-1 shadow-lg ring-0">
        {subs.map((s) => (
          <div
            key={s.id}
            title={`${s.agentType} · ${s.toolCount} tools`}
            className="flex h-7 min-w-0 items-center gap-2 rounded-sm px-1.5 text-xs"
            style={{ paddingLeft: 6 + (s.spawnDepth - 1) * 14 }}
          >
            <StatusGlyph status={subagentAsStatus(s)} size="xs" />
            <span className="shrink-0 text-muted-foreground/70">{s.agentType}</span>
            <span className="min-w-0 truncate text-muted-foreground">{s.description}</span>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** A permission request raised by a subagent, surfaced on the parent (Zed idea). */
function ChildRequest({ req, sessionId, canApprove, more }: { req: PermissionRequest; sessionId: ID; canApprove: boolean; more: number }) {
  const sub = useApp((s) => (req.subagentId ? s.subagents[req.subagentId] : undefined))
  const once = onceOptions(req)
  const subject = req.subject?.type === "command" ? req.subject.command : (req.subject?.path ?? req.title)
  return (
    <div className="flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-st-perm/40 bg-st-perm-tint/60 pr-0.5 pl-1.5 text-xs">
      <button
        type="button"
        onClick={() => focusDockRequest(sessionId, req.id)}
        title={`${sub?.agentType ?? "Subagent"} wants ${req.toolName}: ${subject}`}
        className="flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ShieldAlert size={12} className="shrink-0 text-st-perm" />
        <span className="shrink-0 text-st-perm-fg">{sub?.agentType ?? "subagent"}</span>
        <code className="min-w-0 truncate font-mono text-xs text-foreground">{subject}</code>
        {more > 0 && <span className="shrink-0 text-xs text-muted-foreground/70">+{more}</span>}
      </button>
      <span className="ml-1 flex shrink-0 items-center gap-0.5">
        {once && <OnceButtons once={once} disabled={!canApprove} />}
      </span>
    </div>
  )
}

/**
 * The same step failed 3+ times this turn: say so, and offer to have Claude step back and re-plan
 * instead of trying a fourth time. Dismissed until the loop grows.
 */
function StuckCard({ sessionId, canSend }: { sessionId: ID; canSend: boolean }) {
  const s = useStuck(sessionId)
  const [gone, setGone] = useExpanded(`stuck:${sessionId}:${s?.what ?? ""}:${s?.count ?? 0}`, false)
  if (!s || gone) return null
  return (
    <div role="status" className="mb-2 flex min-w-0 items-center gap-2 rounded-xl bg-card px-3 py-2 text-xs ring-1 ring-foreground/10">
      <Repeat size={14} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground">Failed {s.count} times in a row: </span>
        <code className="font-mono text-muted-foreground break-all">{s.what}</code>
      </span>
      {canSend && (
        <Button size="xs" variant="outline" onClick={() => {
            sendMessage(sessionId, STEP_BACK, "now")
            setGone(true)
          }} title={STEP_BACK}>
          Step back
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={() => setGone(true)}>
        Dismiss
      </Button>
    </div>
  )
}

export const ActivityBar = memo(function ActivityBar({ sessionId }: { sessionId: ID }) {
  const pending = usePendingRequests(sessionId)
  const control = useApp((s) => s.sessions[sessionId]?.control)
  const showPlan = useApp((s) => planOpen(s.transcripts[sessionId]?.todos ?? []))
  const hasLiveSubs = useApp((s) =>
    (s.subagentIdsBySession[sessionId] ?? []).some((id) => s.subagents[id]?.status === "running" || s.subagents[id]?.status === "waiting_permission"),
  )
  const focusId = useDockFocus(sessionId)
  // a child request opened in the dock isn't repeated here
  const child = pending.filter((r): r is PermissionRequest => r.type === "permission" && !!r.subagentId && r.id !== focusId)
  const isStuck = useStuck(sessionId) !== null
  const away = useAway(sessionId) !== null
  if (!showPlan && !hasLiveSubs && !child.length && !isStuck && !away) return <SinceCard sessionId={sessionId} />
  return (
    <div className="mx-auto w-full max-w-[var(--chat-w)] min-w-0 px-5 pb-1.5">
      <SinceCard sessionId={sessionId} />
      <StuckCard sessionId={sessionId} canSend={control ? capabilities(control).send : false} />
      <PlanCard sessionId={sessionId} />
      <div className="flex min-w-0 flex-wrap items-center gap-1">
      <AgentsChip sessionId={sessionId} />
      {child[0] && (
        <div className="ml-auto max-w-full min-w-0">
          <ChildRequest req={child[0]} sessionId={sessionId} canApprove={control ? capabilities(control).approve : false} more={child.length - 1} />
        </div>
      )}
      </div>
    </div>
  )
})
