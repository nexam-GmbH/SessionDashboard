// A small word beside a session that acts without asking (bypass, don't ask) or decides for itself
// (auto), so the sessions running unattended are visible from the list and the overview. A word, not
// an icon: a crossed-out shield read as "disconnected".
import { memo } from "react"
import type { PermissionMode } from "@/lib/model"
import { cn } from "@/lib/utils"

const MARK: Partial<Record<PermissionMode, { label: string; title: string }>> = {
  bypassPermissions: { label: "bypass", title: "Bypass permissions: Claude never asks before acting" },
  dontAsk: { label: "don't ask", title: "Don't ask: denies what isn't allowed, never asks" },
  auto: { label: "auto", title: "Auto mode: runs safe actions, asks for risky ones" },
}

export const ModeMark = memo(function ModeMark({ mode, className }: { mode: PermissionMode; className?: string }) {
  const m = MARK[mode]
  if (!m) return null
  return (
    <span title={m.title} className={cn("shrink-0 rounded-sm px-1 text-[11px] leading-4 text-muted-foreground/80 ring-1 ring-foreground/10", className)}>
      {m.label}
    </span>
  )
})
