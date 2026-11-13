import { create } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"
import type {
  AppNotification,
  ID,
  PendingRequest,
  Repo,
  RepoLink,
  Selection,
  Session,
  SessionStatus,
  Subagent,
  Transcript,
} from "@/lib/model"
import type { RepoSpec } from "@/mocks/catalog"
import { generateWorld, type FixtureName } from "@/mocks/world"

/**
 * One normalized zustand store (UI_PLAN §8): records keyed by id, components
 * select a single record, derived lists are memoized on version counters.
 * Store shape after Orca's slices (MIT) — keyed records, no hot state in Context.
 */

export type TabKind = "map" | "sessions" | "session" | "review" | "repo" | "graph" | "settings" | "dev"

export interface Tab {
  /** route pathname, e.g. "/session/s_ab12" */
  key: string
  kind: TabKind
  refId?: string
  pinned?: boolean
  /** VS Code-style preview tab: reused by the next open until you interact with it or double-click it */
  preview?: boolean
}

export interface Toast {
  id: ID
  sessionId: ID
  kind: AppNotification["kind"]
  title: string
  body: string
  count: number
  createdAt: number
}

export type HistoryRange = "off" | "1d" | "7d" | "30d"

export interface MapUi {
  collapsedRepos: Record<ID, true>
  expandedStacks: Record<ID, true>
  expandedSubagents: Record<ID, true>
  showLinks: boolean
  historyRange: HistoryRange
  statusFilter: SessionStatus[]
  repoFilter: ID[]
}

export interface Settings {
  density: "compact" | "comfortable"
  reduceMotion: boolean
  nativeTitlebar: boolean
  notify: { permission: boolean; question: boolean; finished: boolean; error: boolean; sound: boolean }
  mutedRepos: ID[]
  mapDefaultLod: "auto" | "full" | "compact"
  graphifyAutoBuild: boolean
  graphifyExposeMcp: boolean
  defaults: { model: string; effort: "low" | "medium" | "high" | "xhigh" | "max"; permissionMode: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions"; worktree: boolean }
  claudeConfigDir: string
}

export interface DataState {
  fixture: FixtureName
  repos: Record<ID, Repo>
  repoOrder: ID[]
  repoSpecs: Record<ID, RepoSpec>
  sessions: Record<ID, Session>
  sessionIdsByRepo: Record<ID, ID[]>
  mainSessionId: ID
  subagents: Record<ID, Subagent>
  subagentIdsBySession: Record<ID, ID[]>
  links: RepoLink[]
  requests: Record<ID, PendingRequest>
  notifications: AppNotification[]
  transcripts: Record<ID, Transcript>
  /** bumps on structural change: sessions added/archived/restored, subagents added */
  structVersion: number
  /** bumps on any status change */
  statusVersion: number
}

export interface UiState {
  tabs: Tab[]
  /** LRU of tab keys kept mounted under <Activity> (max 5) */
  mountedTabs: string[]
  activeTab: string
  selection: Selection
  panels: { sidebar: boolean; inspector: boolean; bottom: boolean; bottomTab: "terminal" | "events" }
  layoutPreset: "default" | "focus" | "review"
  sidebarExpanded: Record<ID, true>
  sidebarGroupBy: "repo" | "status" | "recent"
  map: MapUi
  paletteOpen: boolean
  palettePrefix: string
  newSession: null | { repoId?: ID; tab: "new" | "resume" }
  crossRepoOpen: boolean
  notificationsOpen: boolean
  toasts: Toast[]
  engine: { running: boolean; rate: number }
  settings: Settings
  onboarded: boolean
}

export type AppState = DataState & UiState

function readFixture(): FixtureName {
  try {
    const q = new URLSearchParams(window.location.search)
    const f = q.get("fixture") ?? localStorage.getItem("sd.fixture")
    return f === "stress" ? "stress" : "normal"
  } catch {
    return "normal"
  }
}

function readEngine(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("engine") !== "off"
  } catch {
    return true
  }
}

function loadSettings(): Settings {
  const defaults: Settings = {
    density: "compact",
    reduceMotion: false,
    nativeTitlebar: true,
    notify: { permission: true, question: true, finished: true, error: true, sound: false },
    mutedRepos: [],
    mapDefaultLod: "auto",
    graphifyAutoBuild: true,
    graphifyExposeMcp: true,
    defaults: { model: "claude-opus-5-5", effort: "high", permissionMode: "default", worktree: true },
    claudeConfigDir: "~/.claude",
  }
  try {
    const raw = localStorage.getItem("sd.settings")
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults
  } catch {
    return defaults
  }
}

const world = generateWorld(readFixture())

export const PINNED_TABS: Tab[] = [
  { key: "/map", kind: "map", pinned: true },
  { key: "/sessions", kind: "sessions", pinned: true },
]

/**
 * Open tabs survive a reload/restart (VS Code). Tabs whose session/repo no longer exists (other
 * fixture, archived and gone) are dropped; Map and Sessions are always first.
 */
const TABS_KEY = "sd.tabs"
function loadTabs(): Tab[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null") as Tab[] | null
    if (!Array.isArray(raw)) return [...PINNED_TABS]
    const valid = raw.filter((t) => {
      if (!t || typeof t.key !== "string" || t.pinned) return false
      const [, kind, ref] = t.key.split("/")
      if (kind === "session" || kind === "review") return !!ref && !!world.sessions[ref]
      if (kind === "repo") return !!ref && !!world.repos[ref]
      return kind === "graph" || kind === "settings" || kind === "dev"
    })
    return [...PINNED_TABS, ...valid]
  } catch {
    return [...PINNED_TABS]
  }
}

export const useApp = create<AppState>()(
  subscribeWithSelector((): AppState => ({
    ...world,
    transcripts: {},
    structVersion: 0,
    statusVersion: 0,

    tabs: loadTabs(),
    mountedTabs: ["/map"],
    activeTab: "/map",
    selection: null,
    panels: { sidebar: true, inspector: false, bottom: false, bottomTab: "terminal" },
    layoutPreset: "default",
    // Calm UI: only repos with something going on start expanded
    sidebarExpanded: Object.fromEntries(
      world.repoOrder
        .filter((id) =>
          world.sessionIdsByRepo[id].some((sid) => {
            const x = world.sessions[sid]
            return !x.archived && x.control !== "history" && x.status !== "idle" && x.status !== "stopped"
          }),
        )
        .slice(0, 6)
        .map((id) => [id, true as const]),
    ),
    sidebarGroupBy: "repo",
    map: {
      collapsedRepos: {},
      expandedStacks: {},
      expandedSubagents: {},
      showLinks: false,
      historyRange: "off",
      statusFilter: [],
      repoFilter: [],
    },
    paletteOpen: false,
    palettePrefix: "",
    newSession: null,
    crossRepoOpen: false,
    notificationsOpen: false,
    toasts: [],
    engine: { running: readEngine(), rate: 6 },
    settings: loadSettings(),
    onboarded: true,
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

useApp.subscribe(
  (s) => s.tabs,
  (tabs) => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs.filter((t) => !t.pinned)))
    } catch {
      /* storage unavailable: tabs stay in memory */
    }
  },
)
