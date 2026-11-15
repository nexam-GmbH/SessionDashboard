import { create } from "zustand"
import type { MachineStatus } from "@/backend/machines"
import { subscribeWithSelector } from "zustand/middleware"
import type {
  AppNotification,
  ID,
  PendingRequest,
  Repo,
  Session,
  Subagent,
  Transcript,
} from "@/lib/model"
import type { RepoSpec } from "@/mocks/catalog"
import { generateWorld, type World } from "@/mocks/world"
import { REAL } from "@/backend/mode"

/**
 * One normalized zustand store (UI_PLAN §8): records keyed by id, components
 * select a single record, derived lists are memoized on version counters.
 * Store shape after Orca's slices (MIT) — keyed records, no hot state in Context.
 */

/** What the installed claude offers (backend/real.ts asks it once at start). */
export interface ClaudeCaps {
  models: { value: string; displayName: string; description?: string; resolvedModel?: string; supportedEffortLevels?: string[]; supportsFastMode?: boolean }[]
  outputStyles: string[]
  outputStyle: string
  agents: { name: string; description?: string }[]
  commands: { name: string; description: string }[]
  defaultMode?: string
  fastModeDisabledReason?: string
  account?: { email?: string; organization?: string; subscriptionType?: string }
  cloud?: { status: string; sessions: Record<string, unknown>[]; message?: string }
}

export interface Settings {
  reduceMotion: boolean
  nativeTitlebar: boolean
  /** show "Bypass permissions" in the mode picker (off by default, like Claude Code desktop) */
  allowBypass: boolean
  notify: { permission: boolean; question: boolean; finished: boolean; error: boolean; sound: boolean }
  mutedRepos: ID[]
  defaults: { model: string; effort: "low" | "medium" | "high" | "xhigh" | "max"; permissionMode: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions"; worktree: boolean }
  claudeConfigDir: string
  /** VPS machines reached over ssh (an alias from ~/.ssh/config or user@host) */
  machines: { host: string }[]
  /** show the account's cloud sessions (claude.ai/code) */
  cloud: boolean
  /**
   * Workspaces: named overviews ("Work" = ~/work/acme, "Games" = ~/games). The active one shows only
   * the repos in its folders and their sessions, every repo even with no session. None: every git
   * repo with a session (folders that are not a repo, like ~, are left out).
   */
  workspaces: Workspace[]
  /** the active workspace's id; "" = all of them */
  workspace: string
  /** sessions a project shows on the overview: all running ones plus the latest finished, up to this */
  recentPerRepo: number
  /** interface size (web view zoom): 1 = 100% */
  uiScale: number
  /** the session list on the left is hidden (Ctrl+B, the panel button in the top bar) */
  sidebarHidden: boolean
  /** height of the terminal dock, px */
  terminalHeight: number
  /** the session details panel beside the chat */
  detailsOpen: boolean
}

export interface Workspace {
  id: string
  name: string
  /** the repositories it shows, by key (see backend/git.ts repoKey); `path` = a checkout here */
  repos?: { key: string; name: string; path?: string }[]
  /** older form: folders whose repos it shows ("host:~/path" on a VPS machine) */
  folders?: string[]
  /**
   * The workspace's main folder: sessions started there work across all its repos (one agent for
   * a fix that touches every repo). Unset: the folder that holds its repos.
   */
  home?: string
}

export interface DataState {
  repos: Record<ID, Repo>
  repoOrder: ID[]
  repoSpecs: Record<ID, RepoSpec>
  sessions: Record<ID, Session>
  sessionIdsByRepo: Record<ID, ID[]>
  mainSessionId: ID
  subagents: Record<ID, Subagent>
  subagentIdsBySession: Record<ID, ID[]>
  requests: Record<ID, PendingRequest>
  notifications: AppNotification[]
  transcripts: Record<ID, Transcript>
  /** bumps on structural change: sessions added/archived/restored, subagents added */
  structVersion: number
  /** bumps on any status change */
  statusVersion: number
}

export interface UiState {
  /** current route pathname ("/" = overview), mirrored from the router */
  route: string
  /** the last route that is not the overview: what the session area shows (kept while on the overview) */
  screen: string | null
  /** most recently opened sessions, newest first: Ctrl+Tab order and the views kept mounted */
  recent: ID[]
  paletteOpen: boolean
  /** null in the mock world */
  caps: ClaudeCaps | null
  /** Settings → Machines: reachability, tunnel and hook state per ssh host */
  machineStatus: Record<string, MachineStatus>
  cloudStatus: { ok: boolean; count?: number; message?: string } | null
  /** this computer's hook (Settings) */
  hooks: { installed: boolean; error?: string } | null
  /** the spinner words of the installed claude ("Drizzling…", "Cooked for 26s") */
  verbs: { present: string[]; past: string[] } | null
  engine: { running: boolean; rate: number }
  /** the first list of sessions is in (the desktop app reads Claude Code first; skeletons meanwhile) */
  ready: boolean
  settings: Settings
}

export type AppState = DataState & UiState

function readEngine(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("engine") !== "off"
  } catch {
    return true
  }
}

function loadSettings(): Settings {
  const defaults: Settings = {
    reduceMotion: false,
    // one bar like Claude desktop / Zed: the app draws the title bar and window buttons itself
    nativeTitlebar: false,
    allowBypass: false,
    notify: { permission: true, question: true, finished: true, error: true, sound: false },
    mutedRepos: [],
    defaults: { model: "claude-opus-5-5", effort: "high", permissionMode: "default", worktree: true },
    claudeConfigDir: "~/.claude",
    machines: [],
    cloud: true,
    workspaces: [],
    workspace: "",
    recentPerRepo: 5,
    // the stock theme's 14px text: 100% (the old 13px theme started at 110%)
    uiScale: 1,
    sidebarHidden: false,
    terminalHeight: 280,
    detailsOpen: true,
  }
  try {
    const raw = localStorage.getItem("sd.settings")
    const s: Settings = raw ? { ...defaults, ...JSON.parse(raw) } : defaults
    // settings saved before the app drew its own title bar: switch once to the single bar
    const saved = raw ? (JSON.parse(raw) as { chrome?: number }) : {}
    if (saved.chrome !== 2) {
      s.nativeTitlebar = false
      ;(s as Settings & { chrome?: number }).chrome = 2
    }
    // the stock shadcn theme has 14px text where the old one had 13px: a saved 110% becomes 100%
    // (the same size on screen), once
    if ((saved as { theme?: number }).theme !== 2) {
      if (Math.abs(s.uiScale - 1.1) < 0.01) s.uiScale = 1
      ;(s as Settings & { theme?: number }).theme = 2
    }
    // a first version kept plain folders: one workspace "Work"
    if (s.workspaces.some((w) => typeof w === "string")) {
      const folders = (s.workspaces as unknown as string[]).filter((w) => typeof w === "string")
      s.workspaces = [{ id: "work", name: "Work", folders }]
      s.workspace = "work"
    }
    return s
  } catch {
    return defaults
  }
}

/** the desktop app starts empty and fills from Claude Code (backend/real.ts); the browser shows the mock world */
const EMPTY_WORLD: World = { repos: {}, repoOrder: [], repoSpecs: {}, sessions: {}, sessionIdsByRepo: {}, mainSessionId: "", subagents: {}, subagentIdsBySession: {}, requests: {}, notifications: [] }
const world = REAL ? EMPTY_WORLD : generateWorld()

export const useApp = create<AppState>()(
  subscribeWithSelector((): AppState => ({
    ...world,
    transcripts: {},
    structVersion: 0,
    statusVersion: 0,

    route: "/",
    screen: null,
    recent: [],
    paletteOpen: false,
    caps: null,
    machineStatus: {},
    cloudStatus: null,
    hooks: null,
    verbs: null,
    engine: { running: !REAL && readEngine(), rate: 6 },
    ready: !REAL,
    settings: loadSettings(),
  })),
)

export const getApp = useApp.getState
export const setApp = useApp.setState

useApp.subscribe(
  (s) => s.settings,
  (settings) => {
    try {
      localStorage.setItem("sd.settings", JSON.stringify(settings))
    } catch {
      /* storage unavailable: settings stay in memory */
    }
  },
)
