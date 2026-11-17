// Adapted from vercel/ai-elements@ca8be60:packages/elements/src/confirmation.tsx (Apache-2.0). Modified for session-dashboard.
// Claude Code desktop's plan card: "Claude proposed a plan", a clamped preview that opens in place,
// Reject · Revise… at the start, Accept · Accept and allow edits (split: Auto / Bypass) at the end.
// Revise turns the footer into a feedback editor. Our extra: the plan's checks, allowed with it.
import { memo, useEffect, useMemo, useRef, useState } from "react"
import type { PermissionOption, PlanApproval } from "@/lib/model"
import { Markdown } from "@/features/session-view/markdown/Markdown"
import { resolveRequest } from "@/features/session-view/sessionStore"
import { planChecks } from "@/features/session-view/signals"
import { Checkbox } from "@/components/ui/checkbox"
import { MOD } from "@/components/common/bits"
import { REAL } from "@/backend/mode"
import { useApp } from "@/store/app"
import { cn } from "@/lib/utils"
import { CardFrame, canStealFocus, Decision, FeedbackField, FOCUS, modEnter, OptionButton, plain, Split, useCardKeys, type Pager } from "./cardChrome"

/** ExitPlanMode's answers in desktop's words (the mode each one continues in) and short labels. */
const LABEL: Record<string, [string, string]> = {
  "approve-accept": ["Accept and allow edits", "Allow edits"],
  "approve-auto": ["Accept and use auto mode", "Use auto mode"],
  "approve-bypass": ["Accept and bypass permissions", "Bypass permissions"],
  "approve-manual": ["Accept", "Accept"],
}

export const PlanApprovalCard = memo(function PlanApprovalCard({
  request,
  canApprove,
  pager,
  docked,
}: {
  request: PlanApproval
  canApprove: boolean
  pager?: Pager
  docked: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState("")
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (docked && canStealFocus()) ref.current?.focus({ preventScroll: true })
  }, [docked, request.id])
  // the checks the plan will run: allowed for the rest of the session with the approval, so carrying
  // out an approved plan doesn't stop at every test run
  const checks = useMemo(() => planChecks(request.planMarkdown), [request.planMarkdown])
  const [skip, setSkip] = useState<Set<string>>(() => new Set())
  const allowBypass = useApp((s) => s.settings.allowBypass || s.caps?.defaultMode === "bypassPermissions")

  const accept = (o: PermissionOption) => {
    if (!canApprove) return
    if (REAL)
      void import("@/backend/real").then((r) => {
        r.setPlanAllow(request.id, checks.filter((c) => !skip.has(c)))
        resolveRequest(request, o.id)
      })
    else resolveRequest(request, o.id)
  }
  const keep = request.options.find((o) => o.kind === "reject_once" || o.kind === "reject_always")
  const reject = () => keep && canApprove && resolveRequest(request, keep.id, "The user rejected this plan.")
  const revise = () => keep && resolveRequest(request, keep.id, feedback.trim() || undefined)
  const byId = (id: string) => request.options.find((o) => o.id === id)
  const manual = byId("approve-manual")
  const primary = byId("approve-accept") ?? request.options.find((o) => o !== keep && o !== manual)
  const menu = request.options.filter((o) => o !== keep && o !== manual && o !== primary && (o.id !== "approve-bypass" || allowBypass))
  // desktop shows the plain Accept only beside a different default
  const second = manual !== primary ? manual : undefined
  // digits: 1 Reject, 2… the accept buttons in visual order
  const ends = [second, primary].filter((o): o is PermissionOption => !!o)

  useCardKeys(
    ref,
    docked &&
      canApprove &&
      !revising &&
      ((e) => {
        if (modEnter(e)) {
          const o = e.shiftKey ? second : primary
          if (o) accept(o)
          return !!o
        }
        if (!plain(e)) return false
        const o = /^[2-9]$/.test(e.key) ? ends[Number(e.key) - 2] : undefined
        if (e.key === "Escape" && keep) setRevising(true)
        else if (e.key === "1" && keep) reject()
        else if (o) accept(o)
        else return false
        return true
      }),
  )

  const plan = request.planMarkdown.trim()
  return (
    <CardFrame
      ref={ref}
      docked={docked}
      label="Plan approval"
      keyHint={`Control+Enter: ${primary ? LABEL[primary.id]?.[0] : "accept"}. ${second ? "Control+Shift+Enter: accept and keep approving edits. " : ""}1: reject. Escape: revise.`}
      title={<span className="font-semibold">{plan ? "Claude proposed a plan" : "Claude wants to leave plan mode"}</span>}
      pager={pager}
      footer={
        revising ? (
          <FeedbackField
            label="Plan feedback"
            placeholder="What should change? (optional)"
            value={feedback}
            onChange={setFeedback}
            onSubmit={revise}
            onCancel={() => {
              setRevising(false)
              ref.current?.focus()
            }}
            submitLabel="Revise"
          />
        ) : (
          <Decision
            start={
              <>
                {keep && (
                  <OptionButton variant="secondary" disabled={!canApprove} onClick={reject} keys={docked ? ["1"] : undefined}>
                    Reject
                  </OptionButton>
                )}
                {keep && (
                  <OptionButton variant="secondary" disabled={!canApprove} onClick={() => setRevising(true)} keys={docked ? ["Esc"] : undefined}>
                    Revise…
                  </OptionButton>
                )}
                {!canApprove && <span className="text-xs text-cc-fg3">Approve in your terminal</span>}
              </>
            }
            end={
              <>
                {second && (
                  <OptionButton variant="secondary" disabled={!canApprove} onClick={() => accept(second)} keys={docked ? [MOD, "Shift", "⏎"] : undefined} title={second.name}>
                    Accept
                  </OptionButton>
                )}
                {primary && (
                  <Split
                    label="More accept options"
                    disabled={!canApprove}
                    items={menu.map((o) => ({ label: LABEL[o.id]?.[0] ?? o.name, danger: o.id === "approve-bypass", onSelect: () => accept(o) }))}
                  >
                    <OptionButton variant="primary" disabled={!canApprove} onClick={() => accept(primary)} keys={docked ? [MOD, "⏎"] : undefined} title={primary.name} short={LABEL[primary.id]?.[1]}>
                      {LABEL[primary.id]?.[0] ?? primary.name}
                    </OptionButton>
                  </Split>
                )}
              </>
            }
          />
        )
      }
    >
      {plan ? (
        <div className="flex flex-col items-start gap-1">
          {/* a clamped preview; "Open plan" shows it all here (we have no side document view) */}
          <div className={cn("w-full text-cc-fg2", !open && (docked ? "max-h-32 overflow-hidden" : "max-h-10 overflow-hidden"))}>
            <Markdown content={request.planMarkdown} />
          </div>
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn("-ms-2 h-6 rounded-lg px-2 text-sm text-cc-fg2 hover:bg-cc-ghost hover:text-foreground", FOCUS)}>
            {open ? "Close plan" : "Open plan"}
          </button>
        </div>
      ) : (
        <p className="text-cc-fg2">Claude hasn't written a plan, so there's nothing to review.</p>
      )}
      {checks.length > 0 && canApprove && (
        <div className="flex shrink-0 flex-col gap-1.5 rounded-lg bg-cc-wash px-3 py-2 text-[13px] leading-[17px] text-cc-fg2">
          <span>With the approval, run these without asking for the rest of this session:</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {checks.map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-1.5 text-foreground">
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
