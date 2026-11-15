// Adapted from stablyai/orca@3bb91aa:src/renderer/src/components/AgentStateDot.tsx (MIT).
// Modified for session-dashboard: our SessionStatus set (UI_PLAN §2.3), glyph + color
// per status, native title instead of a Radix tooltip (cheap in long lists).
import { memo } from "react"
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

/**
 * The one status glyph set (UI_PLAN §2.3), shared with the map's CompactGlyph. `inset` draws the
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
  /** animate the working spinner (only visible, on-screen glyphs should) */
  animate?: boolean
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
  const g = STATUS_GLYPH[status]
  const Icon = g.icon
  const label = title === null ? undefined : (title ?? STATUS_LABEL[status])
  return (
    <span
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
