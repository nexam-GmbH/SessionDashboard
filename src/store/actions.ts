import { navigate } from "@/app/nav"
import type {
  AppNotification,
  Effort,
  ID,
  PermissionMode,
  QuestionRequest,
  Session,
  SessionStatus,
} from "@/lib/model"
import { getApp, setApp, type Settings } from "./app"
import { selectNeedsYou, selectSessionOrder } from "./selectors"
import { REAL } from "@/backend/mode"
import { AWAY_MS, setAway } from "./away"
import { realRename, homeDir, realAnswer, realArchive, realInterrupt, realMarkSeen, realResolve, realSend, realSettings, realStart, realTakeOver } from "@/backend/real"

/**
 * Store actions — plain functions so components, palette commands, the mock
 * engine and (later) Tauri Channel handlers all call the same API.
 */

const nowIso = () => new Date().toISOString()

function patchSession(id: ID, patch: Partial<Session>, statusChanged = false) {
  setApp((s) => {
    const prev = s.sessions[id]
    if (!prev) return s
    return {
      sessions: { ...s.sessions, [id]: { ...prev, ...patch, updatedAt: patch.updatedAt ?? nowIso() } },
      statusVersion: statusChanged ? s.statusVersion + 1 : s.statusVersion,
    }
  })
}

export function setStatus(id: ID, status: SessionStatus, extra: Partial<Session> = {}) {
  patchSession(id, { status, statusObservedAt: nowIso(), ...extra }, true)
}

// ---------- navigation ----------
/** Sessions kept in the recent list (Ctrl+Tab order); the first few stay mounted for instant switching. */
const RECENT_MAX = 12

/** Called by the router whenever the location changes. */
export function syncRoute(pathname: string) {
  const route = pathname || "/"
  const [, kind, ref] = route.split("/")
  // leaving a session: you saw it up to now
  const left = getApp().route.startsWith("/session/") ? currentSessionId() : null
  if (left && left !== ref) {
    const s = getApp().sessions[left]
    if (s) {
      if (REAL) realMarkSeen(left)
      patchSession(left, { lastViewedAt: nowIso(), updatedAt: s.updatedAt })
    }
    setAway(left, null)
  }
  if ((kind === "session" || kind === "review") && ref && getApp().sessions[ref]) {
    setApp((s) => ({ route, screen: route, recent: [ref, ...s.recent.filter((id) => id !== ref)].slice(0, RECENT_MAX) }))
    if (kind === "session") markSeen(ref)
  } else setApp(route === "/" ? { route } : { route, screen: route })
}

/** The session the current screen belongs to (session or its review), if any. */
export function currentSessionId(): ID | null {
  const [, kind, ref] = getApp().route.split("/")
  return (kind === "session" || kind === "review") && ref ? ref : null
}

export function openOverview() {
  navigate("/")
}
export function openSession(id: ID) {
  // a session of another workspace: show that workspace
  const s = getApp()
  const ws = s.sessions[id]?.repoId ? s.repos[s.sessions[id].repoId!]?.workspace : undefined
  if (ws && s.settings.workspace && ws !== s.settings.workspace) setApp((st) => ({ settings: { ...st.settings, workspace: ws } }))
  navigate(`/session/${id}`)
}

/** Move a session from its terminal into the app (stops it there, resumes it here). */
export function takeOverSession(id: ID, prompt?: string) {
  if (REAL) void realTakeOver(id, prompt)
  else resumeSession(id)
  openSession(id)
}

/** Show a workspace ("" = all of them) and its overview. */
export function setWorkspace(id: string) {
  setApp((st) => ({ settings: { ...st.settings, workspace: id } }))
  navigate("/")
}
export function openReview(sessionId: ID) {
  navigate(`/review/${sessionId}`)
}
/** Settings open over what is on screen (a dialog, like Claude Code desktop), on a section. */
export function openSettings(section = "sessions") {
  setApp({ settingsOpen: typeof section === "string" ? section : "sessions" })
}
export function closeSettings() {
  setApp({ settingsOpen: null })
}
export function openArchive() {
  navigate("/archive")
}

/** Ctrl+Tab: the n-th most recent session other than the current one (1 = the previous one). */
export function recentSession(n = 1): ID | null {
  const cur = currentSessionId()
  const list = getApp().recent.filter((id) => id !== cur && isLive(getApp().sessions[id]))
  return list[n - 1] ?? null
}

function isLive(s: Session | undefined) {
  return !!s && !s.archived && s.control !== "history"
}

function sessionOrder(): ID[] {
  return selectSessionOrder(getApp())
}

/** Alt+Up / Alt+Down: previous or next session in list order (wraps). */
export function stepSession(dir: 1 | -1) {
  const order = sessionOrder()
  if (!order.length) return
  const cur = currentSessionId()
  const i = cur ? order.indexOf(cur) : -1
  const next = i < 0 ? (dir > 0 ? order[0] : order[order.length - 1]) : order[(i + dir + order.length) % order.length]
  openSession(next)
}

/** Ctrl+1–9: the n-th session in list order. */
export function jumpToSession(n: number) {
  const id = sessionOrder()[n - 1]
  if (id) openSession(id)
}

// ---------- session lifecycle ----------
export function markSeen(id: ID) {
  const s = getApp().sessions[id]
  if (!s) return
  // back after a while: the session screen offers what happened since
  if (s.lastViewedAt && Date.now() - Date.parse(s.lastViewedAt) >= AWAY_MS) setAway(id, s.lastViewedAt)
  if (REAL) realMarkSeen(id)
  if (s.status === "done_unseen") setStatus(id, "idle", { lastViewedAt: nowIso() })
  else patchSession(id, { lastViewedAt: nowIso(), updatedAt: s.updatedAt })
  setApp((st) => ({
    notifications: st.notifications.map((n) => (n.sessionId === id && !n.readAt ? { ...n, readAt: nowIso() } : n)),
  }))
}

/** Archive = hide, never delete (user requirement). Restorable from the Archive view. */
export function archiveSessions(ids: ID[]) {
  if (REAL) realArchive(ids, true)
  const at = nowIso()
  setApp((s) => {
    const sessions = { ...s.sessions }
    for (const id of ids) {
      const prev = sessions[id]
      if (!prev || prev.role === "main") continue
      // archiving a running session also stops it (it would otherwise keep spinning in the Archive)
      sessions[id] = {
        ...prev,
        archived: true,
        archivedAt: at,
        pinned: false,
        ...(prev.status === "working" || prev.status === "starting"
          ? { status: "idle" as const, activity: "Interrupted (archived)", lastStopReason: "cancelled" as const }
          : {}),
      }
    }
    const archivedSet = new Set(ids)
    return {
      sessions,
      structVersion: s.structVersion + 1,
      statusVersion: s.statusVersion + 1,
      recent: s.recent.filter((id) => !archivedSet.has(id)),
    }
  })
  // leaving an archived session's screen: go back to the overview
  const cur = currentSessionId()
  if (cur && ids.includes(cur)) openOverview()
}
export const archiveSession = (id: ID) => archiveSessions([id])

export function restoreSessions(ids: ID[]) {
  if (REAL) realArchive(ids, false)
  setApp((s) => {
    const sessions = { ...s.sessions }
    for (const id of ids) {
      const prev = sessions[id]
      if (prev) sessions[id] = { ...prev, archived: false, archivedAt: undefined }
    }
    return { sessions, structVersion: s.structVersion + 1, statusVersion: s.statusVersion + 1 }
  })
}
export const restoreSession = (id: ID) => restoreSessions([id])

export function pinSession(id: ID, pinned?: boolean) {
  const s = getApp().sessions[id]
  if (!s) return
  patchSession(id, { pinned: pinned ?? !s.pinned, updatedAt: s.updatedAt })
  setApp((st) => ({ structVersion: st.structVersion + 1 }))
}

export function snoozeSession(id: ID, hours: number) {
  const s = getApp().sessions[id]
  if (!s) return
  patchSession(id, { snoozedUntil: new Date(Date.now() + hours * 3600_000).toISOString(), updatedAt: s.updatedAt })
}

export function renameSession(id: ID, title: string) {
  if (REAL) {
    realRename(id, title)
    return
  }
  if (title.trim()) patchSession(id, { title: title.trim(), titleSource: "custom", titleLocked: true })
}

export function setSessionSettings(id: ID, patch: { model?: string; effort?: Effort; permissionMode?: PermissionMode; fastMode?: boolean; ultracode?: boolean; outputStyle?: string }) {
  patchSession(id, patch)
  if (REAL) realSettings(id, patch)
}

/** "+ → Add folder" while a session runs (`--add-dir`): another repo's files join its context. */
export function addSessionFolder(id: ID, repoId: ID) {
  const s = getApp()
  const path = s.repos[repoId]?.rootPath
  const sess = s.sessions[id]
  if (!path || !sess || sess.additionalDirs.includes(path)) return
  patchSession(id, { additionalDirs: [...sess.additionalDirs, path], updatedAt: sess.updatedAt })
}
export function removeSessionFolder(id: ID, repoId: ID) {
  const s = getApp()
  const path = s.repos[repoId]?.rootPath
  const sess = s.sessions[id]
  if (!path || !sess) return
  patchSession(id, { additionalDirs: sess.additionalDirs.filter((d) => d !== path), updatedAt: sess.updatedAt })
}

/**
 * Track a folder as a project (Open folder… on New session, or a session discovered in a folder
 * that wasn't tracked yet). Returns the existing project when the path is already tracked.
 */
export function addRepoFromPath(path: string, machine?: string): ID {
  const s = getApp()
  const clean = path.replace(/\/+$/, "")
  const existing = s.repoOrder.find((id) => (s.repos[id].machine ?? "") === (machine ?? "") && (s.repos[id].rootPath === clean || homeAlias(s.repos[id].rootPath) === clean))
  if (existing) return existing
  const name = clean.split("/").pop() || clean
  // a VPS folder keeps "~/…" (claude resolves it there); same id scheme as backend/real.ts
  const rootPath = machine ? clean : clean.replace(/^~(?=\/)/, REAL ? homeDir() : "/home/dev")
  const id = machine ? `repo:${machine}:${rootPath}` : `repo_${name}_${Date.now().toString(36)}`
  setApp((st) => ({
    repos: {
      ...st.repos,
      [id]: {
        id,
        name,
        rootPath,
        machine,
        defaultBranch: "main",
        language: "TypeScript",
        worktrees: [
          {
            id: `${id}::${rootPath}`,
            repoId: id,
            path: rootPath,
            branch: "main",
            isMain: true,
            git: { state: "clean", filesChanged: 0, linesAdded: 0, linesRemoved: 0, untracked: 0, ahead: 0, behind: 0, unpushed: 0, observedAt: nowIso() },
          },
        ],
        sharedRuleFiles: ["CLAUDE.md"],
        pinned: false,
        addedAt: nowIso(),
      },
    },
    repoOrder: [...st.repoOrder, id],
    repoSpecs: { ...st.repoSpecs, [id]: { name, language: "TypeScript", files: ["README.md", "CLAUDE.md", "src/index.ts"], tasks: [], symbols: [] } },
    sessionIdsByRepo: { ...st.sessionIdsByRepo, [id]: [] },
    structVersion: st.structVersion + 1,
  }))
  return id
}
const homeAlias = (p: string) => p.replace(/^\/home\/[^/]+/, "~")

/**
 * A Claude Code session started outside the app (`claude` in a terminal) shows up on its own
 * (Phase 2: `claude agents --json`, hooks and the JSONL scan). Its folder becomes a
 * project if it isn't one yet. It is "observed": you can read it and message it; approvals happen
 * in that terminal until you take it over.
 */
export function addDiscoveredSession(path: string, task: string): ID {
  const repoId = addRepoFromPath(path)
  const d = getApp().settings.defaults
  const id = createSession({ repoId, where: "main", prompt: task, title: task, model: d.model, effort: d.effort, permissionMode: "default", additionalRepoIds: [], background: false })
  setStatus(id, "working", { control: "observed", activity: "Reading the codebase", lastViewedAt: undefined })
  return id
}

export function interrupt(id: ID) {
  const s = getApp().sessions[id]
  if (!s || (s.status !== "working" && s.status !== "starting")) return
  if (REAL) return realInterrupt(id)
  setStatus(id, "idle", { activity: "Interrupted by user", lastStopReason: "cancelled" })
}

export function resumeSession(id: ID) {
  const s = getApp().sessions[id]
  if (!s) return
  if (REAL) {
    // continue it in the app (`claude --resume`); a terminal session must be stopped there first
    // claude finds a session by the folder it was started in
    realStart({ cwd: s.startCwd ?? s.cwd, resume: id, model: s.model, effort: s.effort, permissionMode: s.permissionMode, machine: s.machine })
    openSession(id)
    return
  }
  setStatus(id, "working", {
    control: "owned",
    archived: false,
    activity: "Resumed: reading transcript",
    providerSessionIds: [...s.providerSessionIds, crypto.randomUUID()],
  })
  setApp((st) => ({ structVersion: st.structVersion + 1 }))
  openSession(id)
}

/** Bring several sessions back at once (after a restart), without leaving the screen; staggered. */
export function resumeMany(ids: ID[]) {
  ids.forEach((id, i) =>
    setTimeout(() => {
      const s = getApp().sessions[id]
      if (!s) return
      if (REAL) realStart({ cwd: s.startCwd ?? s.cwd, resume: id, model: s.model, effort: s.effort, permissionMode: s.permissionMode, machine: s.machine })
      else setStatus(id, "idle", { control: "owned", archived: false })
    }, i * 400),
  )
}

let seq = 0
const newId = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`

export function forkSession(id: ID) {
  const s = getApp().sessions[id]
  if (!s) return
  if (REAL) {
    const fid = realStart({ cwd: s.startCwd ?? s.cwd, resume: id, fork: true, model: s.model, effort: s.effort, permissionMode: s.permissionMode, machine: s.machine })
    openSession(fid)
    return
  }
  const fid = newId("s")
  const fork: Session = {
    ...s,
    id: fid,
    title: `${s.title} (fork)`,
    titleSource: "custom",
    titleLocked: false,
    control: "owned",
    status: "idle",
    statusObservedAt: nowIso(),
    waitingFor: undefined,
    activity: undefined,
    providerSessionIds: [crypto.randomUUID()],
    parent: { sessionId: id, kind: "forked" },
    handle: `${s.handle}-fork`,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    archived: false,
    archivedAt: undefined,
    pinned: false,
  }
  addSession(fork)
  openSession(fid)
}

/**
 * Start over with a brief: a new session in the same folder (same worktree, so its uncommitted work
 * is there) whose first message is the brief. The old session stays as it is.
 */
export function startFresh(id: ID, brief: string) {
  const s = getApp().sessions[id]
  if (!s || !brief.trim()) return
  const name = `${s.title.replace(/ \(continued\)$/, "")} (continued)`
  if (REAL) {
    openSession(realStart({ cwd: s.cwd, machine: s.machine, prompt: brief, model: s.model, effort: s.effort, permissionMode: s.permissionMode, name }))
    return
  }
  if (!s.repoId) return
  const nid = createSession({ repoId: s.repoId, where: "main", title: name, prompt: brief, model: s.model, effort: s.effort, permissionMode: s.permissionMode, additionalRepoIds: [], background: false, parent: { sessionId: id, kind: "forked" } })
  patchSession(nid, { cwd: s.cwd, worktreeId: s.worktreeId })
  openSession(nid)
}

export function addSession(session: Session) {
  setApp((s) => ({
    sessions: { ...s.sessions, [session.id]: session },
    sessionIdsByRepo: session.repoId
      ? { ...s.sessionIdsByRepo, [session.repoId]: [...(s.sessionIdsByRepo[session.repoId] ?? []), session.id] }
      : s.sessionIdsByRepo,
    structVersion: s.structVersion + 1,
    statusVersion: s.statusVersion + 1,
  }))
}

export interface NewSessionInput {
  repoId: ID
  where: "main" | "worktree-new" | "worktree-existing"
  worktreeName?: string
  title?: string
  prompt: string
  model: string
  effort: Effort
  permissionMode: PermissionMode
  additionalRepoIds: ID[]
  background: boolean
  parent?: Session["parent"]
  fastMode?: boolean
  ultracode?: boolean
  outputStyle?: string
}

export function createSession(input: NewSessionInput): ID {
  const st = getApp()
  const repo = st.repos[input.repoId]
  if (REAL) {
    // a workspace's main folder: the agent works across all its repos (repos outside the folder
    // join with --add-dir) and is told which they are; no worktree for a folder that is not a repo
    const ws = repo.isHome ? st.settings.workspaces.find((w) => w.id === repo.workspace) : undefined
    const wsRepos = ws ? Object.values(st.repos).filter((r) => r.workspace === ws.id && !r.isHome && !r.machine) : []
    const outside = wsRepos.filter((r) => !r.rootPath.startsWith(repo.rootPath + "/")).map((r) => r.rootPath)
    const note = ws
      ? `You run in ${repo.rootPath}, the main folder of the "${ws.name}" workspace. Its repositories: ${wsRepos.map((r) => `${r.name} (${r.rootPath})`).join(", ")}. Each is its own git repository with its own branch; a change that touches several of them is made in each, from here.`
      : undefined
    return realStart({
      cwd: repo.rootPath,
      machine: repo.machine,
      prompt: input.prompt,
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      addDirs: [...input.additionalRepoIds.map((r) => st.repos[r]?.rootPath).filter(Boolean), ...outside],
      appendSystemPrompt: note,
      name: input.title,
      worktree: input.where === "worktree-new" && !repo.isHome ? input.worktreeName : undefined,
      fastMode: input.fastMode,
      ultracode: input.ultracode,
      outputStyle: input.outputStyle,
    })
  }
  const id = newId("s")
  const slug = (input.worktreeName || input.title || input.prompt || "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32)
  const cwd = input.where === "main" ? repo.rootPath : `${repo.rootPath}/.claude/worktrees/${slug}`
  const title = input.title || input.prompt.split(/[.\n]/)[0].slice(0, 64) || "New session"
  const session: Session = {
    id,
    provider: "claude-code",
    providerSessionIds: [crypto.randomUUID()],
    role: "standard",
    title,
    titleSource: input.title ? "custom" : "first-prompt",
    titleLocked: !!input.title,
    firstPrompt: input.prompt,
    repoId: input.repoId,
    worktreeId: null,
    cwd,
    additionalDirs: input.additionalRepoIds.map((r) => st.repos[r]?.rootPath).filter(Boolean),
    control: "owned",
    kind: input.background ? "background" : "interactive",
    status: "starting",
    statusObservedAt: nowIso(),
    activity: "Starting claude…",
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissionMode,
    usage: { contextPct: 2, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    diff: { filesChanged: 0, linesAdded: 0, linesRemoved: 0, unpushed: 0 },
    backgroundTasks: 0,
    parent: input.parent,
    handle: slug.split("-")[0] || "new",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastViewedAt: nowIso(),
    pinned: false,
    archived: false,
  }
  addSession(session)
  setTimeout(() => {
    if (getApp().sessions[id]?.status === "starting") setStatus(id, "working", { activity: "Reading the codebase" })
  }, 1200)
  return id
}

// ---------- requests ----------
export function resolvePermission(requestId: ID, optionId: string, feedback?: string) {
  // the desktop app: the request was answered or went away meanwhile; never fake an answer
  if (REAL) {
    if (!realResolve(requestId, optionId, feedback)) expireRequest(requestId)
    return
  }
  const s = getApp()
  const req = s.requests[requestId]
  if (!req || req.type === "question") return
  const option = req.options.find((o) => o.id === optionId)
  const rejected = option?.kind === "reject_once" || option?.kind === "reject_always"
  setApp((st) => ({
    requests: { ...st.requests, [requestId]: { ...req, state: "selected", selectedOptionId: optionId, resolvedAt: nowIso() } as typeof req },
  }))
  if (req.type === "permission" && req.subagentId) {
    const sub = getApp().subagents[req.subagentId]
    if (sub) {
      setApp((st) => ({
        subagents: { ...st.subagents, [sub.id]: { ...sub, status: rejected ? "stopped" : "running" } },
        statusVersion: st.statusVersion + 1,
      }))
    }
    return
  }
  const plan = req.type === "plan"
  const patch: Partial<Session> = {
    waitingFor: undefined,
    activity: rejected
      ? feedback
        ? `Revising: ${feedback.slice(0, 60)}`
        : "Rethinking after denial"
      : plan
        ? "Executing approved plan"
        : req.type === "permission" && req.subject?.type === "command"
          ? `Running ${req.subject.command}`
          : "Applying edit",
  }
  // plan approval options switch the permission mode; other requests keep it
  if (plan && optionId === "approve-accept") patch.permissionMode = "acceptEdits"
  if (plan && optionId === "approve-manual") patch.permissionMode = "default"
  // "Yes, allow all edits during this session" on an Edit request switches to acceptEdits
  if (!plan && req.type === "permission" && req.toolName === "Edit" && option?.kind === "allow_always") patch.permissionMode = "acceptEdits"
  setStatus(req.sessionId, "working", patch)
}

/** A prompt card that no longer has a prompt behind it: show it as gone. */
function expireRequest(requestId: ID) {
  setApp((st) => {
    const req = st.requests[requestId]
    return req && req.state === "pending" ? { requests: { ...st.requests, [requestId]: { ...req, state: "cancelled" } as typeof req }, statusVersion: st.statusVersion + 1 } : st
  })
}

export function answerQuestion(requestId: ID, answers: Record<string, string | string[]>) {
  if (REAL) {
    if (!realAnswer(requestId, answers)) expireRequest(requestId)
    return
  }
  const req = getApp().requests[requestId] as QuestionRequest | undefined
  if (!req || req.type !== "question") return
  setApp((st) => ({
    requests: { ...st.requests, [requestId]: { ...req, state: "answered" } },
  }))
  const first = Object.values(answers)[0]
  setStatus(req.sessionId, "working", {
    waitingFor: undefined,
    activity: `Continuing with: ${Array.isArray(first) ? first.join(", ") : first}`,
  })
}

// ---------- messages ----------
export function sendMessage(sessionId: ID, text: string, mode: "queue" | "now" = "queue", attachments?: string[]) {
  const s = getApp().sessions[sessionId]
  if (!s || !text.trim()) return
  setAway(sessionId, null)
  if (REAL) return realSend(sessionId, text, attachments)
  const t = getApp().transcripts[sessionId]
  if (t && (s.status === "working" || s.status === "starting") && mode === "queue") {
    setApp((st) => ({
      transcripts: {
        ...st.transcripts,
        [sessionId]: { ...t, queued: [...t.queued, { id: newId("q"), text, ...(attachments?.length ? { attachments } : {}) }] },
      },
    }))
    return
  }
  // engine/transcript module appends the user message and starts a new turn
  void import("@/mocks/transcript").then((m) => m.appendUserMessage(sessionId, text, attachments))
  setStatus(sessionId, "working", { activity: "Thinking…", waitingFor: undefined })
}

export function removeQueued(sessionId: ID, queuedId: ID) {
  const t = getApp().transcripts[sessionId]
  if (!t) return
  setApp((st) => ({
    transcripts: { ...st.transcripts, [sessionId]: { ...t, queued: t.queued.filter((q) => q.id !== queuedId) } },
  }))
}

// ---------- dialogs ----------
// Type-ahead: keys pressed between Ctrl+K and the palette input getting focus (first open loads a
// chunk and mounts a dialog) are buffered and handed to the palette, so fast typing isn't lost.
let typeAhead = ""
function captureTypeAhead(e: KeyboardEvent) {
  if ((document.activeElement as HTMLElement | null)?.hasAttribute("cmdk-input")) return
  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return
  typeAhead += e.key
  e.preventDefault()
  e.stopPropagation()
}
/** Called by the palette once its input is focused: stops buffering, returns what was typed. */
export function takePaletteTypeAhead() {
  window.removeEventListener("keydown", captureTypeAhead, true)
  const t = typeAhead
  typeAhead = ""
  return t
}
export function openPalette() {
  typeAhead = ""
  window.addEventListener("keydown", captureTypeAhead, true)
  setApp({ paletteOpen: true })
}
export function closePalette() {
  takePaletteTypeAhead()
  setApp({ paletteOpen: false })
}
/** The New session screen (Ctrl+N, +), in `repoId` or the project on screen. */
export function openNewSession(repoId?: ID) {
  navigate(repoId ? `/new/${repoId}` : "/new")
}

/** New sessions default to the repo of the session on screen. */
export function repoInFocus() {
  const id = currentSessionId()
  return (id && getApp().sessions[id]?.repoId) || undefined
}

/** Hide or show the session list (Ctrl+B, the panel button). */
export function toggleSidebar() {
  setApp((s) => ({ settings: { ...s.settings, sidebarHidden: !s.settings.sidebarHidden } }))
}

// ---------- notifications ----------
/**
 * Record a notification (coalesced per session and kind). No in-app pop-up: the top bar's
 * "need you" count and the coloured cards already say it.
 * Phase 2 sends these as OS notifications while the window is in the background.
 */
export function pushNotification(n: Omit<AppNotification, "id" | "count" | "groupKey"> & { groupKey?: string }) {
  const s = getApp()
  const sess = s.sessions[n.sessionId]
  if (sess?.repoId && s.settings.mutedRepos.includes(sess.repoId)) return
  const groupKey = n.groupKey ?? `${n.sessionId}:${n.kind}`
  setApp((st) => {
    const existing = st.notifications.find((x) => x.groupKey === groupKey && !x.readAt)
    const notifications = existing
      ? st.notifications.map((x) => (x === existing ? { ...x, count: x.count + 1, createdAt: n.createdAt, body: n.body } : x))
      : [{ ...n, id: newId("n"), count: 1, groupKey }, ...st.notifications].slice(0, 300)
    return { notifications }
  })
}
export function markNotificationRead(id: ID) {
  const at = nowIso()
  setApp((s) => ({ notifications: s.notifications.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: at } : n)) }))
}
export function markAllNotificationsRead() {
  const at = nowIso()
  setApp((s) => ({ notifications: s.notifications.map((n) => (n.readAt ? n : { ...n, readAt: at })) }))
}

// ---------- settings & engine ----------
export function patchSettings(patch: Partial<Settings>) {
  setApp((s) => ({ settings: { ...s.settings, ...patch } }))
}
export function setEngine(patch: Partial<{ running: boolean; rate: number }>) {
  setApp((s) => ({ engine: { ...s.engine, ...patch } }))
}

/** Ctrl+J and the "need you" button: the next session that needs the user, after the current one. */
export function goToNextWaiting() {
  const list = selectNeedsYou(getApp())
  if (!list.length) return
  const cur = currentSessionId()
  const i = cur ? list.indexOf(cur) : -1
  openSession(list[(i + 1) % list.length])
}
