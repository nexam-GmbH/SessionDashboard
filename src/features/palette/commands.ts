import {
  currentSessionId,
  forkSession,
  goToNextWaiting,
  interrupt,
  openArchive,
  openNewSession,
  openOverview,
  openReview,
  openSettings,
  setEngine,
  addDiscoveredSession,
} from "@/store/actions"
import { getApp } from "@/store/app"
import { archiveWithUndo } from "@/features/notifications/undo"
import { openShortcutsHelp } from "@/app/ShortcutsHelp"

/**
 * The few commands the palette offers next to sessions. `when` hides the ones that don't apply.
 * Shortcuts are shown, not bound, here (bindings live in shortcuts.ts).
 */
export interface Command {
  id: string
  title: string
  keywords?: string
  shortcut?: string[]
  when?: () => boolean
  run: () => void
}

const inSession = () => !!currentSessionId()
const withSession = (fn: (id: string) => void) => () => {
  const id = currentSessionId()
  if (id) fn(id)
}

export const COMMANDS: Command[] = [
  { id: "next-waiting", title: "Next session that needs you", keywords: "waiting attention jump", shortcut: ["mod", "J"], run: goToNextWaiting },
  { id: "new-session", title: "New session", keywords: "start create", shortcut: ["mod", "N"], run: () => openNewSession() },
  { id: "resume", title: "Resume a past session", keywords: "history continue old", run: () => openNewSession() },
  { id: "overview", title: "Overview", keywords: "home tree map", shortcut: ["mod", "0"], run: openOverview },
  { id: "archive-view", title: "Archive", keywords: "archived hidden restore", run: openArchive },
  { id: "settings", title: "Settings", keywords: "preferences", shortcut: ["mod", ","], run: openSettings },
  { id: "shortcuts", title: "Keyboard shortcuts", keywords: "keys help", shortcut: ["?"], run: openShortcutsHelp },

  { id: "review", title: "Review changes", keywords: "diff files", when: inSession, run: withSession(openReview) },
  { id: "rewind", title: "Rewind…", keywords: "undo checkpoint restore back", when: inSession, run: withSession((id) => setTimeout(() => window.dispatchEvent(new CustomEvent("sd:rewind", { detail: id })), 0)) },
  { id: "interrupt", title: "Interrupt", keywords: "stop", when: inSession, run: withSession(interrupt) },
  { id: "fork", title: "Fork session", keywords: "copy branch", when: inSession, run: withSession(forkSession) },
  { id: "popout", title: "Open session in new window", keywords: "window detach side by side monitor", when: inSession, run: withSession((id) => void import("@/app/popout").then((p) => p.openSessionWindow(id))) },
  { id: "archive", title: "Archive session", keywords: "hide finish done", when: inSession, run: withSession((id) => archiveWithUndo([id])) },

  { id: "engine-toggle", title: "Pause or resume mock activity", keywords: "developer engine", run: () => setEngine({ running: !getApp().engine.running }) },
  {
    id: "simulate-terminal",
    title: "Simulate a session started in a terminal",
    keywords: "developer discover cli external",
    run: () => {
      const n = getApp().repoOrder.length
      addDiscoveredSession(n % 2 ? "~/code/scratch" : "~/code/api-gateway", n % 2 ? "Try the new streaming API" : "Bump TypeScript to 6.1")
    },
  },
]
