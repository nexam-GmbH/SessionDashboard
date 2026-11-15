// The window header on top of the inset panel (create-tauri-ui starter "site header", MIT): the
// sidebar toggle, what is on screen (a session: its title, repo, branch, changes and menu), the Undo
// notice, the one loud signal ("2 need you") and, without a system frame, the window buttons. The
// whole bar drags the window and double-click maximizes.
import { useState } from "react"
import { SquareTerminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toggleTerminal, useTerminal } from "@/features/terminal/terminals"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Shortcut } from "@/components/common/bits"
import { useApp } from "@/store/app"
import { activeWorkspace, selectNeedsYou } from "@/store/selectors"
import { currentSessionId, goToNextWaiting } from "@/store/actions"
import { SessionHeader } from "@/features/session-view/header/SessionHeader"
import { UndoNotice } from "@/features/notifications/UndoNotice"
import { cn } from "@/lib/utils"
import { WindowControls } from "./WindowControls"
import { customChrome } from "./chrome"

export function SiteHeader() {
  const native = useApp((s) => s.settings.nativeTitlebar)
  return (
    <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mx-1 h-4 data-vertical:self-auto" />
      <ScreenTitle />
      <UndoNotice />
      <NeedsYou />
      <TerminalButton />
      {customChrome(native) && <WindowControls />}
    </header>
  )
}

const TITLES: Record<string, string> = { new: "New session", settings: "Settings", archive: "Archive", review: "Review", usage: "Usage" }

function ScreenTitle() {
  const route = useApp((s) => s.route)
  const [, kind, ref] = route.split("/")
  const workspace = useApp((s) => activeWorkspace(s)?.name)
  const reviewOf = useApp((s) => (kind === "review" && ref ? s.sessions[ref]?.title : undefined))
  if (kind === "session" && ref) return <SessionHeader key={ref} sessionId={ref} />
  const title = kind ? (TITLES[kind] ?? "") : "Overview"
  const sub = kind === "review" ? reviewOf : !kind ? workspace : undefined
  return (
    <div data-tauri-drag-region className="flex min-w-0 flex-1 items-baseline gap-2">
      <h1 data-tauri-drag-region className="shrink-0 text-sm font-medium">
        {title}
      </h1>
      {sub && (
        <span data-tauri-drag-region className="truncate text-xs text-muted-foreground">
          {sub}
        </span>
      )}
    </div>
  )
}

/**
 * The one loud thing in the chrome; hidden when nothing needs you. Colour follows the most urgent
 * kind waiting: permission (orange) over question or plan (amber) over error (red). No animation:
 * the count changing is the signal.
 */
function NeedsYou() {
  const count = useApp((s) => selectNeedsYou(s).length)
  const tone = useApp((s) => {
    const st = selectNeedsYou(s).map((id) => s.sessions[id].status)
    return st.includes("waiting_input") && !st.includes("waiting_permission") ? "input" : st.length && st.every((x) => x === "error") ? "error" : "perm"
  })
  const next = useApp((s) => {
    const list = selectNeedsYou(s)
    const cur = currentSessionId()
    const i = cur ? list.indexOf(cur) : -1
    const id = list[(i + 1) % Math.max(1, list.length)]
    return id ? s.sessions[id]?.title : undefined
  })
  const [hover, setHover] = useState(false)
  if (!count) return null
  return (
    <Tooltip open={hover} onOpenChange={setHover}>
      <TooltipTrigger asChild>
        <button
          onClick={goToNextWaiting}
          aria-keyshortcuts="Control+J"
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            tone === "perm" && "bg-st-perm-tint text-st-perm-fg hover:bg-st-perm/25",
            tone === "input" && "bg-st-input-tint text-st-input-fg hover:bg-st-input/25",
            tone === "error" && "bg-st-error-tint text-st-error-fg hover:bg-st-error/25",
          )}
        >
          <span aria-hidden className={cn("size-1.5 rounded-full", tone === "perm" ? "bg-st-perm" : tone === "input" ? "bg-st-input" : "bg-st-error")} />
          <span className="tabular">{count}</span> need you
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[320px]">
        Next: {next} <Shortcut keys={["mod", "J"]} className="ml-1" />
      </TooltipContent>
    </Tooltip>
  )
}

function TerminalButton() {
  const open = useTerminal((s) => s.open)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Terminal" aria-pressed={open} aria-keyshortcuts="Control+`" onClick={toggleTerminal} className={cn(open && "bg-muted text-foreground")}>
          <SquareTerminal />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Terminal <Shortcut keys={["mod", "`"]} className="ml-1" />
      </TooltipContent>
    </Tooltip>
  )
}
