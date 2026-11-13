// Adapted from vercel/ai-elements@ca8be60:packages/elements/src/confirmation.tsx (Apache-2.0). Modified for session-dashboard.
// Changes: AI SDK ToolUIPart approval state replaced by our PlanApproval request;
// every ExitPlanMode option (several allow_always, one per target mode) is its own
// button with a short label (RESEARCH §1.6); "Keep planning" takes optional feedback;
// calm chrome (§2.5): "Approve plan?" over the plan, no instruction text.
import { memo, useEffect, useRef, useState } from "react"
import { ListChecks } from "lucide-react"
import type { PermissionOption, PlanApproval } from "@/lib/model"
import { Markdown } from "@/features/session-view/markdown/Markdown"
import { resolveRequest } from "@/features/session-view/sessionStore"
import { CardFrame, canStealFocus, FeedbackField, OptionButton, optionLabel, type Pager } from "./cardChrome"

const isReject = (o: PermissionOption) => o.kind === "reject_once" || o.kind === "reject_always"

export const PlanApprovalCard = memo(function PlanApprovalCard({
  request,
  canApprove,
  pager,
  autoFocus,
}: {
  request: PlanApproval
  canApprove: boolean
  pager?: Pager
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  const [feedbackFor, setFeedbackFor] = useState<PermissionOption | null>(null)
  const [feedback, setFeedback] = useState("")
  useEffect(() => {
    if (autoFocus && canStealFocus()) ref.current?.focus({ preventScroll: true })
  }, [autoFocus, request.id])
  const choose = (o: PermissionOption) => {
    if (!canApprove) return
    if (isReject(o)) setFeedbackFor(o)
    else resolveRequest(request, o.id)
  }
  const primary = request.options.find((o) => !isReject(o))
  return (
    <CardFrame
      ref={ref}
      tone="input"
      label="Plan approval"
      icon={<ListChecks size={14} />}
      title={<span className="truncate">Approve plan?</span>}
      pager={pager}
      onKeyDown={(e) => {
        if (feedbackFor || e.target !== e.currentTarget) return
        if (e.key === "Enter" && primary) {
          e.preventDefault()
          choose(primary)
        } else if (/^[1-9]$/.test(e.key)) {
          const o = request.options[Number(e.key) - 1]
          if (o) {
            e.preventDefault()
            choose(o)
          }
        }
      }}
      footer={
        feedbackFor ? (
          <FeedbackField
            placeholder="What should change? (optional)"
            value={feedback}
            onChange={setFeedback}
            onSubmit={() => resolveRequest(request, feedbackFor.id, feedback.trim() || undefined)}
            onCancel={() => {
              setFeedbackFor(null)
              setFeedback("")
              ref.current?.focus()
            }}
            submitLabel="Keep planning"
          />
        ) : (
          <>
            {request.options.map((o, i) => (
              <OptionButton
                key={o.id}
                n={i + 1}
                disabled={!canApprove}
                variant={o === primary ? "primary" : isReject(o) ? "quiet" : "secondary"}
                onClick={() => choose(o)}
                enter={o === primary}
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
      <div className="max-h-[200px] overflow-auto">
        <Markdown content={request.planMarkdown} />
      </div>
    </CardFrame>
  )
})
