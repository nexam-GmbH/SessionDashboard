import { memo } from "react"
import { MessageCircleQuestion, ShieldAlert, ListChecks, Terminal, FilePen } from "lucide-react"
import { useApp } from "@/store/app"
import { capabilities } from "@/lib/status"
import { cn } from "@/lib/utils"
import type { ID } from "@/lib/model"
import { onceOptions, OnceButtons } from "./OnceAnswers"

/**
 * Compact waiting-request block for the inspector. Only *once* options are offered inline
 *: always-allow and deny-with-feedback live in the session view where the full
 * request is visible. Options are data (ACP request_permission).
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
  if (!session?.waitingFor) return null
  const canApprove = capabilities(session.control).approve
  const w = session.waitingFor
  const tone =
    w.kind === "permission"
      ? "border-st-perm/35 bg-st-perm-tint text-st-perm-fg"
      : "border-st-perm/30 bg-st-perm-tint text-st-perm-fg"
  const Icon = w.kind === "permission" ? ShieldAlert : w.kind === "plan" ? ListChecks : MessageCircleQuestion
  const once = onceOptions(req, session.cwd)
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
              <span className="truncate font-mono text-xs text-foreground">
                {subject.type === "command" ? subject.command : (subject.path ?? w.summary)}
              </span>
            </div>
          ) : (
            <div className={cn("text-xs text-foreground", compact ? "truncate" : "line-clamp-2")}>{w.summary}</div>
          )}
        </div>
      </div>
      {/* only a permission is answered here; questions and plans open the session (the inspector's
          primary "Answer" / "Review plan" button), so there is one button per action */}
      {w.kind === "permission" && (
        <div className="mt-1.5 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {once && canApprove ? (
            <OnceButtons once={once} />
          ) : !canApprove ? (
            <span className="text-xs text-muted-foreground/70">Approve in terminal</span>
          ) : req?.type === "permission" ? (
            <span className="text-xs text-muted-foreground">Hard to undo: answer in the session</span>
          ) : null}
        </div>
      )}
    </div>
  )
})
