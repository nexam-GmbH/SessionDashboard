// Adapted from agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/ApprovalCard.tsx (MIT). Modified for session-dashboard.
// Also adapted from BloopAI/vibe-kanban@5f06193:packages/web-core/src/shared/components/NormalizedConversation/PendingApprovalEntry.tsx
// (deny with a reason, Apache-2.0) and cline/cline@72b3d71:sdk/packages/ui/components/agent-approval-card.tsx (Apache-2.0).
// Changes: the request's ACP options are rendered as data (allow_once / allow_always /
// reject_once …) with short labels; Enter takes the first allow_once, 1–9 pick an
// option, Esc or "Deny" opens an inline feedback field (Cmd/Ctrl+Enter submits). Calm
// rules (§2.5): the title is the question itself ("Allow `npm test -- retry`?"); cwd and
// description sit behind a details toggle; edits show their pending diff.
import { memo, useEffect, useRef, useState } from "react"
import { ShieldAlert } from "lucide-react"
import type { PermissionOption, PermissionRequest, ToolCall } from "@/lib/model"
import { DiffStat } from "@/components/common/bits"
import { homePath } from "@/lib/format"
import { InlineDiff } from "@/features/session-view/tools/InlineDiff"
import { resolveRequest } from "@/features/session-view/sessionStore"
import { CardFrame, canStealFocus, DetailsToggle, FeedbackField, OptionButton, optionLabel, type Pager } from "./cardChrome"

const isReject = (o: PermissionOption) => o.kind === "reject_once" || o.kind === "reject_always"

/** "Allow <subject>?" with the subject truncating and the question mark kept. */
function AskTitle({ verb, subject }: { verb: string; subject?: string }) {
  if (!subject) return <span className="truncate">{verb}?</span>
  return (
    <span className="flex min-w-0 items-baseline" title={subject}>
      <span className="shrink-0">{verb}&nbsp;</span>
      <code className="min-w-0 truncate font-mono text-[12.5px]">{subject}</code>
      <span className="shrink-0">?</span>
    </span>
  )
}

export const PermissionCard = memo(function PermissionCard({
  request,
  canApprove,
  pager,
  toolCall,
  subagentLabel,
  autoFocus,
}: {
  request: PermissionRequest
  canApprove: boolean
  pager?: Pager
  /** the transcript's pending tool call, for the diff preview */
  toolCall?: ToolCall
  subagentLabel?: string
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  const [feedbackFor, setFeedbackFor] = useState<PermissionOption | null>(null)
  const [feedback, setFeedback] = useState("")
  const [details, setDetails] = useState(false)
  useEffect(() => {
    if (autoFocus && canStealFocus()) ref.current?.focus({ preventScroll: true })
  }, [autoFocus, request.id])

  const choose = (o: PermissionOption) => {
    if (!canApprove) return
    if (isReject(o)) {
      setFeedbackFor(o)
      return
    }
    resolveRequest(request, o.id)
  }
  const submitReject = () => {
    if (feedbackFor) resolveRequest(request, feedbackFor.id, feedback.trim() || undefined)
  }
  const firstAllow = request.options.find((o) => o.kind === "allow_once")
  const subject = request.subject
  const command = subject?.type === "command" ? subject.command : undefined
  const path = subject?.type === "command" ? undefined : (subject?.path ?? undefined)
  const diff = toolCall?.diff?.[0]
  const added = toolCall?.diff?.reduce((a, d) => a + d.added, 0) ?? 0
  const removed = toolCall?.diff?.reduce((a, d) => a + d.removed, 0) ?? 0
  const cwd = subject?.type === "command" ? subject.cwd : undefined
  const hasDetails = !!(cwd || request.description || (command && command.length > 60))
  const verb = command ? "Allow" : request.toolName === "Edit" || request.toolName === "Write" ? "Allow edit" : `Allow ${request.toolName}`

  return (
    <CardFrame
      ref={ref}
      tone="perm"
      label={`Permission request: ${request.title}`}
      icon={<ShieldAlert size={14} />}
      title={<AskTitle verb={verb} subject={command ?? path} />}
      meta={
        <>
          {(added > 0 || removed > 0) && <DiffStat added={added} removed={removed} className="shrink-0" />}
          {subagentLabel && <span className="shrink-0 text-[11.5px] text-fg-muted">{subagentLabel}</span>}
        </>
      }
      aside={hasDetails ? <DetailsToggle open={details} onToggle={() => setDetails((v) => !v)} /> : undefined}
      pager={pager}
      onKeyDown={(e) => {
        if (feedbackFor || e.target !== e.currentTarget) return
        if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault()
          pager?.onNext()
        } else if (e.key === "Enter" && firstAllow) {
          e.preventDefault()
          choose(firstAllow)
        } else if (/^[1-9]$/.test(e.key)) {
          const o = request.options[Number(e.key) - 1]
          if (o) {
            e.preventDefault()
            choose(o)
          }
        } else if (e.key === "Escape") {
          const r = request.options.find(isReject)
          if (r) {
            e.preventDefault()
            choose(r)
          }
        }
      }}
      footer={
        feedbackFor ? (
          <FeedbackField
            placeholder="What should Claude do instead? (optional)"
            value={feedback}
            onChange={setFeedback}
            onSubmit={submitReject}
            onCancel={() => {
              setFeedbackFor(null)
              setFeedback("")
              ref.current?.focus()
            }}
            submitLabel="Deny"
          />
        ) : (
          <>
            {request.options.map((o, i) => (
              <OptionButton
                key={o.id}
                n={i + 1}
                disabled={!canApprove}
                variant={o === firstAllow ? "primary" : isReject(o) ? "quiet" : "secondary"}
                onClick={() => choose(o)}
                enter={o === firstAllow}
                title={o.name}
              >
                {optionLabel(o)}
              </OptionButton>
            ))}
            {!canApprove && <span className="ml-auto text-[11.5px] text-fg-faint">Approve in your terminal</span>}
          </>
        )
      }
    >
      {(details || (diff && !command)) && (
        <div className="flex flex-col gap-1">
          {details && command && command.length > 60 && (
            <code className="font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-fg select-text">{command}</code>
          )}
          {details && cwd && (
            <div className="truncate font-mono text-[11px] text-fg-faint" title={cwd}>
              {homePath(cwd)}
            </div>
          )}
          {details && request.description && <div className="text-[12px] text-fg-muted">{request.description}</div>}
          {diff && !command && <InlineDiff className={details ? "mt-1" : undefined} path={diff.path} oldText={diff.oldText} newText={diff.newText} maxLines={8} />}
        </div>
      )}
    </CardFrame>
  )
})
