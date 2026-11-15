// The real backend (Phase 2), active in the desktop app: Claude Code sessions instead of the mock
// world. Discovery polls the Rust side (pid files every 2 s, `claude agents --json` every 15 s for
// background sessions, the transcript index every 5 s); open chats tail their JSONL; sessions the
// app starts stream their events (`claude-event`) and get their permission prompts answered here.
// The store and its actions stay the API: components don't know which backend runs.
import { invoke } from "@tauri-apps/api/core"
import { emit, listen } from "@tauri-apps/api/event"
import { getApp, setApp, useApp } from "@/store/app"
import { selectNeedsYou } from "@/store/selectors"
import { POPOUT, REAL } from "./mode"
import type { ClaudeCaps, Workspace } from "@/store/app"
import type { ID, PendingRequest, PermissionMode, PermissionOption, PermissionRequest, PlanApproval, QuestionRequest, Repo, Session, SessionStatus, Transcript } from "@/lib/model"
import { addPendingUser, applyRecords, applyTextDelta, emptyTranscript, endTurn, markAwaiting, newMapState, type MapState } from "./mapTranscript"
import { extByMachine, extSession, folderKey, gitByFolder, hookState, registerSync, requestSync, type ExtSession } from "./ext"
import { onMovedOn, startHooks } from "./hooks"
import { remoteTranscript, remoteTranscriptSince, startMachines } from "./machines"
import { CLOUD, cloudSend, cloudTranscript, pollCloud, applyCloudList } from "./cloud"
import { readGit } from "./git"
import { startNotify } from "./notify"

export { REAL }

// ---------- types from the Rust side ----------
interface Meta {
  sessionId: string
  path: string
  cwd?: string
  startCwd?: string
  cwds?: string[]
  aiTitle?: string
  agentName?: string
  firstPrompt?: string
  lastPrompt?: string
  gitBranch?: string
  model?: string
  permissionMode?: string
  costUsd?: number
  linesAdded?: number
  linesRemoved?: number
  prUrl?: string
  prNumber?: number
  createdAt?: string
  lastAt?: string
  updatedMs: number
  size: number
  lastRole?: string
  endedTurn: boolean
  lastText?: string
  lastActivity?: string
  edited?: string[]
  configDir?: string
}
interface Live {
  pid?: number
  sessionId: string
  cwd: string
  kind?: "interactive" | "background"
  startedAt?: number
  name?: string
  nameSource?: string
  status?: string
  state?: string
  /** what a "waiting" session waits for ("input needed", "dialog open", "sandbox request"…) */
  waitingFor?: string
  configDir?: string
  updatedAt?: number
  statusUpdatedAt?: number
}
interface Chunk {
  records: Record<string, unknown>[]
  offset: number
  skipped: number
  /** the last message's uuid: the next read checks that new lines continue from it */
  tip?: string
  /** a prompt was edited or rewound: the window must be read again */
  branched?: boolean
}

// ---------- local state ----------
const metas = new Map<ID, Meta>()
let pidLive = new Map<ID, Live>()
let bgLive = new Map<ID, Live>()
/** sessions the app runs: key = session id */
const owned = new Map<ID, { cwd: string; turnMsgId?: string; sending: boolean; host?: string; fresh?: boolean; state?: "idle" | "running" | "requires_action" }>()
/** records read when a chat opens (the newest ones) */
const WINDOW = 1500
const maps = new Map<ID, MapState>()
const offsets = new Map<ID, number>()
/** settings picked for a session the app does not run yet (they apply when it moves in) */
const picks = new Map<ID, Partial<Session>>()
const tips = new Map<ID, string | undefined>()
const loading = new Set<ID>()
let home = ""

const LS = "sd.real"
type Persist = { seen: Record<ID, number>; archived: ID[]; firstRun: number; titles?: Record<ID, string> }
function loadPersist(): Persist {
  try {
    const p = JSON.parse(localStorage.getItem(LS) ?? "null") as Persist | null
    if (p) return p
  } catch {
    /* ignore */
  }
  return { seen: {}, archived: [], firstRun: Date.now() }
}
const persist = loadPersist()
function save() {
  try {
    localStorage.setItem(LS, JSON.stringify(persist))
  } catch {
    /* storage unavailable */
  }
}

const iso = (ms?: number) => new Date(ms ?? Date.now()).toISOString()

// ---------- scope: what the dashboard shows ----------
/** git repos found in the workspaces' folders (Settings → Workspaces), with their workspace */
let workspaceRepos: { path: string; ws: string }[] = []
const expand = (p: string) => (p.startsWith("~/") ? home + p.slice(1) : p === "~" ? home : p).replace(/\/+$/, "")
/** workspace folders as [machine, absolute-or-~ path, workspace id], longest first */
function roots(): { machine?: string; path: string; ws: string }[] {
  const out: { machine?: string; path: string; ws: string }[] = []
  for (const w of getApp().settings.workspaces) {
    for (const f of w.folders ?? []) {
      const m = /^([^/~:]+):(.+)$/.exec(f)
      if (m) out.push({ machine: m[1], path: m[2].replace(/\/+$/, ""), ws: w.id })
      else if (f.trim()) out.push({ path: expand(f.trim()), ws: w.id })
    }
  }
  return out.sort((a, b) => b.path.length - a.path.length)
}
const inside = (p: string, root: string) => p === root || p.startsWith(root + "/")
/** the workspace a folder belongs to by the older folder lists (the longest matching folder wins) */
function workspaceOf(cwd: string, machine?: string) {
  return roots().find((r) => (r.machine ?? "") === (machine ?? "") && inside(cwd, r.path))?.ws
}

/**
 * Which repository a session's folder is: its remote ("github.com/acme/api") once git has been
 * read, else its main checkout, else the folder. Sessions of one repository share a column, in
 * whatever checkout, worktree, machine or cloud they run.
 */
function repoOf(cwd: string, machine?: string): { key: string; root: string; name: string } {
  if (machine === CLOUD) {
    const gh = /^[^/\s]+\/[^/\s]+$/.test(cwd)
    return { key: gh ? `github.com/${cwd}`.toLowerCase() : `cloud:${cwd}`, root: cwd, name: gh ? cwd.split("/")[1] : cwd }
  }
  const g = gitByFolder.get(folderKey(machine, cwd))
  const root = g?.root ?? cwd
  if (g?.remote) return { key: g.remote, root, name: g.remoteName ?? repoName(root) }
  return { key: `${machine ? `${machine}:` : ""}path:${root}`, root, name: repoName(root) }
}

/**
 * The workspace a repository is in. The most specific claim wins: the repository picked by name,
 * then a folder that holds its checkout, then "every repo of an owner" (github.com/acme/*).
 */
function workspaceOfRepo(key: string, root: string, machine?: string) {
  const list = getApp().settings.workspaces
  for (const w of list) if (w.repos?.some((r) => r.key === key)) return w.id
  const byFolder = machine === CLOUD ? undefined : workspaceOf(root, machine)
  if (byFolder) return byFolder
  for (const w of list) if (w.repos?.some((r) => r.key.endsWith("/*") && key.startsWith(r.key.slice(0, -1)))) return w.id
  return undefined
}

/** The folder that holds all of a workspace's checkouts here (their longest common parent). */
function commonParent(paths: string[]) {
  if (paths.length < 2) return paths.length === 1 ? paths[0].slice(0, paths[0].lastIndexOf("/")) : undefined
  const parts = paths.map((p) => p.split("/"))
  const out: string[] = []
  for (let i = 0; i < parts[0].length; i++) {
    const seg = parts[0][i]
    if (parts.every((p) => p[i] === seg)) out.push(seg)
    else break
  }
  const dir = out.join("/")
  return dir && dir !== home && dir.length > home.length ? dir : undefined
}

/**
 * Each workspace's main folder: set by you, or the folder that holds its repos (Work's four repos
 * in ~/work/acme → ~/work/acme), or a folder-based workspace's only folder.
 */
export function workspaceHomes(): { ws: string; name: string; path: string }[] {
  const out: { ws: string; name: string; path: string }[] = []
  for (const w of getApp().settings.workspaces) {
    let path = w.home ? expand(w.home) : undefined
    if (!path) {
      const paths = (w.repos ?? []).filter((r) => r.path).map((r) => expand(r.path!))
      path = paths.length ? commonParent(paths) : (w.folders ?? []).length === 1 && !/^[^/~:]+:/.test(w.folders![0]) ? expand(w.folders![0]) : undefined
    }
    if (path && path !== home) out.push({ ws: w.id, name: w.name, path })
  }
  return out
}
const homeOf = (cwd: string) => workspaceHomes().find((h) => h.path === cwd)

/** Folders whose git state is wanted soon (one read for all of them, next tick). */
const gitWanted = new Set<string>()
let gitTimer: ReturnType<typeof setTimeout> | undefined
function askGit(path: string) {
  gitWanted.add(path)
  gitTimer ??= setTimeout(() => {
    const paths = [...gitWanted]
    gitWanted.clear()
    gitTimer = undefined
    void readGit(paths)
  }, 50)
}

/**
 * Where a session sits, decided by where it was started, not by the folder it happens to be in
 * now: an agent cds around (~, ~/work/acme, a fresh worktree) and its card must not jump.
 * - started in a workspace's main folder → that main folder;
 * - started in a repo (or one of its worktrees) → that repo's column;
 * - started in a plain folder (~, ~/work/acme/.wt): the workspace whose folders it worked in most
 *   → that workspace's main folder (an agent for all its repos); none → by the folder it is in.
 */
function placeSession(s: Session, prev?: Session): ID {
  if (s.machine) return `repo:${repoOf(s.cwd, s.machine).key}`
  const start = s.startCwd ?? s.cwd
  const exact = homeOf(start)
  if (exact) return `home:${exact.ws}`
  const startGit = gitByFolder.get(folderKey(undefined, start))
  const homes = workspaceHomes()
  const inHome = homes.find((h) => inside(start, h.path))
  // not read yet: ask git now, and until it answers keep the session where it was
  if (!startGit && start !== home) {
    askGit(start)
    if (prev?.repoId) return prev.repoId
  }
  const startIsRepo = start !== home && (startGit ? startGit.isRepo : true)
  if (startIsRepo) return `repo:${repoOf(start).key}`
  if (inHome) return `home:${inHome.ws}`
  // a plain folder: count the workspaces it worked in
  const votes = new Map<string, number>()
  for (const c of new Set([...(s.cwds ?? []), s.cwd])) {
    const ws = homes.find((h) => inside(c, h.path))?.ws ?? workspaceOfRepo(repoOf(c).key, repoOf(c).root)
    if (ws) votes.set(ws, (votes.get(ws) ?? 0) + 1)
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (best && homes.some((h) => h.ws === best)) return `home:${best}`
  return `repo:${repoOf(s.cwd).key}`
}

/** Sessions the dashboard keeps: any git repository's (a plain folder like ~ stays out). */
function inScope(cwd: string, meta?: Meta) {
  if (cwd === home) return false
  // a repo by the transcript (it had a branch) or by git now; either is enough, so a folder that
  // was shown never disappears when git is read (a deleted folder still has its sessions)
  return !!meta?.gitBranch || !!gitByFolder.get(folderKey(undefined, cwd))?.isRepo
}

async function loadWorkspace() {
  const list = getApp().settings.workspaces
  try {
    const found = await Promise.all(list.map(async (w) => (await invoke<string[]>("workspace_repos", { roots: (w.folders ?? []).filter((f) => !/^[^/~:]+:/.test(f)) })).map((path) => ({ path, ws: w.id }))))
    // repos picked by name, with a checkout here: shown even with no session
    const picked = list.flatMap((w) => (w.repos ?? []).filter((r) => r.path).map((r) => ({ path: expand(r.path!), ws: w.id })))
    workspaceRepos = [...found.flat(), ...picked]
  } catch (e) {
    console.warn("workspace_repos", e)
    workspaceRepos = []
  }
  void readGit(workspaceRepos.map((r) => r.path))
  sync()
}

/** One workspace per folder you keep repos in: ~/work/acme → "Work", ~/games → "Games". */
export function workspacesFromFolders(sugg: { path: string }[]): Workspace[] {
  const first = (p: string) => p.replace(/^~\//, "").split("/")[0]
  const name = (p: string) => {
    const shared = sugg.filter((f) => first(f.path) === first(p)).length > 1
    const b = shared ? (p.split("/").filter(Boolean).pop() ?? p) : first(p)
    return b.charAt(0).toUpperCase() + b.slice(1)
  }
  return sugg.map((f) => ({ id: name(f.path).toLowerCase().replace(/[^a-z0-9]+/g, "-") || "ws", name: name(f.path), folders: [f.path] }))
}

/**
 * Workspaces live in ~/.config/session-dashboard/workspaces.json, so every build of the app sees
 * the same ones. The first run makes them from your folders and shows the busiest.
 */
async function loadWorkspacesFile() {
  type File = { workspaces: Workspace[]; active?: string }
  let f: File | null = null
  try {
    f = await invoke<File | null>("prefs_read", { name: "workspaces" })
  } catch (e) {
    console.warn("prefs_read", e)
  }
  const cur = getApp().settings
  if (f?.workspaces?.length) {
    const active = f.active !== undefined && (f.active === "" || f.workspaces.some((w) => w.id === f!.active)) ? f.active : f.workspaces[0].id
    setApp((s) => ({ settings: { ...s.settings, workspaces: f!.workspaces, workspace: active } }))
  } else if (!cur.workspaces.length) {
    const made = workspacesFromFolders(suggestedFolders().slice(0, 6))
    if (made.length) setApp((s) => ({ settings: { ...s.settings, workspaces: made, workspace: made[0].id } }))
  }
  // from now on every change is written back
  let last = ""
  const write = () => {
    const s = getApp().settings
    const next = JSON.stringify({ workspaces: s.workspaces, active: s.workspace })
    if (next === last) return
    last = next
    invoke("prefs_write", { name: "workspaces", value: JSON.parse(next) }).catch((e) => console.warn("prefs_write", e))
  }
  write()
  useApp.subscribe(write)
}

/** Parent folders of the folders Claude Code was used in: workspace suggestions (~/work/acme). */
export function suggestedFolders(): { path: string; count: number }[] {
  const by = new Map<string, number>()
  for (const m of metas.values()) {
    if (!m.cwd || isTmp(m.cwd) || m.cwd === home) continue
    // a repo's parent folder; a session in a worktree counts for the repo's parent
    const repo = m.cwd.replace(/\/\.claude\/worktrees\/.*$/, "")
    const parent = repo.slice(0, repo.lastIndexOf("/"))
    if (!parent || parent === home || parent.length < home.length || /\/\./.test(parent.slice(home.length))) continue
    by.set(parent, (by.get(parent) ?? 0) + 1)
  }
  const tilde = (p: string) => (home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p)
  return [...by.entries()].sort((a, b) => b[1] - a[1]).map(([p, count]) => ({ path: tilde(p), count }))
}
const isTmp = (p: string) => p.startsWith("/tmp/") || p.includes("/scratchpad/")

function repoIdFor(cwd: string, machine?: string) {
  return machine ? `repo:${machine}:${cwd}` : `repo:${cwd}`
}
function repoName(cwd: string) {
  if (cwd === home) return "~"
  return cwd.split("/").filter(Boolean).pop() ?? cwd
}

function mapMode(m?: string): PermissionMode {
  if (!m || m === "manual" || m === "default") return "default"
  return (["acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const).includes(m as never) ? (m as PermissionMode) : "default"
}

function titleOf(meta?: Meta, live?: Live) {
  const t = meta?.aiTitle || meta?.agentName || (live?.nameSource && live.nameSource !== "derived" ? live.name : undefined) || meta?.firstPrompt?.split("\n")[0]
  return (t || live?.name || "Session").slice(0, 120)
}

// ---------- building store records ----------
function liveFor(id: ID): Live | undefined {
  return pidLive.get(id) ?? bgLive.get(id)
}

/** How a reply reaches this terminal session without stopping it ("Konsole", "tmux", …), or null. */
export async function realInjectWay(id: ID): Promise<string | null> {
  const s = getApp().sessions[id]
  const pid = liveFor(id)?.pid
  if (!s || s.machine || !pid) return null
  return invoke<string | null>("claude_inject_check", { pid }).catch(() => null)
}

/** Type a reply into the terminal the session runs in; it keeps running there. */
export async function realInject(id: ID, text: string): Promise<void> {
  const pid = liveFor(id)?.pid
  if (!pid) throw new Error("its process is not visible")
  await invoke<string>("claude_inject", { pid, text })
  setStatusLocal(id, "working", { activity: "Your reply, typed into its terminal", waitingFor: undefined })
}

function liveStatus(l: Live, meta?: Meta, prev?: Session): { status: SessionStatus; waiting?: Session["waitingFor"] } {
  const s = (l.status ?? l.state ?? "").toLowerCase()
  // a slash-command dialog you opened in that terminal (/model, /config): you are already there, it
  // does not need you (counting it made "N need you" jump up and down)
  if (/dialog/i.test(l.waitingFor ?? "")) return { status: prev && prev.status !== "waiting_input" && prev.status !== "working" ? prev.status : "idle" }
  if (s === "blocked" || s.includes("wait") || s.includes("input")) return { status: "waiting_input", waiting: { kind: "input", summary: "Waiting for you" } }
  if (s === "busy" || s === "running" || s === "working") return { status: "working" }
  // idle: finished since you last looked?
  const seen = persist.seen[l.sessionId] ?? persist.firstRun
  const changed = (l.statusUpdatedAt ?? meta?.updatedMs ?? 0) > seen
  // finished and not looked at stays so until you look (the transcript scan may lag a poll behind)
  if (prev?.status === "done_unseen" && changed) return { status: "done_unseen" }
  if (prev?.status === "working" || (changed && meta?.endedTurn)) return { status: changed ? "done_unseen" : "idle" }
  return { status: "idle" }
}

/** A session on a VPS or in the cloud (ext.ts), or one the app runs there. */
function buildExt(e: ExtSession, prev?: Session): Session {
  const own = owned.get(e.id)
  const cloud = e.machine === CLOUD
  const repoId = repoIdFor(e.cwd, e.machine)
  let status = e.status
  let waitingFor = e.waitingFor
  if (own && prev) {
    status = prev.status
    waitingFor = prev.waitingFor
  } else if (status === "idle" && e.live) {
    const seen = persist.seen[e.id] ?? persist.firstRun
    if (e.updatedMs > seen && prev?.status === "working") status = "done_unseen"
    else if (prev?.status === "done_unseen" && e.updatedMs > seen) status = "done_unseen"
  }
  return {
    id: e.id,
    provider: "claude-code",
    providerSessionIds: [e.id],
    role: "standard",
    title: persist.titles?.[e.id] ?? e.title,
    titleSource: persist.titles?.[e.id] ? "custom" : "ai",
    titleLocked: prev?.titleLocked ?? false,
    firstPrompt: prev?.firstPrompt ?? "",
    repoId,
    worktreeId: `${repoId}::${e.cwd}`,
    cwd: e.cwd,
    additionalDirs: [],
    machine: e.machine,
    url: e.url,
    control: own ? "owned" : cloud ? "cloud" : e.live ? "observed" : "history",
    kind: e.kind ?? "interactive",
    status,
    statusObservedAt: prev && prev.status === status ? prev.statusObservedAt : iso(e.updatedMs),
    waitingFor,
    activity: own && prev?.activity ? prev.activity : e.activity,
    errorMessage: e.errorMessage,
    model: prev?.model ?? e.model ?? "claude-opus-5-5",
    effort: prev?.effort ?? "high",
    permissionMode: prev?.permissionMode ?? "default",
    usage: prev?.usage ?? { contextPct: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    diff: prev?.diff ?? { filesChanged: 0, linesAdded: 0, linesRemoved: 0, unpushed: 0 },
    backgroundTasks: 0,
    handle: e.id.slice(0, 8),
    createdAt: iso(e.createdMs ?? e.updatedMs),
    updatedAt: iso(e.updatedMs),
    lastViewedAt: persist.seen[e.id] ? iso(persist.seen[e.id]) : undefined,
    pinned: false,
    archived: persist.archived.includes(e.id),
  }
}

function buildSession(id: ID, prev?: Session): Session | null {
  const ext = metas.has(id) ? undefined : extSession(id)
  if (ext) return buildExt(ext, prev)
  const remoteOwn = owned.get(id)?.host
  if (remoteOwn && prev) return prev
  const meta = metas.get(id)
  const live = liveFor(id)
  const own = owned.get(id)
  // where it works now: the transcript knows (a session may cd into a repo); a live process
  // without transcript yet only knows where it started
  const cwd = meta?.cwd ?? live?.cwd ?? own?.cwd
  const startCwd = meta?.startCwd ?? live?.cwd ?? own?.cwd
  if (!cwd) return null
  const repoId = repoIdFor(cwd)
  const control: Session["control"] = own ? "owned" : live ? "observed" : "history"
  let status: SessionStatus = "stopped"
  let waitingFor: Session["waitingFor"]
  if (own && prev) {
    // owned sessions: the event stream decides
    status = prev.status
    waitingFor = prev.waitingFor
  } else if (live) {
    const r = liveStatus(live, meta, prev)
    status = r.status
    waitingFor = r.waiting
    // the hook knows more (what it waits for, what it runs) when it spoke after the pid file
    const h = hookState.get(id)
    if (h && h.at >= (live.statusUpdatedAt ?? 0) - 1500) {
      // the terminal shows a prompt (pid file "blocked"): a hook's "working" can't be right
      const blocked = r.status === "waiting_input"
      if (h.status === "waiting_permission" || h.status === "waiting_input" || (h.status === "working" && !blocked) || h.status === "error") {
        status = h.status
        waitingFor = h.waitingFor
      }
    }
  }
  const updated = Math.max(meta?.updatedMs ?? 0, live?.statusUpdatedAt ?? 0)
  const working = status === "working" || status === "starting"
  return {
    id,
    provider: "claude-code",
    providerSessionIds: [id],
    role: "standard",
    // a name you gave it (kept across restarts) wins over Claude's own title
    title: persist.titles?.[id] ?? titleOf(meta, live),
    titleSource: persist.titles?.[id] ? "custom" : "ai",
    titleLocked: prev?.titleLocked ?? false,
    firstPrompt: meta?.firstPrompt ?? prev?.firstPrompt ?? "",
    repoId,
    worktreeId: `${repoId}::${cwd}`,
    cwd,
    startCwd,
    cwds: meta?.cwds,
    additionalDirs: prev?.additionalDirs ?? [],
    control,
    kind: live?.kind === "background" ? "background" : "interactive",
    status,
    statusObservedAt: prev && prev.status === status ? prev.statusObservedAt : iso(live?.statusUpdatedAt ?? updated),
    waitingFor,
    // where it is: what it does now, or the last thing it said
    activity: own && prev?.activity && working ? prev.activity : working ? (meta?.lastActivity ?? "Working") : (meta?.lastText ?? meta?.lastPrompt),
    lastPrompt: meta?.lastPrompt,
    lastText: meta?.lastText,
    editedPaths: meta?.edited && prev?.editedPaths && sameList(prev.editedPaths, meta.edited) ? prev.editedPaths : meta?.edited,
    configDir: meta?.configDir ?? live?.configDir ?? prev?.configDir,
    // the app's own session: what you picked here wins; a terminal's: what the transcript says now
    // (Shift+Tab or /model there shows up here)
    model: own ? (prev?.model ?? meta?.model ?? "claude-opus-5-5") : (meta?.model ?? prev?.model ?? "claude-opus-5-5"),
    effort: prev?.effort ?? "high",
    permissionMode: own ? (prev?.permissionMode ?? mapMode(meta?.permissionMode)) : meta?.permissionMode ? mapMode(meta.permissionMode) : (prev?.permissionMode ?? "default"),
    fastMode: prev?.fastMode,
    ultracode: prev?.ultracode,
    outputStyle: prev?.outputStyle,
    usage: { contextPct: prev?.usage.contextPct ?? 0, inputTokens: 0, outputTokens: 0, costUsd: meta?.costUsd ?? prev?.usage.costUsd ?? 0 },
    diff: { filesChanged: prev?.diff.filesChanged ?? 0, linesAdded: meta?.linesAdded ?? 0, linesRemoved: meta?.linesRemoved ?? 0, unpushed: 0 },
    backgroundTasks: 0,
    handle: live?.name ?? id.slice(0, 8),
    createdAt: meta?.createdAt ?? iso(live?.startedAt),
    updatedAt: iso(updated),
    lastViewedAt: persist.seen[id] ? iso(persist.seen[id]) : undefined,
    pinned: false,
    archived: persist.archived.includes(id),
  }
}

function buildRepo(id: ID, name: string, cwd: string, machine?: string, branch?: string): Repo {
  return (
    {
      id,
      name,
      rootPath: cwd,
      machine,
      defaultBranch: branch ?? "main",
      language: "",
      worktrees: [
        {
          id: `${id}::${cwd}`,
          repoId: id,
          path: cwd,
          branch: branch ?? "",
          isMain: true,
          git: { state: "clean", filesChanged: 0, linesAdded: 0, linesRemoved: 0, untracked: 0, ahead: 0, behind: 0, unpushed: 0, observedAt: iso() },
        },
      ],
      sharedRuleFiles: [],
      pinned: false,
      addedAt: iso(),
    }
  )
}

/** Same content: keep the old object, so nothing that shows it renders again. */
function same<T extends object>(a: T, b: T) {
  if (a === b) return true
  const ka = Object.keys(a) as (keyof T)[]
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    const x = a[k]
    const y = b[k]
    if (x === y) continue
    if (x && y && typeof x === "object" && typeof y === "object" && JSON.stringify(x) === JSON.stringify(y)) continue
    return false
  }
  return true
}
const sameList = (a: readonly string[] | undefined, b: readonly string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i])

/** Rebuild sessions and projects from what was discovered; one store update, none when nothing changed. */
function sync() {
  const st = getApp()
  const ids = new Set<ID>([...metas.keys(), ...pidLive.keys(), ...bgLive.keys(), ...owned.keys()])
  for (const m of extByMachine.values()) for (const id of m.keys()) ids.add(id)
  const sessions: Record<ID, Session> = {}
  let changedStruct = false
  let changedStatus = false
  let changedAny = false
  for (const id of ids) {
    const prev = st.sessions[id]
    const meta = metas.get(id)
    if (!liveFor(id) && !owned.has(id) && meta?.cwd && isTmp(meta.cwd)) continue
    let s = buildSession(id, prev)
    if (!s) continue
    const picked = owned.has(id) ? undefined : picks.get(id)
    if (picked) s = { ...s, ...picked }
    // a prompt the terminal shows that can be answered here too
    const offer = firstOffer(id)
    if (offer && !owned.has(id)) {
      const live = liveFor(id)
      if (live && (live.statusUpdatedAt ?? 0) > offer.at + 1500 && !/block|wait/.test((live.status ?? live.state ?? "").toLowerCase())) sessionMovedOn(id, live.statusUpdatedAt ?? Date.now(), undefined, true)
      else s = { ...s, status: offer.status, waitingFor: offer.waiting, statusObservedAt: prev?.status === offer.status ? prev.statusObservedAt : iso(offer.at) }
    }
    // a workspace's main folder: its sessions sit above the workspace's repos
    const repoId = placeSession(s, prev)
    const hw = repoId.startsWith("home:")
    // not a repo (a plain folder like ~): not shown, unless the app runs it
    if (!hw && !s.machine && !owned.has(id) && !inScope(s.cwd, meta)) continue
    // one column per repository, whatever checkout, worktree or machine it runs in

    if (s.repoId !== repoId) s = { ...s, repoId, worktreeId: `${repoId}::${s.cwd}` }
    sessions[id] = prev && same(prev, s) ? prev : s
    if (sessions[id] !== prev) changedAny = true
    if (!prev || prev.control !== s.control || prev.archived !== s.archived || prev.repoId !== s.repoId) changedStruct = true
    if (!prev || prev.status !== s.status) changedStatus = true
  }
  if (Object.keys(st.sessions).some((id) => !sessions[id])) changedStruct = true
  // projects: every folder with a session, in a stable order (new ones at the end, most recent first on the first sync)
  const repos: Record<ID, Repo> = { ...st.repos }
  // projects of folders now out of scope go (folders picked on New session stay)
  // every repo of a workspace is a project, sessions or not
  const wsIds = new Set<ID>()
  for (const w of getApp().settings.workspaces) for (const r of w.repos ?? []) if (!r.key.endsWith("/*")) wsIds.add(`repo:${r.key}`)
  for (const { path } of workspaceRepos) {
    const rk = repoOf(path)
    const id = `repo:${rk.key}`
    wsIds.add(id)
    if (!repos[id]) repos[id] = buildRepo(id, rk.name, rk.root)
  }
  for (const w of getApp().settings.workspaces) {
    for (const r of w.repos ?? []) {
      if (r.key.endsWith("/*")) continue
      const id = `repo:${r.key}`
      if (!repos[id]) repos[id] = buildRepo(id, r.name, r.path ? expand(r.path) : r.key, r.path ? undefined : CLOUD)
    }
  }
  // each workspace's main folder: a project of its own (shown above the repos), sessions or not
  const homes = workspaceHomes()
  for (const h of homes) {
    const id = `home:${h.ws}`
    const want = { name: h.name, rootPath: h.path, isHome: true, workspace: h.ws, inWorkspace: true }
    const r = repos[id]
    if (!r) repos[id] = { ...buildRepo(id, h.name, h.path), ...want }
    else if (r.name !== h.name || r.rootPath !== h.path) repos[id] = { ...r, ...want }
  }
  for (const id of Object.keys(repos)) if (id.startsWith("home:") && !homes.some((h) => `home:${h.ws}` === id)) delete repos[id]
  // projects nobody uses any more go (a folder that became part of a repo, a session that ended)
  const used = new Set(Object.values(sessions).map((x) => x.repoId))
  for (const id of Object.keys(repos)) if (id.startsWith("repo:") && !used.has(id) && !wsIds.has(id)) delete repos[id]
  const order = st.repoOrder.filter((id) => repos[id])
  const byRepo: Record<ID, ID[]> = {}
  const recency = new Map<ID, number>()
  for (const s of Object.values(sessions)) {
    if (!s.repoId) continue
    if (s.repoId.startsWith("home:")) {
      ;(byRepo[s.repoId] ??= []).push(s.id)
      continue
    }
    const rk = repoOf(s.cwd, s.machine)
    const r = repos[s.repoId]
    // a checkout on this computer is the project's home (git line, new sessions start there)
    if (!r) repos[s.repoId] = buildRepo(s.repoId, rk.name, rk.root, s.machine)
    else if (r.machine && !s.machine && (r.rootPath !== rk.root || r.name !== rk.name)) repos[s.repoId] = { ...r, rootPath: rk.root, machine: undefined, name: rk.name }
    else if (r.name !== rk.name && !r.machine === !s.machine) repos[s.repoId] = { ...r, name: rk.name }
    ;(byRepo[s.repoId] ??= []).push(s.id)
    recency.set(s.repoId, Math.max(recency.get(s.repoId) ?? 0, Date.parse(s.updatedAt)))
  }
  // "owner/name" as GitHub spells it, for display (keys are lowercase)
  for (const [id, r] of Object.entries(repos)) {
    if (r.isHome) continue
    const slug = r.machine === CLOUD ? r.rootPath : gitByFolder.get(folderKey(r.machine, r.rootPath))?.slug
    if (slug && r.slug !== slug) repos[id] = { ...r, slug }
  }
  // workspace membership, by repository
  for (const [id, r] of Object.entries(repos)) {
    if (r.isHome) continue
    const key = id.startsWith("repo:") ? id.slice(5) : id
    const inWs = wsIds.has(id)
    const ws = workspaceOfRepo(key, r.rootPath, r.machine)
    if (!!r.inWorkspace !== inWs || r.workspace !== ws) {
      repos[id] = { ...r, inWorkspace: inWs, workspace: ws }
      changedStruct = true
    }
  }
  for (const id of Object.keys(repos)) if (repos[id].inWorkspace && !byRepo[id]) byRepo[id] = []
  const fresh = Object.keys(byRepo).filter((id) => !order.includes(id))
  if (fresh.length) {
    changedStruct = true
    fresh.sort((a, b) => (recency.get(b) ?? 0) - (recency.get(a) ?? 0))
    order.push(...fresh)
  }
  for (const id of Object.keys(repos)) if (!byRepo[id]) byRepo[id] = []
  // git as last read for each folder
  for (const [id, r] of Object.entries(repos)) {
    const g = gitByFolder.get(folderKey(r.machine === CLOUD ? undefined : r.machine, r.rootPath))
    if (g && g !== r.git) {
      repos[id] = { ...r, git: g }
      changedStruct = true
    }
  }
  if (Object.keys(st.sessions).length !== Object.keys(sessions).length) changedAny = true
  // keep what did not change: the same objects, so their subscribers stay quiet
  const reposSame = Object.keys(repos).length === Object.keys(st.repos).length && Object.entries(repos).every(([id, r]) => st.repos[id] === r || (st.repos[id] && same(st.repos[id], r)))
  const orderSame = sameList(st.repoOrder, order)
  const byRepoOut: Record<ID, ID[]> = {}
  let byRepoSame = Object.keys(byRepo).length === Object.keys(st.sessionIdsByRepo).length
  for (const [id, list] of Object.entries(byRepo)) {
    const old = st.sessionIdsByRepo[id]
    if (sameList(old, list)) byRepoOut[id] = old
    else {
      byRepoOut[id] = list
      byRepoSame = false
    }
  }
  if (!changedAny && reposSame && orderSame && byRepoSame && !changedStruct && !changedStatus) return
  setApp((s) => ({
    ...(changedAny ? { sessions } : {}),
    ...(reposSame ? {} : { repos }),
    ...(orderSame ? {} : { repoOrder: order }),
    ...(byRepoSame ? {} : { sessionIdsByRepo: byRepoOut }),
    structVersion: changedStruct ? s.structVersion + 1 : s.structVersion,
    statusVersion: changedStatus ? s.statusVersion + 1 : s.statusVersion,
  }))
}

// ---------- polling ----------
/** A session window: take on the sessions the main window runs, so their events and sends work here. */
async function attachRunning() {
  if (!POPOUT) return
  try {
    const keys = await invoke<string[]>("claude_running")
    for (const k of keys) if (!owned.has(k)) owned.set(k, { cwd: getApp().sessions[k]?.cwd ?? metas.get(k)?.cwd ?? "", sending: false })
    for (const k of [...owned.keys()]) if (!keys.includes(k)) owned.delete(k)
  } catch {
    /* ignore */
  }
}

async function pollPids() {
  void attachRunning()
  try {
    const list = await invoke<Live[]>("claude_pids")
    pidLive = new Map(list.filter((l) => l.sessionId).map((l) => [l.sessionId, l]))
  } catch (e) {
    console.warn("claude_pids", e)
  }
}
async function pollAgents() {
  try {
    const list = await invoke<Live[]>("claude_live")
    bgLive = new Map(list.filter((l) => l.kind === "background" && l.sessionId).map((l) => [l.sessionId, l]))
  } catch (e) {
    console.warn("claude_live", e)
  }
}
async function pollScan() {
  try {
    const list = await invoke<Meta[]>("claude_scan")
    for (const m of list) metas.set(m.sessionId, m)
  } catch (e) {
    console.warn("claude_scan", e)
  }
}

/** Live transcripts: append what the files gained (sessions on screen or kept mounted). */
let tailing = false
async function tailOpen() {
  if (tailing) return
  tailing = true
  try {
    await tailOnce()
  } finally {
    tailing = false
  }
}
async function tailOnce() {
  const st = getApp()
  for (const id of st.recent.slice(0, 6)) {
    const meta = metas.get(id)
    const off = offsets.get(id)
    if (!meta || off == null || loading.has(id)) continue
    if (meta.size <= off && !liveFor(id)) continue
    try {
      const chunk = await invoke<Chunk>("claude_transcript_since", { path: meta.path, offset: off, tip: tips.get(id) })
      // an edited or rewound prompt: the conversation is another branch now
      if (chunk.branched) {
        await reloadWindow(id)
        continue
      }
      offsets.set(id, chunk.offset)
      tips.set(id, chunk.tip ?? tips.get(id))
      if (chunk.records.length) patchTranscript(id, (t, m) => applyRecords(t, m, chunk.records, { running: isRunning(id) }))
    } catch {
      // rewritten file (compaction rewrite, rewind): read the window again
      await reloadWindow(id)
    }
  }
}

/** Read a transcript's window again and swap it in at once (the old one stays on screen meanwhile). */
async function reloadWindow(id: ID) {
  const meta = metas.get(id)
  if (!meta || loading.has(id)) return
  loading.add(id)
  try {
    const chunk = await invoke<Chunk>("claude_transcript", { path: meta.path, max: WINDOW })
    const m = newMapState()
    const t = applyRecords(emptyTranscript(id), m, chunk.records, { running: isRunning(id) })
    maps.set(id, m)
    offsets.set(id, chunk.offset)
    tips.set(id, chunk.tip)
    setApp((s) => ({ transcripts: { ...s.transcripts, [id]: t } }))
  } catch (e) {
    console.warn("claude_transcript", e)
  } finally {
    loading.delete(id)
  }
}

function isRunning(id: ID) {
  const s = getApp().sessions[id]
  return !!s && (s.status === "working" || s.status === "starting" || s.status === "waiting_permission" || s.status === "waiting_input")
}

function patchTranscript(id: ID, f: (t: Transcript, m: MapState) => Transcript) {
  const m = maps.get(id) ?? newMapState()
  maps.set(id, m)
  const had = getApp().transcripts[id]
  const cur = had ?? emptyTranscript(id)
  // applied once (it marks records as seen); nothing new = the same object = no store update
  const next = f(cur, m)
  if (had && next === cur) return
  setApp((s) => ({ transcripts: { ...s.transcripts, [id]: next } }))
}

/** where a session's transcript is read from */
function placeOf(id: ID): { kind: "local" } | { kind: "ssh"; host: string } | { kind: "cloud" } {
  const own = owned.get(id)
  if (own?.host) return { kind: "ssh", host: own.host }
  if (metas.has(id)) return { kind: "local" }
  const e = extSession(id)
  if (e?.machine === CLOUD) return { kind: "cloud" }
  if (e) return { kind: "ssh", host: e.machine }
  return { kind: "local" }
}
const cloudCursor = new Map<ID, string | undefined>()

function loadElsewhere(id: ID, place: { kind: "ssh"; host: string } | { kind: "cloud" }) {
  loading.add(id)
  const done = (records: Record<string, unknown>[]) => {
    maps.set(id, newMapState())
    patchTranscript(id, (t, m) => applyRecords(t, m, records, { running: isRunning(id) }))
  }
  const p =
    place.kind === "cloud"
      ? cloudTranscript(id).then((r) => {
          cloudCursor.set(id, r.cursor)
          done(r.entries)
          noteCloudActivity(id, r.entries)
        })
      : remoteTranscript(place.host, id).then((c) => {
          offsets.set(id, c.offset)
          done(c.records)
        })
  p.catch((e) => {
    patchTranscript(id, (t) => t)
    noticeError(id, `Could not read this session's transcript: ${String(e)}`, false)
  }).finally(() => loading.delete(id))
}

/**
 * What a cloud session does right now, from its newest entries: a tool call with no result yet is
 * running ("Running ffmpeg …"); a final answer means it is done. The cloud list says the same a
 * poll later; this shows it as soon as the transcript has it.
 */
function noteCloudActivity(id: ID, entries: Record<string, unknown>[]) {
  const done = new Set<string>()
  let pending: { name: string; input: Record<string, unknown> } | undefined
  let lastWasAnswer = false
  for (const e of entries) {
    const msg = e.message as { content?: unknown } | undefined
    const content = Array.isArray(msg?.content) ? (msg!.content as { type?: string; id?: string; tool_use_id?: string; name?: string; input?: Record<string, unknown> }[]) : []
    for (const b of content) {
      if (b.type === "tool_result" && b.tool_use_id) done.add(b.tool_use_id)
    }
    if (e.type === "assistant") {
      const uses = content.filter((b) => b.type === "tool_use" && b.id && !done.has(b.id))
      if (uses.length) {
        const u = uses[uses.length - 1]
        pending = { name: u.name ?? "tool", input: u.input ?? {} }
        lastWasAnswer = false
      } else if (content.some((b) => b.type === "text")) lastWasAnswer = true
    }
  }
  const ext = extByMachine.get(CLOUD)?.get(id)
  if (!ext) return
  if (pending && !lastWasAnswer) {
    ext.status = "working"
    ext.activity = activityOf(pending.name, pending.input)
  } else if (lastWasAnswer && ext.status === "working") {
    ext.activity = undefined
  }
  requestSync()
}

/** Open VPS and cloud chats: read what was added (slower than local files: each read is a round trip). */
let tailingElsewhere = false
async function tailElsewhere() {
  if (tailingElsewhere) return
  tailingElsewhere = true
  try {
    const st = getApp()
    const open = st.route.startsWith("/session/") ? st.route.slice(9) : undefined
    for (const id of st.recent.slice(0, 3)) {
      if (!st.transcripts[id] || loading.has(id) || owned.has(id)) continue
      const place = placeOf(id)
      if (place.kind === "local") continue
      // the chat on screen always; others only while they run
      if (id !== open && !isRunning(id)) continue
      try {
        if (place.kind === "cloud") {
          const r = await cloudTranscript(id, cloudCursor.get(id))
          cloudCursor.set(id, r.cursor)
          if (r.entries.length) {
            patchTranscript(id, (t, m) => applyRecords(t, m, r.entries, { running: isRunning(id) }))
            noteCloudActivity(id, r.entries)
          }
        } else {
          const off = offsets.get(id)
          if (off == null) continue
          const c = await remoteTranscriptSince(place.host, id, off)
          offsets.set(id, c.offset)
          if (c.records.length) patchTranscript(id, (t, m) => applyRecords(t, m, c.records, { running: isRunning(id) }))
        }
      } catch {
        /* the next round tries again */
      }
    }
  } finally {
    tailingElsewhere = false
  }
}

/**
 * Chats you have not had on screen lately give their transcript back (read again when opened):
 * memory stays flat however many chats you open. Owned sessions keep theirs (their stream feeds it).
 */
function pruneTranscripts() {
  const st = getApp()
  // sessions that need you stay loaded (and are read ahead): Ctrl+J opens them at once
  const needs = selectNeedsYou(st)
  for (const id of needs) ensureRealTranscript(id)
  const keep = new Set([...st.recent.slice(0, 8), ...needs])
  const drop = Object.keys(st.transcripts).filter((id) => !keep.has(id) && !owned.has(id) && !loading.has(id))
  if (!drop.length) return
  for (const id of drop) {
    maps.delete(id)
    offsets.delete(id)
    tips.delete(id)
  }
  setApp((s) => {
    const transcripts = { ...s.transcripts }
    for (const id of drop) delete transcripts[id]
    return { transcripts }
  })
}

export function ensureRealTranscript(id: ID) {
  if (getApp().transcripts[id] || loading.has(id)) return
  const place = placeOf(id)
  if (place.kind !== "local") {
    if (owned.get(id)?.fresh) patchTranscript(id, (t) => t)
    else loadElsewhere(id, place)
    return
  }
  const meta = metas.get(id)
  if (!meta) {
    // a brand-new owned session: its records arrive through the stream
    patchTranscript(id, (t) => t)
    return
  }
  loading.add(id)
  invoke<Chunk>("claude_transcript", { path: meta.path, max: WINDOW })
    .then((chunk) => {
      offsets.set(id, chunk.offset)
      tips.set(id, chunk.tip)
      // history first, then what arrived while it loaded (a message you just sent) on top of it
      const m = newMapState()
      let next = applyRecords(emptyTranscript(id), m, chunk.records, { running: isRunning(id) })
      const cur = getApp().transcripts[id]
      if (cur) {
        // already in the file: not again
        const recent = new Set(next.order.slice(-40).map((x) => next.items[x]).filter((x) => x?.type === "user_message").map((x) => (x as { text: string }).text.trim()))
        for (const iid of cur.order) {
          const it = cur.items[iid]
          if (it?.type === "user_message" && iid.startsWith("pending:") && !recent.has(it.text.trim())) next = addPendingUser(next, m, it.text, it.attachments)
        }
      }
      maps.set(id, m)
      setApp((s) => ({ transcripts: { ...s.transcripts, [id]: next } }))
    })
    .catch((e) => console.warn("claude_transcript", e))
    .finally(() => loading.delete(id))
}

export function realMarkSeen(id: ID) {
  persist.seen[id] = Date.now()
  save()
}

/**
 * Rename a session. The name is kept here; a session the app runs also takes it in Claude Code
 * itself (resume picker, `claude agents`). Empty: back to Claude's own title.
 */
export function realRename(id: ID, title: string) {
  const t = title.trim()
  persist.titles ??= {}
  if (t) persist.titles[id] = t
  else delete persist.titles[id]
  save()
  if (t && owned.has(id)) invoke("claude_control", { key: id, request: { subtype: "rename_session", title: t, source: "host" } }).catch(() => undefined)
  sync()
}

export function realArchive(ids: ID[], archived: boolean) {
  const set = new Set(persist.archived)
  for (const id of ids) {
    if (archived) set.add(id)
    else set.delete(id)
  }
  persist.archived = [...set]
  save()
}

// ---------- owned sessions ----------
interface StartOpts {
  cwd: string
  /** the prompt is already on screen (take over) */
  promptShown?: boolean
  /** an ssh host: run claude there */
  machine?: string
  prompt?: string
  resume?: string
  fork?: boolean
  /** another Claude Code config folder (account); a resumed session keeps its own */
  configDir?: string
  model?: string
  effort?: string
  permissionMode?: string
  addDirs?: string[]
  agent?: string
  appendSystemPrompt?: string
  name?: string
  worktree?: string
  fastMode?: boolean
  ultracode?: boolean
  outputStyle?: string
}

export function homeDir() {
  return home
}

/** Start (or resume) a session the app runs; returns its id at once, the process starts behind. */
export function realStart(opts: StartOpts): ID {
  // a session of another account is found (and continued) only in that account's folder
  if (opts.resume && opts.configDir === undefined) opts = { ...opts, configDir: getApp().sessions[opts.resume]?.configDir }
  const id = opts.resume && !opts.fork ? opts.resume : crypto.randomUUID()
  const host = opts.machine && opts.machine !== CLOUD ? opts.machine : undefined
  owned.set(id, { cwd: opts.cwd, sending: false, host, fresh: !opts.resume })
  if (host) {
    // shows up under the machine's project at once (the poll there confirms it)
    const map = extByMachine.get(host) ?? new Map<ID, ExtSession>()
    extByMachine.set(host, map)
    if (!map.has(id)) map.set(id, { id, machine: host, cwd: opts.cwd, title: (opts.name || opts.prompt?.split("\n")[0] || "New session").slice(0, 80), status: "starting", updatedMs: Date.now(), live: true })
  }
  const prev = getApp().sessions[id]
  setApp((s) => ({
    sessions: {
      ...s.sessions,
      [id]: {
        ...(buildSession(id, prev) as Session),
        ...(prev ? {} : { title: (opts.name || opts.prompt?.split("\n")[0] || "New session").slice(0, 80), firstPrompt: opts.prompt ?? "" }),
        control: "owned",
        status: opts.prompt ? "working" : "idle",
        statusObservedAt: iso(),
        activity: opts.prompt ? "Starting" : undefined,
        model: opts.model ?? prev?.model ?? "claude-opus-5-5",
        effort: (opts.effort as Session["effort"]) ?? prev?.effort ?? "high",
        permissionMode: mapMode(opts.permissionMode ?? prev?.permissionMode),
        fastMode: opts.fastMode ?? prev?.fastMode,
        ultracode: opts.ultracode ?? prev?.ultracode,
        outputStyle: opts.outputStyle ?? prev?.outputStyle,
      },
    },
    structVersion: s.structVersion + 1,
    statusVersion: s.statusVersion + 1,
  }))
  sync()
  if (opts.prompt && !opts.promptShown) {
    if (!getApp().transcripts[id] && metas.has(id)) ensureRealTranscript(id)
    patchTranscript(id, (t, m) => addPendingUser(t, m, opts.prompt!))
  }
  const flags = settingsOf(opts)
  const { fastMode: _f, ultracode: _u, outputStyle: _o, machine: _m, promptShown: _p, ...rest } = opts
  void _p
  void _f
  void _u
  void _o
  void _m
  invoke("claude_start", { opts: { key: id, sessionId: opts.resume ? undefined : id, ...rest, host, settings: flags ? JSON.stringify(flags) : undefined } }).catch((e) => {
    owned.delete(id)
    noticeError(id, `Could not start claude: ${String(e)}`)
  })
  return id
}

function noticeError(id: ID, text: string, setError = true) {
  patchTranscript(id, (t) => {
    const nid = `notice:${crypto.randomUUID()}`
    const turnId = t.turns.at(-1)?.id ?? `turn_start_${id}`
    return { ...t, items: { ...t.items, [nid]: { type: "notice", id: nid, turnId, at: iso(), severity: "error", text } }, order: [...t.order, nid] }
  })
  if (setError) setStatusLocal(id, "error", { errorMessage: text.slice(0, 200) })
}

function setStatusLocal(id: ID, status: SessionStatus, patch: Partial<Session> = {}) {
  setApp((s) => {
    const prev = s.sessions[id]
    if (!prev) return s
    return {
      sessions: { ...s.sessions, [id]: { ...prev, status, statusObservedAt: prev.status === status ? prev.statusObservedAt : iso(), ...patch } },
      statusVersion: s.statusVersion + 1,
    }
  })
}

export function realSend(id: ID, text: string, attachments?: string[]) {
  const s = getApp().sessions[id]
  if (!s) return
  const body = attachments?.length ? `${text}\n\n${attachments.map((a) => `[attached: ${a}]`).join("\n")}` : text
  if (s.machine === CLOUD) {
    patchTranscript(id, (t, m) => addPendingUser(t, m, body, attachments))
    setStatusLocal(id, "working", { activity: "Sending to claude.ai", waitingFor: undefined })
    cloudSend(id, body)
      .then(() => setTimeout(() => void pollCloud(), 1500))
      .catch((e) => noticeError(id, `Could not send to the cloud session: ${String(e)}`))
    return
  }
  if (!owned.has(id)) {
    // a past session (or one taken over): continue it in the app, on the machine it ran on
    realStart({ cwd: s.startCwd ?? s.cwd, resume: id, prompt: body, model: s.model, effort: s.effort, permissionMode: s.permissionMode, machine: s.machine })
    return
  }
  patchTranscript(id, (t, m) => addPendingUser(t, m, body, attachments))
  setStatusLocal(id, "working", { activity: "Thinking", waitingFor: undefined })
  invoke("claude_send", { key: id, text: body }).catch((e) => noticeError(id, String(e)))
}

/**
 * Take a session over from its terminal: stop it there (as Ctrl+C twice would), then resume it
 * in the app, with `prompt` as the next message when given.
 */
export async function realTakeOver(id: ID, prompt?: string) {
  const s = getApp().sessions[id]
  if (!s) return
  const remote = s.machine && s.machine !== CLOUD ? s.machine : undefined
  const pid = remote ? extSession(id)?.pid : liveFor(id)?.pid
  // still running somewhere we can't stop (a background session lists no process id): resuming
  // now would start a second copy beside it
  if (!pid && s.control === "observed") {
    noticeError(id, "Can't take this one over from here: its process isn't visible to the app. Stop it where it runs (Ctrl+C twice in its terminal, or `claude agents`), then press Resume.", false)
    return
  }
  if (prompt) patchTranscript(id, (t, m) => addPendingUser(t, m, prompt))
  setStatusLocal(id, "starting", { activity: "Taking it over from the terminal", waitingFor: undefined })
  try {
    if (pid) await invoke("claude_takeover", { pid, host: remote })
  } catch (e) {
    noticeError(id, `Could not close it in the terminal: ${String(e)}`)
    return
  }
  pidLive.delete(id)
  bgLive.delete(id)
  for (const o of offers.get(id) ?? []) dropOffer(o.id, false)
  // the settings picked in the prompt box while it ran in the terminal apply now
  realStart({ cwd: s.startCwd ?? s.cwd, resume: id, prompt, promptShown: true, model: s.model, effort: s.effort, permissionMode: s.permissionMode, fastMode: s.fastMode, ultracode: s.ultracode, outputStyle: s.outputStyle, machine: s.machine })
}

export function realInterrupt(id: ID) {
  if (!owned.has(id)) return
  invoke("claude_control", { key: id, request: { subtype: "interrupt" } }).catch(() => undefined)
}

/** Fast mode, Ultracode and output style as Claude Code settings (`--settings` / apply_flag_settings). */
function settingsOf(p: { fastMode?: boolean; ultracode?: boolean; outputStyle?: string }) {
  const s: Record<string, unknown> = {}
  if (p.fastMode !== undefined) s.fastMode = p.fastMode
  if (p.ultracode !== undefined) s.ultracode = p.ultracode
  if (p.outputStyle !== undefined && p.outputStyle !== "default") s.outputStyle = p.outputStyle
  return Object.keys(s).length ? s : null
}

export function realSettings(id: ID, patch: { model?: string; effort?: string; permissionMode?: PermissionMode; fastMode?: boolean; ultracode?: boolean; outputStyle?: string }) {
  if (!owned.has(id)) {
    picks.set(id, { ...picks.get(id), ...(patch as Partial<Session>) })
    return
  }
  if (patch.permissionMode) invoke("claude_control", { key: id, request: { subtype: "set_permission_mode", mode: patch.permissionMode } }).catch(() => undefined)
  if (patch.model) invoke("claude_control", { key: id, request: { subtype: "set_model", model: patch.model } }).catch(() => undefined)
  const flags: Record<string, unknown> = { ...(settingsOf({ ...patch, outputStyle: undefined }) ?? {}) }
  if (patch.outputStyle !== undefined) flags.outputStyle = patch.outputStyle
  if (patch.effort) flags.effortLevel = patch.effort
  if (Object.keys(flags).length) invoke("claude_control", { key: id, request: { subtype: "apply_flag_settings", settings: flags } }).catch(() => undefined)
}

/** Ask an owned session how full its context is (answer: a `ctx-` control_response). */
function askContext(id: ID) {
  if (owned.has(id)) invoke("claude_control", { key: id, request: { subtype: "get_context_usage" }, requestId: `ctx-${id}-${Date.now()}` }).catch(() => undefined)
}

/**
 * After signing in to MCP servers in the terminal (/mcp): ask the session for its servers and
 * reconnect each one that is not connected, so the new credentials are used without a restart.
 */
export function realMcpRefresh(id: ID) {
  if (owned.has(id)) invoke("claude_control", { key: id, request: { subtype: "mcp_status" }, requestId: `mcp-${id}-${Date.now()}` }).catch(() => undefined)
}

function onMcpStatus(key: ID, resp: { mcpServers?: { name?: string; status?: string }[] }) {
  for (const s of resp.mcpServers ?? []) {
    if (!s.name || s.status === "connected" || s.status === "disabled") continue
    invoke("claude_control", { key, request: { subtype: "mcp_reconnect", serverName: s.name } }).catch(() => undefined)
  }
}

interface Elicitation {
  subtype: "elicitation"
  mcp_server_name: string
  message: string
  mode?: "form" | "url"
  url?: string
}

/**
 * An MCP server asks for input (sign in at a URL, or fill a form). Unanswered, the session would
 * wait forever. A sign-in URL opens in the browser and is accepted; a form is declined with a note
 * in the chat (run the step in the terminal instead: /mcp).
 */
function onElicitation(key: ID, requestId: string, e: Elicitation) {
  if (e.mode === "url" && e.url) {
    void import("@tauri-apps/plugin-opener").then((o) => o.openUrl(e.url!)).catch(() => undefined)
    invoke("claude_respond", { key, requestId, response: { action: "accept" } }).catch(() => undefined)
    noticeInfo(key, `${e.mcp_server_name}: ${e.message || "sign in"} — opened in your browser`)
    return
  }
  invoke("claude_respond", { key, requestId, response: { action: "decline" } }).catch(() => undefined)
  noticeInfo(key, `${e.mcp_server_name} asked for input the app can't show yet (${e.message.slice(0, 120)}). Declined; use /mcp in the terminal for this server.`)
}

const mcpWarned = new Set<string>()

function noticeInfo(id: ID, text: string) {
  patchTranscript(id, (t, m) => applyRecords(t, m, [{ type: "system", subtype: "informational", level: "info", content: text, uuid: `note-${Date.now()}`, timestamp: new Date().toISOString() }], { running: isRunning(id) }))
}

function onContextUsage(key: ID, resp: { categories?: { name?: string; tokens?: number; kind?: string; isDeferred?: boolean }[]; totalTokens?: number; maxTokens?: number; percentage?: number }) {
  const cats = resp.categories ?? []
  const used = resp.totalTokens ?? cats.filter((c) => c.kind === "used").reduce((n, c) => n + (c.tokens ?? 0), 0)
  const max = resp.maxTokens ?? cats.filter((c) => c.kind !== "deferred" && !c.isDeferred).reduce((n, c) => n + (c.tokens ?? 0), 0)
  if (!max) return
  const pct = Math.round(resp.percentage ?? (used / max) * 100)
  const context = { used, max, categories: cats.map((c) => ({ name: c.name ?? "", tokens: c.tokens ?? 0, kind: c.kind ?? "", deferred: c.isDeferred })) }
  setApp((s) => (s.sessions[key] ? { sessions: { ...s.sessions, [key]: { ...s.sessions[key], usage: { ...s.sessions[key].usage, contextPct: pct, context } } } } : s))
}

/** Ask a session the app runs how full its context is (the details panel, after each turn). */
export function realAskContext(id: ID) {
  askContext(id)
}

export function realStop(id: ID) {
  if (owned.has(id)) invoke("claude_stop", { key: id }).catch(() => undefined)
}

// ---------- permission prompts ----------
interface CanUseTool {
  subtype: "can_use_tool"
  tool_name: string
  input: Record<string, unknown>
  description?: string
  permission_suggestions?: unknown[]
  tool_use_id?: string
}
const toolOf = new Map<ID, { key: ID; input: Record<string, unknown>; suggestions?: unknown[]; toolUseId?: string }>()

/** A permission prompt as the app shows it: permission, question (AskUserQuestion) or plan. */
function buildRequest(key: ID, requestId: string, r: CanUseTool): { req: PendingRequest; status: SessionStatus; waiting: Session["waitingFor"] } {
  const now = iso()
  let req: PendingRequest
  let waiting: Session["waitingFor"]
  let status: SessionStatus = "waiting_permission"
  if (r.tool_name === "AskUserQuestion" && Array.isArray(r.input.questions)) {
    req = { type: "question", id: requestId, sessionId: key, state: "pending", requestedAt: now, questions: r.input.questions as QuestionRequest["questions"] }
    status = "waiting_input"
    waiting = { kind: "question", summary: String((r.input.questions as { question?: string }[])[0]?.question ?? "Has a question"), requestId }
  } else if (r.tool_name === "ExitPlanMode") {
    req = {
      type: "plan",
      id: requestId,
      sessionId: key,
      state: "pending",
      requestedAt: now,
      planMarkdown: String(r.input.plan ?? ""),
      options: [
        { id: "approve-accept", name: "Yes, and auto-accept edits", kind: "allow_always" },
        { id: "approve-manual", name: "Yes, and manually approve edits", kind: "allow_always" },
        { id: "keep-planning", name: "No, keep planning", kind: "reject_once" },
      ],
    } satisfies PlanApproval
    status = "waiting_input"
    waiting = { kind: "plan", summary: "Plan ready for review", requestId }
  } else {
    const cmd = typeof r.input.command === "string" ? r.input.command : undefined
    const path = typeof r.input.file_path === "string" ? r.input.file_path : undefined
    const options: PermissionOption[] = [{ id: "allow-once", name: "Yes", kind: "allow_once" }]
    if (r.permission_suggestions?.length) options.push({ id: "allow-always", name: "Yes, and don't ask again", kind: "allow_always" })
    options.push({ id: "reject", name: "No, and tell Claude what to do differently", kind: "reject_once" })
    req = {
      type: "permission",
      id: requestId,
      sessionId: key,
      toolCallId: r.tool_use_id,
      toolName: r.tool_name,
      title: r.description ? `${r.tool_name}: ${r.description}` : r.tool_name,
      subject: cmd ? { type: "command", command: cmd, cwd: getApp().sessions[key]?.cwd ?? "" } : { type: "tool_call", path },
      options,
      state: "pending",
      requestedAt: now,
    } satisfies PermissionRequest
    waiting = { kind: "permission", summary: cmd ? `Bash: ${cmd}` : `${r.tool_name}${path ? ` ${path.split("/").pop()}` : ""}`, requestId }
  }
  return { req, status, waiting }
}

function onCanUseTool(key: ID, requestId: string, r: CanUseTool) {
  toolOf.set(requestId, { key, input: r.input, suggestions: r.permission_suggestions, toolUseId: r.tool_use_id })
  const { req, status, waiting } = buildRequest(key, requestId, r)
  setApp((s) => ({ requests: { ...s.requests, [requestId]: req } }))
  setStatusLocal(key, status, { waitingFor: waiting })
  if (r.tool_use_id) patchTranscript(key, (t, m) => markAwaiting(t, m, r.tool_use_id!, true))
}

// ---------- prompts of sessions in a terminal (the hook offers them, src-tauri hooks.rs) ----------
interface Offer {
  id: string
  sessionId: ID
  /** the subagent that asked (undefined: the main agent) */
  agentId?: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  status: SessionStatus
  waiting: Session["waitingFor"]
  at: number
}
/**
 * By session: the prompts its terminal shows now, answerable here too (the main agent's and each
 * waiting subagent's, oldest first).
 */
const offers = new Map<ID, Offer[]>()
const offerById = new Map<string, Offer>()
const firstOffer = (sessionId: ID) => offers.get(sessionId)?.[0]

function onOffer(p: { id: string; event: { session_id: string; agent_id?: string; tool_name: string; tool_input: Record<string, unknown>; permission_suggestions?: unknown[] }; at: number }) {
  const e = p.event
  const { req, status, waiting } = buildRequest(e.session_id, p.id, { subtype: "can_use_tool", tool_name: e.tool_name, input: e.tool_input ?? {}, permission_suggestions: e.permission_suggestions })
  const o: Offer = { id: p.id, sessionId: e.session_id, agentId: e.agent_id, input: e.tool_input ?? {}, suggestions: e.permission_suggestions, status, waiting, at: p.at }
  // a new prompt from the same agent: its previous one was answered in the terminal
  for (const old of offers.get(e.session_id) ?? []) if (old.agentId === o.agentId) dropOffer(old.id, true)
  offers.set(e.session_id, [...(offers.get(e.session_id) ?? []), o])
  offerById.set(p.id, o)
  setApp((s) => ({ requests: { ...s.requests, [p.id]: req }, statusVersion: s.statusVersion + 1 }))
  sync()
}

function forget(o: Offer) {
  offerById.delete(o.id)
  const rest = (offers.get(o.sessionId) ?? []).filter((x) => x.id !== o.id)
  if (rest.length) offers.set(o.sessionId, rest)
  else offers.delete(o.sessionId)
}

/** The prompt was answered (here or in the terminal) or went away: forget it. */
function dropOffer(id: string, withdraw: boolean) {
  const o = offerById.get(id)
  if (!o) return
  forget(o)
  if (withdraw) invoke("hooks_answer", { id, decision: null }).catch(() => undefined)
  setApp((s) => {
    const req = s.requests[id]
    return req && req.state === "pending" ? { requests: { ...s.requests, [id]: { ...req, state: "cancelled" } as PendingRequest }, statusVersion: s.statusVersion + 1 } : s
  })
  sync()
}

/**
 * Progress in the session means a prompt was answered elsewhere: the asking agent's own progress
 * (a hook event carries its agent id), or the terminal no longer blocked (pid file: all of them).
 */
export function sessionMovedOn(sessionId: ID, at: number, agentId?: string, all = false) {
  for (const o of offers.get(sessionId) ?? []) if ((all || o.agentId === agentId) && at > o.at + 500) dropOffer(o.id, true)
}

function answerOffer(id: string, decision: Record<string, unknown>) {
  const o = offerById.get(id)
  if (!o) return false
  invoke("hooks_answer", { id, decision }).catch((e) => console.warn("hooks_answer", e))
  setApp((s) => {
    const req = s.requests[id]
    return req ? { requests: { ...s.requests, [id]: { ...req, state: req.type === "question" ? "answered" : "selected" } as PendingRequest }, statusVersion: s.statusVersion + 1 } : s
  })
  forget(o)
  if (!offers.has(o.sessionId)) hookState.set(o.sessionId, { status: "working", activity: "Approved from the dashboard", at: Date.now() })
  sync()
  return true
}

function respond(requestId: string, response: Record<string, unknown>) {
  const t = toolOf.get(requestId)
  if (!t) return
  invoke("claude_respond", { key: t.key, requestId, response }).catch((e) => noticeError(t.key, String(e)))
  void emit("sd-answered", { requestId }).catch(() => undefined)
  settleLocal(requestId)
}

/** A request answered (here or in another window): mark it, and the session works again. */
function settleLocal(requestId: string) {
  const t = toolOf.get(requestId)
  if (!t) return
  toolOf.delete(requestId)
  setApp((s) => {
    const req = s.requests[requestId]
    return req ? { requests: { ...s.requests, [requestId]: { ...req, state: req.type === "question" ? "answered" : "selected" } as PendingRequest } } : s
  })
  if (t.toolUseId) patchTranscript(t.key, (tr, m) => markAwaiting(tr, m, t.toolUseId!, false))
  setStatusLocal(t.key, "working", { waitingFor: undefined })
}

const planAllow = new Map<ID, string[]>()
/** Bash rules (`npm test:*`) to allow for the rest of the session when this plan is approved. */
export function setPlanAllow(requestId: ID, rules: string[]) {
  if (rules.length) planAllow.set(requestId, rules)
  else planAllow.delete(requestId)
}

/** Allow once / always / deny, or a plan decision. */
export function realResolve(requestId: ID, optionId: string, feedback?: string): boolean {
  const o = offerById.get(requestId)
  if (o) {
    if (optionId === "reject" || optionId === "keep-planning") return answerOffer(requestId, { behavior: "deny", message: feedback?.trim() || (optionId === "keep-planning" ? "Keep planning." : "The user denied this.") })
    if (optionId === "allow-always") return answerOffer(requestId, { behavior: "allow", updatedPermissions: o.suggestions ?? [] })
    const extra = planAllow.get(requestId)
    planAllow.delete(requestId)
    if (extra?.length) return answerOffer(requestId, { behavior: "allow", updatedPermissions: [{ type: "addRules", rules: extra.map((r) => ({ toolName: "Bash", ruleContent: r })), behavior: "allow", destination: "session" }] })
    return answerOffer(requestId, { behavior: "allow" })
  }
  const t = toolOf.get(requestId)
  if (!t) return false
  if (optionId === "reject" || optionId === "keep-planning") {
    respond(requestId, { behavior: "deny", message: feedback?.trim() || (optionId === "keep-planning" ? "Keep planning." : "The user denied this.") })
    return true
  }
  if (optionId === "allow-always") {
    respond(requestId, { behavior: "allow", updatedInput: t.input, updatedPermissions: t.suggestions ?? [] })
    return true
  }
  // a plan approved with its checks allowed: session-only rules, gone when the session ends
  const extra = planAllow.get(requestId)
  planAllow.delete(requestId)
  const rules = (optionId === "approve-accept" || optionId === "approve-manual") && extra?.length ? [{ type: "addRules", rules: extra.map((r) => ({ toolName: "Bash", ruleContent: r })), behavior: "allow", destination: "session" }] : undefined
  respond(requestId, { behavior: "allow", updatedInput: t.input, ...(rules ? { updatedPermissions: rules } : {}) })
  if (optionId === "approve-accept" || optionId === "approve-manual") {
    const mode: PermissionMode = optionId === "approve-accept" ? "acceptEdits" : "default"
    realSettings(t.key, { permissionMode: mode })
    setApp((s) => (s.sessions[t.key] ? { sessions: { ...s.sessions, [t.key]: { ...s.sessions[t.key], permissionMode: mode } } } : s))
  }
  return true
}

export function realAnswer(requestId: ID, answers: Record<string, string | string[]>): boolean {
  const flat = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]))
  const o = offerById.get(requestId)
  if (o) return answerOffer(requestId, { behavior: "allow", updatedInput: { ...o.input, answers: flat } })
  const t = toolOf.get(requestId)
  if (!t) return false
  respond(requestId, { behavior: "allow", updatedInput: { ...t.input, answers: flat } })
  return true
}

// ---------- stream events of owned sessions ----------
type EventPayload = { key: ID; event?: Record<string, unknown> & { type?: string; subtype?: string }; exit?: { code: number | null; stderr: string } }

// Streamed text arrives a token at a time: collected per session and message, applied once per
// frame (one store update instead of dozens a second).
const deltas = new Map<string, { key: ID; msgId: string; text: string }>()
let deltaFrame = 0
function queueDelta(key: ID, msgId: string, text: string) {
  const k = `${key}\u0000${msgId}`
  const d = deltas.get(k)
  if (d) d.text += text
  else deltas.set(k, { key, msgId, text })
  deltaFrame ||= requestAnimationFrame(flushDeltas)
}
function flushDeltas() {
  deltaFrame = 0
  const all = [...deltas.values()]
  deltas.clear()
  for (const d of all) patchTranscript(d.key, (t, m) => applyTextDelta(t, m, d.msgId, d.text))
}

function onEvent({ key, event, exit }: EventPayload) {
  // whatever was streamed goes in before the next event (a finished message replaces it)
  if (deltas.size && event?.type !== "stream_event") flushDeltas()
  const own = owned.get(key)
  if (exit) {
    owned.delete(key)
    const failed = exit.code !== 0 && exit.code !== null
    patchTranscript(key, (t, m) => endTurn(t, m, failed))
    if (failed) noticeError(key, exit.stderr.split("\n").slice(-4).join("\n") || `claude exited with code ${exit.code}`)
    else setStatusLocal(key, "idle")
    sync()
    return
  }
  if (!event || !own) return
  switch (event.type) {
    case "stream_event": {
      const ev = event.event as { type?: string; message?: { id?: string }; delta?: { type?: string; text?: string }; content_block?: { type?: string } } | undefined
      // the live line says "thinking" while Claude thinks
      if (ev?.type === "content_block_start") {
        const thinking = ev.content_block?.type === "thinking"
        if (!!getApp().transcripts[key]?.thinkingNow !== thinking) patchTranscript(key, (t) => ({ ...t, thinkingNow: thinking }))
      }
      if (ev?.type === "message_start" && ev.message?.id) own.turnMsgId = ev.message.id
      else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text && own.turnMsgId) queueDelta(key, own.turnMsgId, ev.delta.text)
      break
    }
    case "assistant":
    case "user": {
      patchTranscript(key, (t, m) => applyRecords(t, m, [event], { running: true }))
      const content = (event.message as { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] } | undefined)?.content
      const tool = Array.isArray(content) ? content.find((c) => c.type === "tool_use") : undefined
      if (tool) setStatusLocal(key, "working", { activity: activityOf(tool.name ?? "tool", tool.input ?? {}) })
      break
    }
    case "control_request": {
      const r = event.request as CanUseTool | undefined
      if (r?.subtype === "can_use_tool") onCanUseTool(key, String(event.request_id), r)
      else if ((r as { subtype?: string } | undefined)?.subtype === "elicitation") onElicitation(key, String(event.request_id), event.request as Elicitation)
      break
    }
    case "system": {
      // exact state (CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS): a turn's result can come while
      // background subagents or shells still work; "idle" is when it is really done
      // the commands that need Claude Code's own terminal UI, as this claude reports them
      if (event.subtype === "init") {
        void import("@/features/terminal/slash").then((m) => m.setTerminalCommands(event.terminal_slash_commands as string[] | undefined))
        // MCP servers that did not connect: said once per server, with the way to fix it
        const servers = (event.mcp_servers as { name?: string; status?: string }[] | undefined) ?? []
        const failed = servers.filter((x) => x.name && (x.status === "failed" || x.status === "needs-auth"))
        for (const x of failed) {
          const k = `${key}:${x.name}:${x.status}`
          if (mcpWarned.has(k)) continue
          mcpWarned.add(k)
          noticeInfo(key, `MCP server ${x.name} ${x.status === "needs-auth" ? "needs you to sign in" : "did not connect"}. Run /mcp to ${x.status === "needs-auth" ? "sign in" : "see why and reconnect"}.`)
        }
      }
      // an API error Claude Code is retrying: say when it tries again instead of looking stuck
      if (event.subtype === "api_retry") {
        const ms = typeof event.retry_delay_ms === "number" ? event.retry_delay_ms : 0
        const attempt = typeof event.attempt === "number" ? event.attempt : undefined
        const why = typeof event.error === "string" ? event.error.replace(/_/g, " ") : typeof event.error_status === "number" ? `HTTP ${event.error_status}` : "API error"
        setStatusLocal(key, "working", { activity: `${why[0].toUpperCase()}${why.slice(1)}: retrying${ms ? ` in ${Math.round(ms / 1000)} s` : ""}${attempt ? ` (attempt ${attempt})` : ""}` })
      }
      if (event.subtype === "session_state_changed") {
        const state = event.state as "idle" | "running" | "requires_action" | undefined
        const was = own.state
        own.state = state
        const cur = getApp().sessions[key]?.status
        if (state === "running" && cur !== "working" && cur !== "waiting_permission" && cur !== "waiting_input") setStatusLocal(key, "working")
        else if (state === "idle" && was === "running" && (cur === "working" || cur === "starting")) {
          const onScreen = getApp().route === `/session/${key}`
          setStatusLocal(key, onScreen ? "idle" : "done_unseen", { waitingFor: undefined, activity: undefined })
        }
      }
      break
    }
    case "result": {
      const failed = event.subtype !== "success" && event.is_error === true
      patchTranscript(key, (t, m) => endTurn(t, m, failed))
      const onScreen = getApp().route === `/session/${key}`
      // total_cost_usd is already this process's running total (stream-json): take it, don't add it
      const cost = typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined
      if (cost !== undefined)
        setApp((s) => {
          const prev = s.sessions[key]
          if (!prev || prev.usage.costUsd === cost) return s
          return { sessions: { ...s.sessions, [key]: { ...prev, usage: { ...prev.usage, costUsd: cost } } } }
        })
      // background work still running (state events say "running"): it is not done yet
      // a failed turn says why (a usage limit: "You've hit your limit · resets 4pm")
      const why = failed && typeof event.result === "string" ? { errorMessage: event.result.slice(0, 200) } : {}
      if (failed || own.state !== "running") setStatusLocal(key, failed ? "error" : onScreen ? "idle" : "done_unseen", { waitingFor: undefined, activity: undefined, ...why })
      askContext(key)
      break
    }
    case "control_response": {
      const resp = event.response as { request_id?: string; response?: Record<string, unknown> } | undefined
      if (resp?.request_id?.startsWith("ctx-") && resp.response) onContextUsage(key, resp.response as never)
      else if (resp?.request_id?.startsWith("mcp-") && resp.response) onMcpStatus(key, resp.response as never)
      break
    }
    default:
      break
  }
}

function activityOf(name: string, input: Record<string, unknown>) {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "")
  const file = s("file_path").split("/").pop()
  if (name === "Bash") return `Running ${s("command").split("\n")[0].slice(0, 80)}`
  if (name === "Edit" || name === "MultiEdit") return `Editing ${file}`
  if (name === "Write") return `Writing ${file}`
  if (name === "Read") return `Reading ${file}`
  if (name === "Grep" || name === "Glob") return `Searching ${s("pattern").slice(0, 60)}`
  return `Using ${name}`
}

// ---------- start ----------
let started = false
export async function startReal() {
  if (!REAL || started) return
  started = true
  try {
    const info = await invoke<{ home: string }>("claude_info")
    home = info.home
  } catch {
    /* ignore */
  }
  registerSync(sync)
  if (!POPOUT) void import("./ports").then((p) => p.startPorts())
  // other accounts' folders are read too (set before the first scan)
  await invoke("claude_set_config_dirs", { dirs: getApp().settings.claudeConfigDirs ?? [] }).catch(() => undefined)
  useApp.subscribe(
    (st) => st.settings.claudeConfigDirs,
    (dirs) => void invoke("claude_set_config_dirs", { dirs: dirs ?? [] }).then(() => pollScan().then(sync)).catch(() => undefined),
  )
  await listen<EventPayload>("claude-event", (e) => onEvent(e.payload))
  // a prompt answered in another window of the app
  await listen<{ requestId: string }>("sd-answered", (e) => settleLocal(e.payload.requestId))
  await attachRunning()
  void loadCaps()
  // the installed claude's spinner words ("Drizzling…", "Cooked for 26s")
  invoke<{ present: string[]; past: string[] }>("claude_verbs")
    .then((verbs) => setApp({ verbs }))
    .catch(() => undefined)
  // background sessions (`claude agents`) join a moment later; the first paint does not wait for them
  void pollAgents().then(sync)
  await Promise.all([pollScan(), pollPids()])
  await loadWorkspacesFile()
  // where recent sessions started decides their column: read those folders before the first paint
  const recentStarts = new Set<string>()
  const dayAgo = Date.now() - 3 * 24 * 3600_000
  for (const m of metas.values()) if (m.startCwd && m.startCwd !== home && !isTmp(m.startCwd) && (m.updatedMs > dayAgo || pidLive.has(m.sessionId))) recentStarts.add(m.startCwd)
  for (const l of pidLive.values()) if (l.cwd && l.cwd !== home) recentStarts.add(l.cwd)
  // quick reads (each folder's own worktree, in parallel): which repo a folder is, in ~0.05 s each;
  // the full branch/worktree scan runs right after, in the background (pollGit(true) below)
  await readGit([...recentStarts].slice(0, 60), undefined, true)
  sync()
  setApp({ ready: true })
  // what ran last time and runs no more (after pid polling has had a few rounds)
  if (!POPOUT) setTimeout(() => void import("@/features/overview/restore").then((r) => r.startRestore()), 6000)
  // read ahead the chats that need you, once the first paint is done
  setTimeout(pruneTranscripts, 1500)
  setInterval(() => void pollPids().then(sync), 2000)
  setInterval(() => void pollScan().then(sync), 5000)
  setInterval(() => void pollAgents().then(sync), 15000)
  setInterval(() => void tailOpen(), 1500)
  setInterval(pruneTranscripts, 60_000)
  setInterval(() => void tailElsewhere(), 2500)
  // hooks (exact states, VPS sessions), machines over ssh, the cloud, git, system notifications
  if (!POPOUT) startNotify()
  onMovedOn(sessionMovedOn)
  void startHooks()
  await listen<{ id: string; event: { session_id: string; agent_id?: string; tool_name: string; tool_input: Record<string, unknown>; permission_suggestions?: unknown[] }; at: number }>("hook-permission", (e) => onOffer(e.payload))
  await listen<{ id: string; by: string }>("hook-permission-done", (e) => dropOffer(e.payload.id, false))
  void refreshHooks()
  if (POPOUT) return
  void startMachines()
  // the cloud list: every 5 s while a cloud session runs or is on screen, else every minute
  const cloudLoop = async () => {
    const st = getApp()
    const open = st.route.startsWith("/session/") ? st.sessions[st.route.slice(9)] : undefined
    const busy = Object.values(st.sessions).some((s) => s.machine === CLOUD && (s.status === "working" || s.status === "starting" || s.status === "waiting_input"))
    const hot = busy || open?.machine === CLOUD
    if (st.settings.cloud && document.visibilityState === "visible") await pollCloud()
    setTimeout(() => void cloudLoop(), hot ? 5000 : 60_000)
  }
  setTimeout(() => void cloudLoop(), 5000)
  void pollGit(true)
  setInterval(() => void pollGit(false), 20_000)
  // the workspace: its repos now, again when Settings change it, and every 2 minutes (new clones)
  void loadWorkspace()
  let ws = JSON.stringify(getApp().settings.workspaces)
  useApp.subscribe((s) => {
    const now = JSON.stringify(s.settings.workspaces)
    if (now !== ws) {
      ws = now
      void loadWorkspace()
    }
  })
  setInterval(() => void loadWorkspace(), 120_000)
}

/**
 * git of folders with a running session every 20 s (their own worktree only: a few git processes);
 * every 2 minutes the full read (branches, all worktrees) of each repo once, plus recent folders.
 */
let gitRound = 0
async function pollGit(all: boolean) {
  const st = getApp()
  const busy = new Set<string>()
  const fresh = new Set<string>()
  for (const s of Object.values(st.sessions)) {
    if (s.machine) continue
    // where it started decides its column: whether that folder is a repo is read once
    if (s.startCwd && s.startCwd !== home && !gitByFolder.has(folderKey(undefined, s.startCwd))) fresh.add(s.startCwd)
    if (s.control === "owned" || s.control === "observed") busy.add(s.cwd)
  }
  const wide = all || ++gitRound % 6 === 0
  if (!wide) {
    await readGit([...fresh], undefined, true)
    await readGit([...busy], undefined, true)
    return
  }
  // one full read per repository (any of its folders tells all its worktrees and branches); the
  // other folders of that repo get their own quick read
  const folders = [...new Set([...fresh, ...busy, ...recentFolders().slice(0, 40), ...workspaceRepos.map((r) => r.path)])]
  const byRoot = new Map<string, string>()
  const quick: string[] = []
  for (const f of folders) {
    const root = gitByFolder.get(folderKey(undefined, f))?.root ?? f
    if (byRoot.has(root)) quick.push(f)
    else byRoot.set(root, f)
  }
  await readGit([...byRoot.values()])
  await readGit(quick, undefined, true)
}

export async function refreshHooks() {
  try {
    setApp({ hooks: await invoke<{ installed: boolean }>("hooks_status", {}) })
  } catch (e) {
    setApp({ hooks: { installed: false, error: String(e) } })
  }
}

export async function setHooks(install: boolean, host?: string) {
  const r = await invoke<{ installed: boolean; error?: string }>("hooks_set", { install, host })
  if (!host) setApp({ hooks: r })
  return r
}

type RawCaps = {
  init?: {
    models?: ClaudeCaps["models"]
    available_output_styles?: string[]
    output_style?: string
    agents?: ClaudeCaps["agents"]
    commands?: { name: string; description?: string }[]
    current_permission_mode?: string
    fast_mode_disabled_reason?: string
    account?: ClaudeCaps["account"]
  }
  cloud?: ClaudeCaps["cloud"]
}

/** What the installed claude offers: models, efforts, styles, agents, commands, cloud sessions. */
async function loadCaps() {
  try {
    const raw = await invoke<RawCaps>("claude_capabilities")
    const i = raw.init ?? {}
    setApp({
      caps: {
        models: i.models ?? [],
        outputStyles: i.available_output_styles ?? ["default"],
        outputStyle: i.output_style ?? "default",
        agents: i.agents ?? [],
        commands: (i.commands ?? []).map((c) => ({ name: c.name, description: c.description ?? "" })),
        defaultMode: i.current_permission_mode,
        fastModeDisabledReason: i.fast_mode_disabled_reason,
        account: i.account,
        cloud: raw.cloud,
      },
    })
    if (getApp().settings.cloud) applyCloudList(raw.cloud as never)
  } catch (e) {
    console.warn("claude_capabilities", e)
  }
}

/** Recent project folders for "Open folder…" (newest first, temp folders left out). */
export function recentFolders(): string[] {
  const seen = new Map<string, number>()
  for (const m of metas.values()) if (m.cwd && !isTmp(m.cwd) && inScope(m.cwd, m)) seen.set(m.cwd, Math.max(seen.get(m.cwd) ?? 0, m.updatedMs))
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)
}
