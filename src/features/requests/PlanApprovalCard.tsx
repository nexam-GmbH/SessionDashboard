// Adapted from vercel/ai-elements@ca8be60:packages/elements/src/confirmation.tsx (Apache-2.0). Modified for session-dashboard.
// Changes: AI SDK ToolUIPart approval state replaced by our PlanApproval request;
// every ExitPlanMode option (several allow_always, one per target mode) is its own
// button with a short label; "Keep planning" takes optional feedback;
// calm chrome: "Approve plan?" over the plan, no instruction text.
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { ListChecks } from "lucide-react"
import type { PermissionOption, PlanApproval } from "@/lib/model"
import { Markdown } from "@/features/session-view/markdown/Markdown"
import { resolveRequest } from "@/features/session-view/sessionStore"
import { planChecks } from "@/features/session-view/signals"
import { Checkbox } from "@/components/ui/checkbox"
import { REAL } from "@/backend/mode"
import { useApp } from "@/store/app"
import { CardFrame, canStealFocus, FeedbackField, MoreAnswers, OptionButton, optionLabel, type Pager } from "./cardChrome"

const isReject = (o: PermissionOption) => o.kind === "reject_once" || o.kind === "reject_always"
/** in the menu beside "Accept and allow edits" (Claude Code desktop), not buttons of their own */
const IN_MENU = new Set(["approve-auto", "approve-bypass"])

/** ExitPlanMode's answers in Claude Code desktop's words (the mode each one switches to). */
const PLAN_LABEL: Record<string, string> = {
  "approve-accept": "Accept and allow edits",
  "approve-auto": "Accept and use Auto mode",
  "approve-bypass": "Accept and bypass permissions",
  "approve-manual": "Accept",
  "keep-planning": "Revise…",
}

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
  // the checks the plan will run: allowed for the rest of the session with the approval, so carrying
  // out an approved plan doesn't stop at every test run
  const checks = useMemo(() => planChecks(request.planMarkdown), [request.planMarkdown])
  const [skip, setSkip] = useState<Set<string>>(() => new Set())
  const choose = (o: PermissionOption) => {
    if (!canApprove) return
    if (isReject(o)) setFeedbackFor(o)
    else {
      if (REAL) void import("@/backend/real").then((r) => {
        r.setPlanAllow(request.id, checks.filter((c) => !skip.has(c)))
        resolveRequest(request, o.id)
      })
      else resolveRequest(request, o.id)
    }
  }
  const allowBypass = useApp((s) => s.settings.allowBypass || s.caps?.defaultMode === "bypassPermissions")
  const menu = request.options.filter((o) => IN_MENU.has(o.id) && (o.id !== "approve-bypass" || allowBypass))
  const buttons = request.options.filter((o) => !IN_MENU.has(o.id))
  const primary = buttons.find((o) => !isReject(o))
  return (
    <CardFrame
      ref={ref}
      tone="input"
      label="Plan approval"
      keyHint={`Enter: approve. 1 to ${Math.min(9, buttons.length)}: pick an option.`}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ListChecks size={16} className="shrink-0 text-muted-foreground" />
          <span className="truncate">Ready to start? Here is the plan</span>
        </span>
      }
      pager={pager}
      onKeyDown={(e) => {
        if (feedbackFor || e.target !== e.currentTarget) return
        if (e.key === "Enter" && primary) {
          e.preventDefault()
          choose(primary)
        } else if (/^[1-9]$/.test(e.key)) {
          // the buttons only (the menu's answers are picked from the menu)
          const o = buttons[Number(e.key) - 1]
          if (o) {
            e.preventDefault()
            choose(o)
          }
        }
      }}
      footer={
        feedbackFor ? (
          <FeedbackField
            placeholder="What should change?"
            value={feedback}
            onChange={setFeedback}
            onSubmit={() => resolveRequest(request, feedbackFor.id, feedback.trim() || undefined)}
            onCancel={() => {
              setFeedbackFor(null)
              setFeedback("")
              ref.current?.focus()
            }}
            submitLabel="Revise"
          />
        ) : (
          <>
            {!canApprove && <span className="mr-auto text-xs text-muted-foreground/70">Approve in your terminal</span>}
            {/* Revise on the left, the main answer on the right (Claude Code desktop's order) */}
            {[...buttons.filter(isReject), ...buttons.filter((o) => !isReject(o) && o !== primary), ...(primary ? [primary] : [])].map((o) => (
              <OptionButton
                key={o.id}
                n={buttons.indexOf(o) + 1}
                disabled={!canApprove}
                variant={o === primary ? "primary" : isReject(o) ? "quiet" : "secondary"}
                onClick={() => choose(o)}
                enter={o === primary}
                title={o.name}
              >
                {PLAN_LABEL[o.id] ?? optionLabel(o)}
              </OptionButton>
            ))}
            <MoreAnswers
              disabled={!canApprove}
              label="More ways to accept"
              items={menu.map((o) => ({ label: PLAN_LABEL[o.id] ?? optionLabel(o), danger: o.id === "approve-bypass", onSelect: () => choose(o) }))}
            />
          </>
        )
      }
    >
      <div className="max-h-[min(460px,50vh)] overflow-auto rounded-lg bg-muted/50 px-4 py-3 text-foreground">
        <Markdown content={request.planMarkdown} />
      </div>
      {checks.length > 0 && canApprove && (
        <div className="mt-2 flex flex-col gap-1 border-t border-border/60 pt-2 text-xs">
          <span className="text-muted-foreground">With the approval, run these without asking for the rest of this session:</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {checks.map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-1.5">
                <Checkbox
                  checked={!skip.has(c)}
                  onCheckedChange={(v) =>
                    setSkip((prev) => {
                      const next = new Set(prev)
                      if (v) next.delete(c)
                      else next.add(c)
                      return next
                    })
                  }
                />
                <code className="font-mono">{c.replace(/:\*$/, "")}</code>
              </label>
            ))}
          </div>
        </div>
      )}
    </CardFrame>
  )
})
