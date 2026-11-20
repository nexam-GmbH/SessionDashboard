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
import type { World } from "@/mocks/world"
import { POPOUT, REAL } from "@/backend/mode"
import { isRecord, readSettings, SETTINGS_KEY } from "./settingsSchema"

/**
 * One normalized zustand store: records keyed by id, components
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
  /** the effort your Claude Code settings give a session (all models, or per model) */
  effort?: { default?: string; byModel: Record<string, string> }
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
  /** other Claude Code config folders (accounts) whose sessions and usage are read too */
  claudeConfigDirs: string[]
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
  /** chat transcript detail (Claude Code desktop): tool calls folded, + thinking, or every step (Ctrl+O cycles) */
  transcriptView: "normal" | "thinking" | "verbose"
  /** what sends a message: Enter (Claude Code's default) or Ctrl/⌘+Enter (then Enter adds a line) */
  sendKey: "enter" | "mod-enter"
  /** the chat column: readable (~820 px, Claude Code desktop) or wide */
  chatWidth: "readable" | "wide"
  /** the built-in terminal's shell (an id from term_shells: zsh, gitbash, wsl…); "" = the usual one */
  terminalShell: string
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
  /** the Claude Code config folder (account) its new sessions use; unset: the main one */
  configDir?: string
  /**
   * The session that leads the workspace (by id, wherever it runs: started in ~, in the app or in
   * a terminal through sd-wrap): shown first in the workspace's main folder, marked "lead".
   */
  lead?: string
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
  /** the Settings dialog (Ctrl+,) and the section it shows */
  settingsOpen: string | null
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

/**
 * Saved settings, checked against the registry (store/settingsSchema.ts): a value of the wrong kind
 * or out of range loads as its default, so stored data can never stop the app from starting.
 */
function loadSettings(): Settings {
  let saved: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}")
    if (isRecord(parsed)) saved = { ...parsed }
  } catch {
    /* storage unavailable or unreadable: the defaults */
  }
  // settings saved before the app drew its own title bar: switch once to the single bar
  if (saved.chrome !== 2) saved.nativeTitlebar = false
  // the stock shadcn theme has 14px text where the old one had 13px: a saved 110% becomes 100%
  // (the same size on screen), once
  if (saved.theme !== 2 && typeof saved.uiScale === "number" && Math.abs(saved.uiScale - 1.1) < 0.01) saved.uiScale = 1
  // a finished turn became a badge only (alerts are for what blocks a session): switch it off once
  if (saved.notifyV !== 2) saved.notify = { ...(isRecord(saved.notify) ? saved.notify : {}), finished: false }
  // a first version kept plain folders: one workspace "Work"
  if (Array.isArray(saved.workspaces) && saved.workspaces.some((w) => typeof w === "string")) {
    saved.workspaces = [{ id: "work", name: "Work", folders: saved.workspaces.filter((w) => typeof w === "string") }]
    saved.workspace = "work"
  }
  // the markers of the switches above stay with the settings, so each runs once
  const s: Settings = Object.assign(readSettings(saved), { chrome: 2, theme: 2, notifyV: 2 })
  // a session window: the system's frame, no session list (and it never saves settings)
  return POPOUT ? { ...s, nativeTitlebar: true, sidebarHidden: true, detailsOpen: false } : s
}

/** the desktop app starts empty and fills from Claude Code (backend/real.ts); the browser's mock
 * world is set by mocks/boot before the first render, so the desktop app never loads its generator */
const EMPTY_WORLD: World = { repos: {}, repoOrder: [], repoSpecs: {}, sessions: {}, sessionIdsByRepo: {}, mainSessionId: "", subagents: {}, subagentIdsBySession: {}, requests: {}, notifications: [] }

export const useApp = create<AppState>()(
  subscribeWithSelector((): AppState => ({
    ...EMPTY_WORLD,
    transcripts: {},
    structVersion: 0,
    statusVersion: 0,

    route: "/",
    screen: null,
    recent: [],
    paletteOpen: false,
    settingsOpen: null,
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
    if (POPOUT) return
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      /* storage unavailable: settings stay in memory */
    }
  },
)
