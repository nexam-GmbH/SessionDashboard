// In-app toast stack — UI_PLAN §5.10. Adapted from the behavior of
// stablyai/orca NotificationCardStack.tsx (MIT): bottom-right, max 3, coalesced per
// session, click opens the session. Modified: our tokens, auto-dismiss after 8s, an explicit
// "Open" so the click target is obvious, and one "Undo" toast for archive / restore (undo.ts).
import { memo, useEffect } from "react"
import { Archive, ArchiveRestore, MessageCircleQuestion, OctagonX, ShieldAlert, CircleCheck, X } from "lucide-react"
import { useApp, type Toast } from "@/store/app"
import { dismissToast, openSession } from "@/store/actions"
import { cn } from "@/lib/utils"
import { clearUndo, useUndo } from "./undo"

const META = {
  permission: { icon: ShieldAlert, color: "var(--st-perm)", label: "Needs permission" },
  question: { icon: MessageCircleQuestion, color: "var(--st-input)", label: "Waiting for input" },
  error: { icon: OctagonX, color: "var(--st-error)", label: "Error" },
  finished: { icon: CircleCheck, color: "var(--st-done)", label: "Finished" },
} as const

export function ToastStack() {
  const toasts = useApp((s) => s.toasts)
  const undo = useUndo((s) => !!s.undo)
  if (!toasts.length && !undo) return null
  return (
    <div className="pointer-events-none fixed right-3 bottom-[60px] z-50 flex w-[340px] flex-col gap-1.5">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
      {undo && <UndoToast />}
    </div>
  )
}

/** "Archived · <title> · Undo": one at a time, replaced by the next action, gone after 6s. */
function UndoToast() {
  const { seq, label, detail, undo } = useUndo()
  useEffect(() => {
    const id = setTimeout(clearUndo, 6000)
    return () => clearTimeout(id)
  }, [seq])
  if (!undo) return null
  const Icon = label === "Restored" ? ArchiveRestore : Archive
  return (
    <div role="status" className="pointer-events-auto flex animate-in items-center gap-2.5 rounded-lg border border-line bg-elevated py-1.5 pr-1.5 pl-3 shadow-[0_8px_24px_rgba(0,0,0,0.45)] duration-150 fade-in slide-in-from-bottom-1">
      <Icon size={14} className="shrink-0 text-fg-faint" />
      <span className="shrink-0 text-xs text-fg">{label}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-fg-faint" title={detail}>
        {detail}
      </span>
      <button
        className="h-6 shrink-0 rounded-[4px] px-2 text-xs font-medium text-link hover:bg-hover"
        onClick={() => {
          undo()
          clearUndo()
        }}
      >
        Undo
      </button>
      <button className="flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-faint hover:bg-hover hover:text-fg" onClick={clearUndo} aria-label="Dismiss">
        <X size={12} />
      </button>
    </div>
  )
}

const ToastCard = memo(function ToastCard({ toast }: { toast: Toast }) {
  const m = META[toast.kind]
  const Icon = m.icon
  useEffect(() => {
    const ms = toast.kind === "finished" ? 6000 : 10000
    const id = setTimeout(() => dismissToast(toast.id), ms)
    return () => clearTimeout(id)
  }, [toast.id, toast.createdAt, toast.kind])
  return (
    <div
      className={cn(
        "pointer-events-auto flex animate-in items-start gap-2 rounded-lg border border-line bg-elevated py-2 pr-1.5 pl-3 shadow-[0_8px_24px_rgba(0,0,0,0.45)] duration-150 fade-in slide-in-from-bottom-1",
      )}
      role="status"
      title={`${m.label}${toast.body ? ` · ${toast.body}` : ""}`}
    >
      <Icon size={15} color={m.color} className="mt-0.5 shrink-0" />
      <button className="min-w-0 flex-1 text-left" onClick={() => { dismissToast(toast.id); openSession(toast.sessionId) }}>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-fg">{toast.title}</span>
          {toast.count > 1 && <span className="tabular shrink-0 text-[11px] text-fg-faint">×{toast.count}</span>}
        </div>
        {/* color only for attention (§2.5); finished toasts are one line */}
        {toast.body && toast.kind !== "finished" && (
          <div className={cn("truncate text-[11px]", toast.kind === "permission" ? "font-mono text-st-perm-fg" : toast.kind === "question" ? "text-st-input-fg" : "text-st-error-fg")}>
            {toast.body}
          </div>
        )}
      </button>
      <button
        className="h-6 shrink-0 self-center rounded-[4px] px-2 text-xs font-medium text-link hover:bg-hover"
        onClick={() => {
          dismissToast(toast.id)
          openSession(toast.sessionId)
        }}
      >
        Open
      </button>
      <button
        className="flex size-5 shrink-0 items-center justify-center self-center rounded-sm text-fg-faint hover:bg-hover hover:text-fg"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  )
})
