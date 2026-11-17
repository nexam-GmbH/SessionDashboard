// one pending request at a time with a "1/2"
// pager. Main-session requests come first, then requests from subagents (their
// card is labelled with the subagent type). Cards live in src/features/requests.
// As in Claude Code desktop, a session the app can answer for shows the card in place of the prompt
// box (the dock); a terminal session's card sits in the conversation and the box stays.
import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react"
import type { ID, PendingRequest } from "@/lib/model"
import { getApp, useApp } from "@/store/app"
import { usePendingRequests } from "@/store/selectors"
import { capabilities } from "@/lib/status"
import { PermissionCard } from "@/features/requests/PermissionCard"
import { QuestionCard } from "@/features/requests/QuestionCard"
import { PlanApprovalCard } from "@/features/requests/PlanApprovalCard"
import {
  findPendingToolCall,
  focusDockRequest,
  useDockFocus,
} from "../sessionStore"

const isChild = (r: PendingRequest) => r.type === "permission" && !!r.subagentId

/**
 * Main-session requests always; a subagent's request joins the dock only when the
 * activity bar asks for it ("More…"), so it isn't shown twice.
 */
export function dockRequests(reqs: PendingRequest[], focusId: ID | null) {
  const main = reqs.filter((r) => !isChild(r))
  const child = focusId
    ? reqs.find((r) => r.id === focusId && isChild(r))
    : undefined
  return child ? [...main, child] : main
}

/**
 * Holds one card. When the card is answered while it has keyboard focus, focus would fall back to
 * <body>; hand it on instead: to the next pending card if one appears, else to the composer.
 */
function DockSlot({
  sessionId,
  children,
}: {
  sessionId: ID
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    return () => {
      // layout cleanups run before the card's DOM is removed, so containment is still accurate
      if (!el?.contains(document.activeElement)) return
      setTimeout(() => {
        if (document.activeElement && document.activeElement !== document.body)
          return
        const view = document.querySelector(
          `[data-session-view="${CSS.escape(sessionId)}"]`
        )
        const next =
          view?.querySelector<HTMLElement>("[aria-live] section[tabindex]") ??
          view?.querySelector<HTMLElement>(
            'textarea[aria-label="Message Claude"]'
          )
        next?.focus({ preventScroll: true })
      }, 60)
    }
  }, [sessionId])
  return <div ref={ref}>{children}</div>
}

/**
 * The dock is a polite live region that stays mounted (empty and zero-height when nothing is
 * pending), so a request that arrives later is announced once: each card is keyed by request id,
 * and only additions are announced, not edits inside a card. Streaming text is never in here.
 */
export const AttentionDock = memo(function AttentionDock({
  sessionId,
  composer,
}: {
  sessionId: ID
  /** given: this is the dock under the conversation, the card replaces the composer; else the in-conversation slot */
  composer?: ReactNode
}) {
  const pending = usePendingRequests(sessionId)
  const control = useApp((s) => s.sessions[sessionId]?.control)
  const focusId = useDockFocus(sessionId)
  // Re-derive the diff preview once the transcript exists.
  const transcriptReady = useApp((s) => !!s.transcripts[sessionId])
  const reqs = useMemo(() => dockRequests(pending, focusId), [pending, focusId])
  if (!control) return null
  const caps = capabilities(control)
  const docked = !!composer
  // the other place holds this session's cards
  if (docked !== caps.approve) return composer ?? null
  // a subagent's request is shown in the activity bar, not here: announce it from this region too
  const child = pending.find((r) => isChild(r) && !reqs.includes(r))
  const childNote = child?.type === "permission" && (
    <span key={child.id} className="sr-only">
      {`${(child.subagentId && getApp().subagents[child.subagentId]?.agentType) || "A subagent"} asks to use ${child.toolName}: ${child.subject?.type === "command" ? child.subject.command : (child.subject?.path ?? child.title)}`}
    </span>
  )
  if (!reqs.length)
    return (
      <>
        <div aria-live="polite" aria-relevant="additions">
          {childNote}
        </div>
        {composer}
      </>
    )
  const found = focusId ? reqs.findIndex((r) => r.id === focusId) : -1
  const index = found >= 0 ? found : 0
  const req = reqs[index]
  const go = (d: number) =>
    focusDockRequest(
      sessionId,
      reqs[(index + d + reqs.length) % reqs.length].id
    )
  const pager = {
    index,
    total: reqs.length,
    onPrev: () => go(-1),
    onNext: () => go(1),
  }
  const subLabel =
    req.type === "permission" && req.subagentId
      ? (getApp().subagents[req.subagentId]?.agentType ?? "subagent")
      : undefined
  return (
    <div aria-live="polite" aria-relevant="additions" data-find-skip className={docked ? "mx-auto w-full max-w-[calc(var(--chat-w)+64px)] px-8 pb-3 @max-[560px]:px-4" : undefined}>
      {childNote}
      <DockSlot key={req.id} sessionId={sessionId}>
        {req.type === "permission" ? (
          <PermissionCard
            key={req.id}
            request={req}
            canApprove={caps.approve}
            pager={pager}
            toolCall={
              transcriptReady && !req.subagentId
                ? findPendingToolCall(req)
                : undefined
            }
            subagentLabel={subLabel}
            docked={docked}
          />
        ) : req.type === "question" ? (
          <QuestionCard
            key={req.id}
            request={req}
            canAnswer={caps.approve}
            pager={pager}
            docked={docked}
          />
        ) : (
          <PlanApprovalCard
            key={req.id}
            request={req}
            canApprove={caps.approve}
            pager={pager}
            docked={docked}
          />
        )}
      </DockSlot>
    </div>
  )
})
