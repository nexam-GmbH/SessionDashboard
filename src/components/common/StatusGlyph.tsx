// Adapted from stablyai/orca@3bb91aa:src/renderer/src/components/AgentStateDot.tsx (MIT).
// Modified for session-dashboard: our SessionStatus set, glyph + color
// per status, native title instead of a Radix tooltip (cheap in long lists).
import { memo, useEffect, useRef } from "react"
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleSlash,
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
}: Props) {
  const el = useAttentionPulse(status)
  const g = STATUS_GLYPH[status]
  const Icon = g.icon
  const label = title === null ? undefined : (title ?? STATUS_LABEL[status])
  return (
    <span
      ref={el}
      role="img"
      aria-label={STATUS_LABEL[status]}
      title={label}
      className={cn("inline-flex shrink-0 items-center justify-center", BOX[size], className)}
    >
      <Icon
        size={ICON[size] - (g.inset ?? 0)}
        strokeWidth={g.stroke}
        color={glyphColor(status)}
        fill={glyphFill(status)}
        className={status === "working" && animate ? "animate-spin-steps" : undefined}
      />
    </span>
  )
})
