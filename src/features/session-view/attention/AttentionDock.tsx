// Attention dock — UI_PLAN §5.3: one pending request at a time with a "1/2"
// pager. Main-session requests come first, then requests from subagents (their
// card is labelled with the subagent type). Cards live in src/features/requests.
import { memo, useMemo } from "react"
import type { ID, PendingRequest } from "@/lib/model"
import { getApp, useApp } from "@/store/app"
import { usePendingRequests } from "@/store/selectors"
import { capabilities } from "@/lib/status"
import { PermissionCard } from "@/features/requests/PermissionCard"
import { QuestionCard } from "@/features/requests/QuestionCard"
import { PlanApprovalCard } from "@/features/requests/PlanApprovalCard"
import { findPendingToolCall, focusDockRequest, useDockFocus } from "../sessionStore"

const isChild = (r: PendingRequest) => r.type === "permission" && !!r.subagentId

/**
 * Main-session requests always; a subagent's request joins the dock only when the
 * activity bar asks for it ("More…"), so it isn't shown twice.
 */
export function dockRequests(reqs: PendingRequest[], focusId: ID | null) {
  const main = reqs.filter((r) => !isChild(r))
  const child = focusId ? reqs.find((r) => r.id === focusId && isChild(r)) : undefined
  return child ? [...main, child] : main
}

export const AttentionDock = memo(function AttentionDock({ sessionId }: { sessionId: ID }) {
  const pending = usePendingRequests(sessionId)
  const control = useApp((s) => s.sessions[sessionId]?.control)
  const focusId = useDockFocus(sessionId)
  // Re-derive the diff preview once the transcript exists.
  const transcriptReady = useApp((s) => !!s.transcripts[sessionId])
  const reqs = useMemo(() => dockRequests(pending, focusId), [pending, focusId])
  if (!reqs.length || !control) return null
  const caps = capabilities(control)
  const found = focusId ? reqs.findIndex((r) => r.id === focusId) : -1
  const index = found >= 0 ? found : 0
  const req = reqs[index]
  const go = (d: number) => focusDockRequest(sessionId, reqs[(index + d + reqs.length) % reqs.length].id)
  const pager = { index, total: reqs.length, onPrev: () => go(-1), onNext: () => go(1) }
  const subLabel =
    req.type === "permission" && req.subagentId ? (getApp().subagents[req.subagentId]?.agentType ?? "subagent") : undefined
  return (
    <div className="mx-auto w-full max-w-[860px] px-5 pb-2">
      {req.type === "permission" ? (
        <PermissionCard
          key={req.id}
          request={req}
          canApprove={caps.approve}
          pager={pager}
          toolCall={transcriptReady && !req.subagentId ? findPendingToolCall(req) : undefined}
          subagentLabel={subLabel}
          autoFocus
        />
      ) : req.type === "question" ? (
        <QuestionCard key={req.id} request={req} canAnswer={caps.approve} pager={pager} autoFocus />
      ) : (
        <PlanApprovalCard key={req.id} request={req} canApprove={caps.approve} pager={pager} autoFocus />
      )}
    </div>
  )
})
