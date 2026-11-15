// Screen reader announcements for one session: a visually hidden polite
// status line that speaks state *changes* — Claude started working, finished, failed, the
// permission mode changed (Shift+Tab in the composer) — instead of every streamed token. Pending
// requests are announced by the attention dock's own live region, so waiting states are skipped.
import { memo, useEffect, useRef, useState } from "react"
import type { ID, PermissionMode, SessionStatus } from "@/lib/model"
import { useApp } from "@/store/app"
import { PERMISSION_MODE_LABEL } from "@/lib/status"

function statusMessage(status: SessionStatus, prev: SessionStatus, error?: string): string | null {
  switch (status) {
    case "starting":
    case "working":
      return prev === "starting" || prev === "working" ? null : "Claude is working"
    case "idle":
    case "done_unseen":
      return prev === "working" || prev === "starting" ? "Claude finished" : null
    case "error":
      return `Stopped with an error${error ? `: ${error}` : ""}`
    case "stopped":
      return "Session stopped"
    default:
      // waiting_permission / waiting_input: the dock announces the request itself
      return null
  }
}

export const StatusAnnouncer = memo(function StatusAnnouncer({ sessionId }: { sessionId: ID }) {
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const mode = useApp((s) => s.sessions[sessionId]?.permissionMode)
  const error = useApp((s) => s.sessions[sessionId]?.errorMessage)
  const [message, setMessage] = useState("")
  const prev = useRef<{ status?: SessionStatus; mode?: PermissionMode }>({ status, mode })

  useEffect(() => {
    const p = prev.current
    prev.current = { status, mode }
    let next: string | null = null
    if (mode && p.mode && mode !== p.mode) next = `Permission mode: ${PERMISSION_MODE_LABEL[mode]}`
    else if (status && p.status && status !== p.status) next = statusMessage(status, p.status, error)
    if (!next) return
    const text = next
    // the same sentence twice in a row would not be re-announced: toggle a trailing space
    setMessage((m) => (m === text ? `${text}\u00a0` : text))
  }, [status, mode, error])

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  )
})
