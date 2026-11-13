import { Bell, PanelBottom, PanelLeft, PanelRight, Search, ShieldAlert } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Shortcut } from "@/components/common/bits"
import { useApp } from "@/store/app"
import { selectWaitingCount } from "@/store/selectors"
import { goToNextWaiting, openPalette, setNotificationsOpen, togglePanel } from "@/store/actions"
import { IN_TAURI, OS } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { WindowControls } from "./WindowControls"
import { NotificationList } from "@/features/notifications/NotificationList"

/**
 * Titlebar — UI_PLAN §4.1. Per-OS chrome from Yaak (MIT): macOS overlay with
 * inset traffic lights, Windows undecorated with our controls, Linux native
 * decorations by default. Layout after Orca's TitlebarMainStrip (MIT):
 * breadcrumb · centered palette trigger · attention · panel toggles.
 */
export function Titlebar() {
  const nativeTitlebar = useApp((s) => s.settings.nativeTitlebar)
  const customChrome = IN_TAURI && (OS === "windows" || (OS === "linux" && !nativeTitlebar))
  return (
    <header
      data-tauri-drag-region
      className="relative flex h-[var(--titlebar-h)] shrink-0 items-center gap-2 border-b border-line-subtle bg-chrome"
    >
      <div
        data-tauri-drag-region
        className={cn("flex min-w-0 flex-1 items-center gap-2", OS === "macos" && IN_TAURI ? "pl-[78px]" : "pl-3")}
      >
        <AppMark />
        <span data-tauri-drag-region className="text-xs text-fg-faint">Session Dashboard</span>
      </div>
      <PaletteTrigger />
      <div data-tauri-drag-region className="flex flex-1 items-center justify-end gap-0.5 pr-1.5">
        <AttentionButton />
        <NotificationsButton />
        <div className="mx-1 h-4 w-px bg-line-subtle" />
        <PanelToggles />
        {customChrome && <WindowControls />}
      </div>
    </header>
  )
}

function AppMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-fg-muted">
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1" fill="currentColor" opacity="0.5" />
      <path d="M4 6.5v4.5h5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function PaletteTrigger() {
  return (
    <button
      onClick={() => openPalette()}
      aria-label="Search sessions, repos, commands"
      aria-keyshortcuts="Control+K"
      className="flex h-6 w-[min(420px,36vw)] shrink-0 items-center gap-2 rounded-md border border-line-subtle bg-canvas px-2 text-xs text-fg-faint transition-colors hover:border-line hover:text-fg-muted"
    >
      <Search size={13} />
      <span className="truncate">Search sessions, repos, commands…</span>
      <Shortcut keys={["mod", "K"]} className="ml-auto" />
    </button>
  )
}

function AttentionButton() {
  const waiting = useApp(selectWaitingCount)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => void goToNextWaiting()}
          aria-label={waiting ? `${waiting} need you, jump to next` : "Nothing needs you"}
          aria-keyshortcuts="N"
          className={cn(
            "flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors hover:bg-hover",
            waiting ? "text-st-perm-fg" : "text-fg-faint",
          )}
        >
          <ShieldAlert size={14} />
          <span className="tabular">{waiting}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {waiting ? `${waiting} need you · jump to next` : "Nothing needs you"} <Shortcut keys={["N"]} className="ml-1" />
      </TooltipContent>
    </Tooltip>
  )
}

function NotificationsButton() {
  const open = useApp((s) => s.notificationsOpen)
  const unread = useApp((s) => s.notifications.filter((n) => !n.readAt).length)
  return (
    <Popover open={open} onOpenChange={setNotificationsOpen}>
      <PopoverTrigger asChild>
        <button className="relative flex size-6 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
          <Bell size={14} />
          {unread > 0 && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-brand" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[380px] p-0">
        <NotificationList />
      </PopoverContent>
    </Popover>
  )
}

function PanelToggles() {
  const panels = useApp((s) => s.panels)
  const item = (key: "sidebar" | "bottom" | "inspector", Icon: typeof PanelLeft, label: string, keys: string[]) => (
    <Tooltip key={key}>
      <TooltipTrigger asChild>
        <button
          onClick={() => togglePanel(key)}
          className={cn(
            "flex size-6 items-center justify-center rounded-md transition-colors hover:bg-hover",
            panels[key] ? "text-fg-muted" : "text-fg-faint opacity-70",
          )}
          aria-label={label}
          aria-pressed={panels[key]}
        >
          <Icon size={14} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <Shortcut keys={keys} className="ml-1" />
      </TooltipContent>
    </Tooltip>
  )
  return (
    <>
      {item("sidebar", PanelLeft, "Toggle sidebar", ["mod", "B"])}
      {item("bottom", PanelBottom, "Toggle panel", ["mod", "J"])}
      {item("inspector", PanelRight, "Toggle inspector", ["mod", "Alt", "B"])}
    </>
  )
}
