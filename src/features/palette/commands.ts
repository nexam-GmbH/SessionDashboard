import { navigate } from "@/app/nav"
import { getApp } from "@/store/app"
import {
  archiveSession,
  closeTab,
  goToNextWaiting,
  interrupt,
  openCrossRepo,
  openNewSession,
  reopenClosedTab,
  setEngine,
  setLayoutPreset,
  togglePanel,
  patchMap,
  forkSession,
} from "@/store/actions"
import { setSessionsFilter } from "@/features/sessions/sessionsUi"
import { openPopout } from "@/app/popout"

/**
 * Command registry (UI_PLAN §5.9): one list drives the palette, keyboard
 * shortcuts and menus. `when` hides commands that don't apply right now.
 */
export interface Command {
  id: string
  title: string
  group: "Create" | "Go to" | "Session" | "View" | "Map" | "Developer"
  keywords?: string
  shortcut?: string[]
  when?: () => boolean
  run: () => void
}

const activeSessionId = () => {
  const t = getApp().activeTab
  return t.startsWith("/session/") ? t.split("/")[2] : null
}

export const COMMANDS: Command[] = [
  { id: "new-session", title: "New session…", group: "Create", shortcut: ["mod", "N"], run: () => openNewSession() },
  { id: "new-cross-repo", title: "New cross-repo task…", group: "Create", keywords: "main agent multi repo", shortcut: ["mod", "Shift", "N"], run: () => openCrossRepo() },
  { id: "resume", title: "Resume a session…", group: "Create", keywords: "history continue", run: () => openNewSession(undefined, "resume") },

  { id: "next-waiting", title: "Go to next session that needs you", group: "Go to", shortcut: ["N"], run: () => void goToNextWaiting() },
  { id: "go-map", title: "Go to Map", group: "Go to", shortcut: ["G", "M"], run: () => navigate("/map") },
  { id: "go-sessions", title: "Go to Sessions", group: "Go to", shortcut: ["G", "S"], run: () => navigate("/sessions") },
  { id: "go-archive", title: "Go to Archive", group: "Go to", keywords: "archived hidden restore", run: () => { setSessionsFilter({ view: "archived" }); navigate("/sessions") } },
  { id: "go-history", title: "Go to History", group: "Go to", keywords: "old past sessions", run: () => { setSessionsFilter({ view: "history" }); navigate("/sessions") } },
  { id: "go-graph", title: "Go to Code graph (all repos)", group: "Go to", shortcut: ["G", "G"], run: () => navigate("/graph/global") },
  { id: "go-settings", title: "Open Settings", group: "Go to", shortcut: ["mod", ","], run: () => navigate("/settings") },

  { id: "interrupt", title: "Interrupt current session", group: "Session", shortcut: ["Esc"], when: () => !!activeSessionId(), run: () => { const id = activeSessionId(); if (id) interrupt(id) } },
  { id: "fork", title: "Fork current session", group: "Session", when: () => !!activeSessionId(), run: () => { const id = activeSessionId(); if (id) forkSession(id) } },
  { id: "archive", title: "Archive current session", group: "Session", keywords: "hide finish done", when: () => !!activeSessionId(), run: () => { const id = activeSessionId(); if (id) archiveSession(id) } },
  { id: "popout", title: "Open current session in new window", group: "Session", keywords: "pop out window detach", when: () => !!activeSessionId(), run: () => void openPopout(getApp().activeTab) },
  { id: "review", title: "Review changes of current session", group: "Session", when: () => !!activeSessionId(), run: () => { const id = activeSessionId(); if (id) navigate(`/review/${id}`) } },

  { id: "toggle-sidebar", title: "Toggle sidebar", group: "View", shortcut: ["mod", "B"], run: () => togglePanel("sidebar") },
  { id: "toggle-inspector", title: "Toggle inspector", group: "View", shortcut: ["mod", "Alt", "B"], run: () => togglePanel("inspector") },
  { id: "toggle-bottom", title: "Toggle bottom panel", group: "View", shortcut: ["mod", "J"], run: () => togglePanel("bottom") },
  { id: "layout-default", title: "Layout: Default", group: "View", run: () => setLayoutPreset("default") },
  { id: "layout-focus", title: "Layout: Focus", group: "View", run: () => setLayoutPreset("focus") },
  { id: "layout-review", title: "Layout: Review", group: "View", run: () => setLayoutPreset("review") },
  { id: "close-tab", title: "Close tab", group: "View", shortcut: ["mod", "W"], run: () => closeTab(getApp().activeTab) },
  { id: "reopen-tab", title: "Reopen closed tab", group: "View", shortcut: ["mod", "Shift", "T"], run: () => reopenClosedTab() },

  { id: "map-links", title: "Map: Toggle repo links", group: "Map", shortcut: ["L"], run: () => patchMap({ showLinks: !getApp().map.showLinks }) },
  { id: "map-history-7d", title: "Map: Show history (7 days)", group: "Map", run: () => patchMap({ historyRange: "7d" }) },
  { id: "map-history-off", title: "Map: Hide history", group: "Map", run: () => patchMap({ historyRange: "off" }) },

  { id: "engine-toggle", title: "Mock engine: pause / resume", group: "Developer", run: () => setEngine({ running: !getApp().engine.running }) },
  { id: "dev-webgl", title: "WebGL check", group: "Developer", run: () => navigate("/dev/webgl") },
  { id: "dev-perf", title: "Performance harness", group: "Developer", run: () => navigate("/dev/perf") },
  { id: "fixture-stress", title: "Reload with stress fixture", group: "Developer", run: () => { try { localStorage.setItem("sd.fixture", "stress") } catch { /* ignore */ } location.reload() } },
  { id: "fixture-normal", title: "Reload with normal fixture", group: "Developer", run: () => { try { localStorage.setItem("sd.fixture", "normal") } catch { /* ignore */ } location.reload() } },
]

/** Subsequence fuzzy score (higher is better), 0 = no match. */
export function fuzzyScore(query: string, text: string) {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx >= 0) return 1000 - idx - (t.length - q.length) * 0.1 + (idx === 0 || t[idx - 1] === " " ? 200 : 0)
  let ti = 0
  let score = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return 0
    streak = found === ti ? streak + 1 : 0
    score += 1 + streak * 2
    ti = found + 1
  }
  return score
}
