// Adapted from stablyai/orca@3bb91aa:src/renderer/src/components/AgentStateDot.tsx (MIT).
// Modified for session-dashboard: our SessionStatus set, glyph + color
// per status, native title instead of a Radix tooltip (cheap in long lists).
import { memo, useEffect, useRef } from "react"
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  LoaderCircle,
  MessageCircleQuestion,
  OctagonX,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { SessionStatus } from "@/lib/model"
import { STATUS_COLOR, STATUS_LABEL } from "@/lib/status"
import { getApp } from "@/store/app"
import { OUTCOME_COLOR, OUTCOME_TINT, type Outcome, type OutcomeKind } from "@/lib/outcome"

/**
 * The one status glyph set, shared with the map's CompactGlyph. `inset` draws the
 * quiet round glyphs (idle, stopped) a little smaller so they don't outweigh the attention ones.
 */
export const STATUS_GLYPH: Record<SessionStatus, { icon: LucideIcon; stroke: number; inset?: number }> = {
  waiting_permission: { icon: ShieldAlert, stroke: 2 },
  waiting_input: { icon: MessageCircleQuestion, stroke: 2 },
  error: { icon: OctagonX, stroke: 2 },
  done_unseen: { icon: CircleCheck, stroke: 2.25 },
  working: { icon: LoaderCircle, stroke: 2.5 },
  starting: { icon: CircleDashed, stroke: 2 },
  idle: { icon: Circle, stroke: 2.25, inset: 2 },
  stopped: { icon: CircleSlash, stroke: 1.75, inset: 1 },
}

/** A session that does not run shows how its work ended: one shape per colour, so it reads without colour too. */
const OUTCOME_ICON: Record<OutcomeKind, LucideIcon> = {
  limit: OctagonX,
  error: OctagonX,
  aborted: OctagonX,
  uncommitted: GitPullRequestDraft,
  unpushed: GitPullRequestDraft,
  no_pr: GitPullRequestDraft,
  pr: GitPullRequest,
  merged: GitMerge,
  landed: GitMerge,
  removed: CircleCheck,
  done: CircleCheck,
  marked: CircleCheck,
}
const AT_REST = new Set<SessionStatus>(["idle", "done_unseen", "stopped"])

export const glyphColor = (status: SessionStatus) => (status === "stopped" ? "color-mix(in oklab, var(--muted-foreground) 70%, transparent)" : STATUS_COLOR[status])
export const glyphFill = (status: SessionStatus) => (status === "done_unseen" ? "var(--st-done-tint)" : "none")

type Props = {
  status: SessionStatus
  size?: "xs" | "sm" | "md"
  className?: string
  /** override tooltip; null = none */
  title?: string | null
  /** turn the working glyph (everywhere by default: a working session should look like it is working) */
  animate?: boolean
  /** how its work ended: shown instead of idle / done / stopped */
  outcome?: Outcome
}

const ATTENTION = new Set<SessionStatus>(["waiting_permission", "waiting_input", "error"])

/** One slow pulse, twice, when a glyph on screen turns to "needs you"; never on first paint. */
function useAttentionPulse(status: SessionStatus) {
  const el = useRef<HTMLSpanElement>(null)
  const prev = useRef(status)
  useEffect(() => {
    const was = prev.current
    prev.current = status
    if (was === status || !ATTENTION.has(status) || ATTENTION.has(was)) return
    if (getApp().settings.reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches) return
    el.current?.animate(
      [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(1.3)", opacity: 0.55 }, { transform: "scale(1)", opacity: 1 }],
      { duration: 900, iterations: 2, easing: "ease-in-out" },
    )
  }, [status])
  return el
}

const BOX = { xs: "size-3", sm: "size-3.5", md: "size-4" } as const
const ICON = { xs: 11, sm: 13, md: 15 } as const

export const StatusGlyph = memo(function StatusGlyph({
  status,
  size = "sm",
  className,
  title,
  animate = true,
  outcome,
}: Props) {
  const el = useAttentionPulse(status)
  const g = STATUS_GLYPH[status]
  const end = outcome && AT_REST.has(status) ? outcome : undefined
  const Icon = end ? OUTCOME_ICON[end.kind] : g.icon
  const name = end ? end.label : STATUS_LABEL[status]
  const label = title === null ? undefined : (title ?? name)
  return (
    <span
      ref={el}
      role="img"
      aria-label={name}
      title={label}
      className={cn("inline-flex shrink-0 items-center justify-center", BOX[size], className)}
    >
      <Icon
        size={ICON[size] - (end ? 1 : (g.inset ?? 0))}
        strokeWidth={end ? 2.25 : g.stroke}
        color={end ? OUTCOME_COLOR[end.tone] : glyphColor(status)}
        // not looked at yet: filled with its colour's tint (the colour itself stays after you look)
        fill={end ? (status === "done_unseen" ? OUTCOME_TINT[end.tone] : "none") : glyphFill(status)}
        className={status === "working" && animate ? "animate-spin-steps" : undefined}
      />
    </span>
  )
})
