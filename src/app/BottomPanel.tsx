import { lazy, Suspense } from "react"
import { X, SquareTerminal, ListTree } from "lucide-react"
import { useApp } from "@/store/app"
import { setBottomTab, togglePanel } from "@/store/actions"
import { cn } from "@/lib/utils"

const TerminalPanel = lazy(() => import("@/features/terminal/TerminalPanel"))
const EventLog = lazy(() => import("@/features/terminal/EventLog"))

/** Bottom panel — UI_PLAN §4.5: Terminal (PTY view) and Events (normalized hook/stream events). */
export function BottomPanel() {
  const tab = useApp((s) => s.panels.bottomTab)
  const open = useApp((s) => s.panels.bottom)
  const sessionId = useApp((s) => (s.selection?.kind === "session" ? s.selection.id : s.activeTab.startsWith("/session/") ? s.activeTab.split("/")[2] : null))
  const title = useApp((s) => (sessionId ? s.sessions[sessionId]?.title : undefined))
  return (
    <div className="flex h-full min-h-0 flex-col border-t border-line-subtle">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line-subtle px-2">
        {(
          [
            ["terminal", "Terminal", SquareTerminal],
            ["events", "Events", ListTree],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setBottomTab(id)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-sm px-2 text-[11px] font-medium tracking-wide uppercase",
              tab === id ? "text-fg" : "text-fg-faint hover:text-fg-muted",
            )}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
        <span className="ml-2 truncate text-[11px] text-fg-faint">{title ?? "Select a session"}</span>
        <button className="ml-auto flex size-6 items-center justify-center rounded-sm text-fg-faint hover:bg-hover hover:text-fg" onClick={() => togglePanel("bottom", false)} aria-label="Close panel">
          <X size={13} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {open && (
          <Suspense fallback={null}>
            {tab === "terminal" ? <TerminalPanel sessionId={sessionId} /> : <EventLog sessionId={sessionId} />}
          </Suspense>
        )}
      </div>
    </div>
  )
}
