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
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { SessionStatus } from "@/lib/model"
import { STATUS_COLOR, STATUS_LABEL } from "@/lib/status"

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
  const px = ICON[size]
  const color = STATUS_COLOR[status]
  const label = title === null ? undefined : (title ?? STATUS_LABEL[status])
  let icon: React.ReactNode
  switch (status) {
    case "waiting_permission":
      icon = <ShieldAlert size={px} strokeWidth={2} color={color} />
      break
    case "waiting_input":
      icon = <MessageCircleQuestion size={px} strokeWidth={2} color={color} />
      break
    case "error":
      icon = <OctagonX size={px} strokeWidth={2} color={color} />
      break
    case "done_unseen":
      icon = <CircleCheck size={px} strokeWidth={2.25} color={color} fill="var(--st-done-tint)" />
      break
    case "working":
      icon = (
        <LoaderCircle
          size={px}
          strokeWidth={2.5}
          color={color}
          className={animate ? "animate-spin-slow" : undefined}
        />
      )
      break
    case "starting":
      icon = <CircleDashed size={px} strokeWidth={2} color={color} />
      break
    case "idle":
      icon = <Circle size={px - 2} strokeWidth={2.25} color={color} />
      break
    case "stopped":
      icon = <CircleSlash size={px - 1} strokeWidth={1.75} color="var(--fg-faint)" />
      break
  }
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[status]}
      title={label}
      className={cn("inline-flex shrink-0 items-center justify-center", BOX[size], className)}
    >
      {icon}
    </span>
  )
})
