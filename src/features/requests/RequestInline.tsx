import { memo, useState } from "react"
import { MessageCircleQuestion, ShieldAlert, ListChecks, Terminal, FilePen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useApp } from "@/store/app"
import { resolveRequest } from "@/features/session-view/sessionStore"
import { cn } from "@/lib/utils"
import type { ID } from "@/lib/model"

/**
 * Compact waiting-request block for the inspector. Only *once* options are offered inline
 * (UI_PLAN §12.6): always-allow and deny-with-feedback live in the session view where the full
 * request is visible. Options are data (ACP request_permission, RESEARCH §3.1).
 */
export const RequestInline = memo(function RequestInline({
  sessionId,
  compact,
  className,
}: {
  sessionId: ID
  compact?: boolean
  className?: string
}) {
  const session = useApp((s) => s.sessions[sessionId])
  const req = useApp((s) => {
    const rid = s.sessions[sessionId]?.waitingFor?.requestId
    return rid ? s.requests[rid] : undefined
  })
  const canApprove = session?.control === "owned" || session?.control === "pty"
  // per request: a new request on the same session gets fresh, enabled buttons
  const [busyFor, setBusyFor] = useState<ID | null>(null)
  const busy = !!req && busyFor === req.id
  if (!session?.waitingFor) return null
  const w = session.waitingFor
  const tone =
    w.kind === "permission"
      ? "border-st-perm/35 bg-st-perm-tint text-st-perm-fg"
      : "border-st-input/30 bg-st-input-tint text-st-input-fg"
  const Icon = w.kind === "permission" ? ShieldAlert : w.kind === "plan" ? ListChecks : MessageCircleQuestion
  const allowOnce = req && req.type === "permission" ? req.options.find((o) => o.kind === "allow_once") : undefined
  const rejectOnce = req && req.type === "permission" ? req.options.find((o) => o.kind === "reject_once") : undefined
  const subject = req && req.type === "permission" ? req.subject : undefined
  const SubjectIcon = subject?.type === "command" ? Terminal : FilePen
  return (
    <div className={cn("rounded-md border px-2 py-1.5", tone, className)}>
      <div className="flex items-start gap-1.5">
        <Icon size={13} className="mt-[2px] shrink-0" />
        <div className="min-w-0 flex-1">
          {subject ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <SubjectIcon size={11} className="shrink-0 opacity-80" />
              <span className="truncate font-mono text-[11px] text-fg">
                {subject.type === "command" ? subject.command : (subject.path ?? w.summary)}
              </span>
            </div>
          ) : (
            <div className={cn("text-xs text-fg", compact ? "truncate" : "line-clamp-2")}>{w.summary}</div>
          )}
        </div>
      </div>
      {/* only a permission is answered here; questions and plans open the session (the inspector's
          primary "Answer" / "Review plan" button), so there is one button per action */}
      {w.kind === "permission" && (
        <div className="mt-1.5 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {allowOnce && rejectOnce && canApprove ? (
            <>
              <Button
                size="xs"
                variant="perm"
                disabled={busy}
                onClick={() => {
                  setBusyFor(req!.id)
                  resolveRequest(req!, allowOnce.id)
                }}
              >
                Allow once
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setBusyFor(req!.id)
                  resolveRequest(req!, rejectOnce.id)
                }}
              >
                Deny
              </Button>
            </>
          ) : !canApprove ? (
            <span className="text-[11px] text-fg-faint">Approve in terminal</span>
          ) : null}
        </div>
      )}
    </div>
  )
})
