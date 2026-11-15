// A small shield beside a session that acts without asking (bypass) or decides for itself (auto), so
// the sessions running unattended are visible from the list and the overview.
import { memo } from "react"
import { ShieldCheck, ShieldOff } from "lucide-react"
import type { PermissionMode } from "@/lib/model"
import { cn } from "@/lib/utils"

const MARK: Partial<Record<PermissionMode, { icon: typeof ShieldOff; title: string; className: string }>> = {
  bypassPermissions: { icon: ShieldOff, title: "Bypass permissions: never asks before acting", className: "text-foreground" },
  dontAsk: { icon: ShieldOff, title: "Don't ask: denies what isn't allowed, never asks", className: "text-foreground/80" },
  auto: { icon: ShieldCheck, title: "Auto mode: runs safe actions, asks for risky ones", className: "text-muted-foreground" },
}

export const ModeMark = memo(function ModeMark({ mode, className }: { mode: PermissionMode; className?: string }) {
  const m = MARK[mode]
  if (!m) return null
  const Icon = m.icon
  return (
    <span role="img" aria-label={m.title} title={m.title} className={cn("inline-flex shrink-0", m.className, className)}>
      <Icon size={13} strokeWidth={2} />
    </span>
  )
})
