import {
  currentSessionId,
  forkSession,
  goToNextWaiting,
  interrupt,
  openArchive,
  openHistory,
  openNewSession,
  openOverview,
  openReview,
  openSettings,
  setEngine,
  addDiscoveredSession,
} from "@/store/actions"
import { getApp } from "@/store/app"
import { REAL } from "@/backend/mode"
import { archiveWithUndo } from "@/features/notifications/undo"
import { openShortcutsHelp } from "@/app/ShortcutsHelp"
import { accountsOf, accountTitle, activeAccountOf } from "@/lib/accounts"
import { setActiveAccount } from "@/features/accounts/accountState"

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
  { id: "resume", title: "History: every past session", keywords: "history continue old resume past find", shortcut: ["mod", "shift", "H"], run: openHistory },
  { id: "overview", title: "Overview", keywords: "home tree map", shortcut: ["mod", "0"], run: openOverview },
  { id: "archive-view", title: "Archived sessions", keywords: "archived hidden restore", run: openArchive },
  { id: "find", title: "Find in chat", keywords: "search text message", shortcut: ["mod", "F"], when: inSession, run: withSession((id) => void import("@/features/session-view/find/find").then((f) => f.openFind(id))) },
  { id: "settings", title: "Settings", keywords: "preferences", shortcut: ["mod", ","], run: openSettings },
  { id: "shortcuts", title: "Keyboard shortcuts", keywords: "keys help", shortcut: ["?"], run: openShortcutsHelp },

  { id: "review", title: "Review changes", keywords: "diff files", when: inSession, run: withSession(openReview) },
  { id: "rewind", title: "Rewind…", keywords: "undo checkpoint restore back", when: inSession, run: withSession((id) => setTimeout(() => window.dispatchEvent(new CustomEvent("sd:rewind", { detail: id })), 0)) },
  { id: "interrupt", title: "Interrupt", keywords: "stop", when: inSession, run: withSession(interrupt) },
  { id: "fork", title: "Fork session", keywords: "copy branch", when: inSession, run: withSession(forkSession) },
  { id: "popout", title: "Open session in new window", keywords: "window detach side by side monitor", when: inSession, run: withSession((id) => void import("@/app/popout").then((p) => p.openSessionWindow(id))) },
  { id: "archive", title: "Archive session", keywords: "hide finish done", when: inSession, run: withSession((id) => archiveWithUndo([id])) },

  { id: "engine-toggle", title: "Pause or resume mock activity", keywords: "developer engine", when: () => !REAL, run: () => setEngine({ running: !getApp().engine.running }) },
  {
    id: "simulate-terminal",
    title: "Simulate a session started in a terminal",
    keywords: "developer discover cli external",
    // the browser preview only: in the app this would start a real claude
    when: () => !REAL,
    run: () => {
      const n = getApp().repoOrder.length
      addDiscoveredSession(n % 2 ? "~/code/scratch" : "~/code/api-gateway", n % 2 ? "Try the new streaming API" : "Bump TypeScript to 6.1")
    },
  },
]

/** Ctrl+K → "Switch account": every account but the active one (and Manage accounts). */
export function accountCommands(): Command[] {
  const st = getApp()
  const active = activeAccountOf(st)
  const list = accountsOf(st)
  if (list.length < 2) return [{ id: "account-add", title: "Add a Claude account", keywords: "account login email switch token", run: () => openSettings("accounts:add") }]
  return [
    ...list
      .filter((a) => a.id !== active)
      .map((a) => ({ id: `account:${a.id || "login"}`, title: `Switch account: ${accountTitle(a)}`, keywords: `account login email switch ${a.email ?? ""} ${a.label ?? ""}`, run: () => setActiveAccount(a.id) })),
    { id: "accounts", title: "Manage accounts", keywords: "account login email switch token", run: () => openSettings("accounts") },
  ]
}
