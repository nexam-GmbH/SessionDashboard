// Control-mode banners: one short line
// with the action. Observed sessions take messages but approvals happen in the user's
// terminal (take over = stop there, resume here); history sessions offer
// Resume and Fork.
import { memo } from "react"
import { Cloud, ExternalLink, GitFork, History, Play, Server, SquareTerminal } from "lucide-react"
import type { ID } from "@/lib/model"
import { useApp } from "@/store/app"
import { forkSession, resumeSession, takeOverSession, openSettings } from "@/store/actions"
import { useRelTime } from "@/components/common/RelativeTime"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CONTROL_LABEL } from "@/lib/status"
import { REAL } from "@/backend/mode"

const BAR = "flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card px-3 text-xs text-muted-foreground"

export const ControlBanner = memo(function ControlBanner({ sessionId }: { sessionId: ID }) {
  const control = useApp((s) => s.sessions[sessionId]?.control)
  const updatedAt = useApp((s) => s.sessions[sessionId]?.updatedAt)
  const machine = useApp((s) => s.sessions[sessionId]?.machine)
  const url = useApp((s) => s.sessions[sessionId]?.url)
  const hooks = useApp((s) => !!s.hooks?.installed)
  const ago = useRelTime(updatedAt)
  if (control === "cloud") {
    return (
      <div className={BAR}>
        <Cloud size={13} className="shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate" title={CONTROL_LABEL.cloud}>
          Runs on claude.ai <span className="text-muted-foreground/70">· messages go from here, permission prompts are answered there</span>
        </span>
        {url && (
          <Button size="xs" variant="outline" asChild>
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLink /> Open on claude.ai
            </a>
          </Button>
        )}
      </div>
    )
  }
  if (control === "observed") {
    const Icon = machine ? Server : SquareTerminal
    return (
      <div className={BAR}>
        <Icon size={13} className="shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate" title={CONTROL_LABEL.observed}>
          {machine ? `Running in a terminal on ${machine}` : "Running in your terminal"}{" "}
          <span className="text-muted-foreground/70">
            {!REAL ? "· approve there" : hooks ? "· its prompts can be answered here or there" : "· prompts are answered there"}
          </span>
        </span>
        {REAL && !hooks && !machine && (
          <Button size="xs" variant="ghost" onClick={() => openSettings()} title="Settings → Exact states from hooks: then this session's prompts show up here with Allow / Deny">
            Answer prompts here
          </Button>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <Button size="xs" variant="outline">
              Take over
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[260px] gap-2 rounded-md border border-border p-3 text-xs shadow-lg ring-0">
            <div className="text-muted-foreground">
              It closes in your terminal (as Ctrl+C twice would) and continues here with the whole conversation. Typing below never closes it: the reply goes into its terminal when the terminal allows it (Konsole, tmux, kitty, WezTerm), else into a copy here.
            </div>
            <Button size="sm" variant="default" className="self-start" onClick={() => takeOverSession(sessionId)}>
              <Play /> Close there, continue here
            </Button>
          </PopoverContent>
        </Popover>
      </div>
    )
  }
  if (control === "history") {
    return (
      <div className={BAR}>
        <History size={13} className="shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate" title={CONTROL_LABEL.history}>
          Not running{machine ? ` · on ${machine}` : ""}
          {ago && <span className="text-muted-foreground/70"> · {ago === "now" ? "just now" : /^\d/.test(ago) ? `${ago} ago` : ago}</span>}
          {REAL && <span className="text-muted-foreground/70"> · write below to continue it</span>}
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
