// The *once* answers: the only answers offered outside the session view, where the
// full request, always-allow and deny-with-feedback are visible. Options are data (ACP
// request_permission). Used by the map card, the map toolbar and context menu, the
// inspector and the session view's subagent request chip.
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { resolveRequest } from "@/features/session-view/sessionStore"
import type { ID, PendingRequest, PermissionOption, PermissionRequest } from "@/lib/model"

export interface OnceOptions {
  req: PermissionRequest
  allow: PermissionOption
  deny: PermissionOption
}

/** Allow once / Deny of a pending permission request; undefined for anything else. */
export function onceOptions(req: PendingRequest | undefined): OnceOptions | undefined {
  if (!req || req.type !== "permission" || req.state !== "pending") return undefined
  const allow = req.options.find((o) => o.kind === "allow_once")
  const deny = req.options.find((o) => o.kind === "reject_once")
  return allow && deny ? { req, allow, deny } : undefined
}

/**
 * The two buttons. Through resolveRequest, so the transcript's awaiting tool row resolves too. A
 * click disables both until the request goes away; a new request (same mounted row) gets fresh,
 * enabled buttons because the busy mark is kept per request id.
 */
export function OnceButtons({ once, disabled }: { once: OnceOptions; disabled?: boolean }) {
  const [busyFor, setBusyFor] = useState<ID | null>(null)
  const off = disabled || busyFor === once.req.id
  const answer = (o: PermissionOption) => {
    setBusyFor(once.req.id)
    resolveRequest(once.req, o.id)
  }
  return (
    <>
      <Button size="xs" className="bg-st-perm-tint text-st-perm-fg hover:bg-st-perm/25" disabled={off} onClick={() => answer(once.allow)}>
        Allow once
      </Button>
      <Button size="xs" variant="ghost" disabled={off} onClick={() => answer(once.deny)}>
        Deny
      </Button>
    </>
  )
}
