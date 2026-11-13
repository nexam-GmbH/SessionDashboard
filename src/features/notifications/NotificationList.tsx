// Notification popover list — UI_PLAN §5.10. Coalesced per session (groupKey + count),
// Emdash notifications model (Apache-2.0).
import { memo } from "react"
import { CheckCheck, MessageCircleQuestion, OctagonX, ShieldAlert, CircleCheck } from "lucide-react"
import { useApp } from "@/store/app"
import { markAllNotificationsRead, markNotificationRead, openSession, setNotificationsOpen } from "@/store/actions"
import { useRelTime } from "@/components/common/RelativeTime"
import { EmptyState } from "@/components/common/bits"
import type { AppNotification } from "@/lib/model"
import { cn } from "@/lib/utils"

export function NotificationList() {
  const items = useApp((s) => s.notifications)
  const unread = items.filter((n) => !n.readAt).length
  return (
    <div className="flex max-h-[480px] flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
        <span className="text-xs font-medium">Notifications</span>
        {unread > 0 && <span className="tabular text-[11px] text-fg-faint" title={`${unread} unread`}>{unread}</span>}
        <button
          className="ml-auto flex h-5 items-center gap-1 rounded-sm px-1.5 text-[11px] text-fg-faint hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40"
          onClick={markAllNotificationsRead}
          disabled={unread === 0}
        >
          <CheckCheck size={12} /> Mark all read
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {items.length === 0 ? (
          <EmptyState>No notifications.</EmptyState>
        ) : (
          items.slice(0, 60).map((n) => <Row key={n.id} n={n} />)
        )}
      </div>
    </div>
  )
}

const ICON = {
  permission: <ShieldAlert size={14} color="var(--st-perm)" />,
  question: <MessageCircleQuestion size={14} color="var(--st-input)" />,
  error: <OctagonX size={14} color="var(--st-error)" />,
  finished: <CircleCheck size={14} color="var(--st-done)" />,
}

const Row = memo(function Row({ n }: { n: AppNotification }) {
  const age = useRelTime(n.createdAt)
  return (
    <button
      className={cn("flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-hover", !n.readAt && "bg-elevated/40")}
      title={n.kind === "finished" ? n.body : undefined}
      onClick={() => {
        if (!n.readAt) markNotificationRead(n.id)
        setNotificationsOpen(false)
        openSession(n.sessionId)
      }}
    >
      <span className="mt-px shrink-0">{ICON[n.kind]}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn("truncate text-xs", n.readAt ? "text-fg-muted" : "font-medium text-fg")}>{n.title}</span>
          {n.count > 1 && <span className="tabular shrink-0 text-[10.5px] text-fg-faint">×{n.count}</span>}
        </span>
        {/* context line only when it carries signal (§2.5): what it waits for, or the error */}
        {n.kind !== "finished" && n.body && (
          <span className={cn("block truncate text-[11.5px] text-fg-faint", n.kind === "permission" && "font-mono text-[11px]")}>{n.body}</span>
        )}
      </span>
      <span className="tabular shrink-0 text-[11px] text-fg-faint">{age}</span>
    </button>
  )
})
