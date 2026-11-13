// In-app toast stack — UI_PLAN §5.10. Adapted from the behavior of
// stablyai/orca NotificationCardStack.tsx (MIT): bottom-right, max 3, coalesced per
// session, click opens the session. Modified: our tokens, auto-dismiss after 8s.
import { memo, useEffect } from "react"
import { MessageCircleQuestion, OctagonX, ShieldAlert, CircleCheck, X } from "lucide-react"
import { useApp, type Toast } from "@/store/app"
import { dismissToast, openSession } from "@/store/actions"
import { cn } from "@/lib/utils"

const META = {
  permission: { icon: ShieldAlert, color: "var(--st-perm)", label: "Needs permission" },
  question: { icon: MessageCircleQuestion, color: "var(--st-input)", label: "Waiting for input" },
  error: { icon: OctagonX, color: "var(--st-error)", label: "Error" },
  finished: { icon: CircleCheck, color: "var(--st-done)", label: "Finished" },
} as const

export function ToastStack() {
  const toasts = useApp((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed right-3 bottom-8 z-50 flex w-[340px] flex-col gap-1.5">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
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
        "pointer-events-auto flex animate-in items-start gap-2.5 rounded-lg border border-line bg-elevated px-3 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.45)] duration-150 fade-in slide-in-from-bottom-1",
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
        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-faint hover:bg-hover hover:text-fg"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  )
})
