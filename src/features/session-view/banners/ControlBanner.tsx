// Control-mode banners — UI_PLAN §5.3 / RESEARCH §1.4, calm rules §2.5: one short line
// with the action. Observed sessions are read-only for approvals here (they happen in
// the user's terminal; take over = stop there, resume here); history sessions offer
// Resume and Fork.
import { memo } from "react"
import { GitFork, History, Play, SquareTerminal } from "lucide-react"
import type { ID } from "@/lib/model"
import { useApp } from "@/store/app"
import { forkSession, resumeSession } from "@/store/actions"
import { useRelTime } from "@/components/common/RelativeTime"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CONTROL_LABEL } from "@/lib/status"

const BAR = "flex h-8 shrink-0 items-center gap-2 border-b border-line-subtle bg-chrome px-3 text-[12px] text-fg-muted"

export const ControlBanner = memo(function ControlBanner({ sessionId }: { sessionId: ID }) {
  const control = useApp((s) => s.sessions[sessionId]?.control)
  const updatedAt = useApp((s) => s.sessions[sessionId]?.updatedAt)
  const ago = useRelTime(updatedAt)
  if (control === "observed") {
    return (
      <div className={BAR}>
        <SquareTerminal size={13} className="shrink-0 text-fg-faint" />
        <span className="min-w-0 flex-1 truncate" title={CONTROL_LABEL.observed}>
          Read-only <span className="text-fg-faint">· started in your terminal</span>
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="xs" variant="secondary">
              Take over
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[260px] gap-2 rounded-md border border-line p-3 text-[12.5px] shadow-lg ring-0">
            <div className="text-fg-muted">
              Stop it in your terminal first <span className="font-mono text-[11.5px] text-fg-faint">(Ctrl+C ×2)</span>, then resume it here.
            </div>
            <Button size="sm" variant="default" className="self-start" onClick={() => resumeSession(sessionId)}>
              <Play /> Resume here
            </Button>
          </PopoverContent>
        </Popover>
      </div>
    )
  }
  if (control === "history") {
    return (
      <div className={BAR}>
        <History size={13} className="shrink-0 text-fg-faint" />
        <span className="min-w-0 flex-1 truncate" title={CONTROL_LABEL.history}>
          Not running
          {ago && <span className="text-fg-faint"> · {ago === "now" ? "just now" : /^\d/.test(ago) ? `${ago} ago` : ago}</span>}
        </span>
        <Button size="xs" variant="default" onClick={() => resumeSession(sessionId)}>
          <Play /> Resume
        </Button>
        <Button size="xs" variant="ghost" onClick={() => forkSession(sessionId)}>
          <GitFork /> Fork
        </Button>
      </div>
    )
  }
  return null
})
