import { navigate } from "@/app/nav"
import type {
  AppNotification,
  Effort,
  ID,
  PermissionMode,
  QuestionRequest,
  Selection,
  Session,
  SessionStatus,
} from "@/lib/model"
import { getApp, setApp, PINNED_TABS, type HistoryRange, type MapUi, type Settings, type Tab, type TabKind } from "./app"

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

// ---------- selection & tabs ----------
/**
 * Select something. Calm UI rule 7: the inspector is closed by default and opens when you select
 * something on the map, in a table or in the sidebar, but not when you simply open a session tab.
 */
export function select(sel: Selection, opts: { reveal?: boolean } = {}) {
  const st = getApp()
  const reveal = opts.reveal ?? (sel !== null && !st.activeTab.startsWith("/session/"))
  setApp({ selection: sel, ...(reveal && !st.panels.inspector ? { panels: { ...st.panels, inspector: true } } : {}) })
}

function tabFor(path: string): Tab {
  const [, kind, refId] = path.split("/") as [string, string, string | undefined]
  const known: TabKind[] = ["map", "sessions", "session", "review", "repo", "graph", "settings", "dev"]
  return { key: path, kind: (known.includes(kind as TabKind) ? kind : "map") as TabKind, refId }
}

/** Called by the router whenever the location changes. */
const PREVIEW_KINDS: TabKind[] = ["session", "repo", "review", "graph"]

export function syncActiveTab(pathname: string) {
  const key = pathname === "/" ? "/map" : pathname
  setApp((s) => {
    let tabs = s.tabs
    let mounted = s.mountedTabs
    if (!tabs.some((t) => t.key === key)) {
      const tab = tabFor(key)
      if (PREVIEW_KINDS.includes(tab.kind)) {
        // reuse the existing preview tab (calm: opening many sessions doesn't pile up tabs)
        const i = tabs.findIndex((t) => t.preview)
        const next = { ...tab, preview: true }
        if (i >= 0) {
          const old = tabs[i].key
          tabs = tabs.map((t, j) => (j === i ? next : t))
          mounted = mounted.filter((k) => k !== old)
        } else tabs = [...tabs, next]
      } else tabs = [...tabs, tab]
    }
    mounted = [key, ...mounted.filter((k) => k !== key)].slice(0, 5)
    return { tabs, activeTab: key, mountedTabs: mounted }
  })
  const [, kind, refId] = key.split("/")
  if (kind === "session" && refId) {
    markSeen(refId)
    const sel = getApp().selection
    if (!sel || sel.kind !== "session" || sel.id !== refId) select({ kind: "session", id: refId }, { reveal: false })
  }
}

/** Turn a preview tab into a normal tab (double-click, or when you interact with the session). */
export function pinTab(key: string) {
  setApp((s) => (s.tabs.some((t) => t.key === key && t.preview) ? { tabs: s.tabs.map((t) => (t.key === key ? { ...t, preview: false } : t)) } : s))
}
const pinSessionTab = (sessionId: ID) => pinTab(`/session/${sessionId}`)

export function closeTab(key: string) {
  const s = getApp()
  const tab = s.tabs.find((t) => t.key === key)
  if (!tab || tab.pinned) return
  const idx = s.tabs.findIndex((t) => t.key === key)
  const tabs = s.tabs.filter((t) => t.key !== key)
  setApp({ tabs, mountedTabs: s.mountedTabs.filter((k) => k !== key) })
  closedTabs.push(key)
  if (s.activeTab === key) {
    const next = tabs[Math.min(idx, tabs.length - 1)] ?? PINNED_TABS[0]
    navigate(next.key)
  }
}

const closedTabs: string[] = []
export function reopenClosedTab() {
  const key = closedTabs.pop()
  if (key) navigate(key)
}

export function moveTab(fromKey: string, toKey: string) {
  setApp((s) => {
    const tabs = s.tabs.slice()
    const from = tabs.findIndex((t) => t.key === fromKey)
    const to = tabs.findIndex((t) => t.key === toKey)
    if (from < 0 || to < 0 || tabs[from].pinned || tabs[to].pinned) return s
    const [t] = tabs.splice(from, 1)
    tabs.splice(to, 0, t)
    return { tabs }
  })
}

export function openSession(id: ID) {
  navigate(`/session/${id}`)
}
export function openRepo(id: ID) {
  navigate(`/repo/${id}`)
}
export function openReview(sessionId: ID) {
  navigate(`/review/${sessionId}`)
}
export function openGraph(scope: string) {
  navigate(`/graph/${scope}`)
}

// ---------- panels ----------
export function togglePanel(p: "sidebar" | "inspector" | "bottom", value?: boolean) {
  setApp((s) => ({ panels: { ...s.panels, [p]: value ?? !s.panels[p] } }))
}
export function setBottomTab(tab: "terminal" | "events") {
  setApp((s) => ({ panels: { ...s.panels, bottom: true, bottomTab: tab } }))
}
export function setLayoutPreset(preset: "default" | "focus" | "review") {
  const panels =
    preset === "focus"
      ? { sidebar: false, inspector: false, bottom: false }
      : preset === "review"
        ? { sidebar: false, inspector: true, bottom: false }
        : { sidebar: true, inspector: false, bottom: false }
  setApp((s) => ({ layoutPreset: preset, panels: { ...s.panels, ...panels } }))
}

// ---------- sidebar ----------
export function toggleSidebarNode(id: ID, value?: boolean) {
  setApp((s) => {
    const next = { ...s.sidebarExpanded }
    const open = value ?? !next[id]
    if (open) next[id] = true
    else delete next[id]
    return { sidebarExpanded: next }
  })
}
export function setSidebarGroupBy(groupBy: "repo" | "status" | "recent") {
  setApp({ sidebarGroupBy: groupBy })
}

// ---------- session lifecycle ----------
export function markSeen(id: ID) {
  const s = getApp().sessions[id]
  if (!s) return
  if (s.status === "done_unseen") setStatus(id, "idle", { lastViewedAt: nowIso() })
  else patchSession(id, { lastViewedAt: nowIso(), updatedAt: s.updatedAt })
  setApp((st) => ({
    notifications: st.notifications.map((n) => (n.sessionId === id && !n.readAt ? { ...n, readAt: nowIso() } : n)),
  }))
}

/** Archive = hide, never delete (user requirement). Restorable from the Archive view. */
export function archiveSessions(ids: ID[]) {
  const at = nowIso()
  setApp((s) => {
    const sessions = { ...s.sessions }
    for (const id of ids) {
      const prev = sessions[id]
      if (!prev || prev.role === "main") continue
      sessions[id] = { ...prev, archived: true, archivedAt: at, pinned: false }
    }
    const archivedSet = new Set(ids)
    return {
      sessions,
      structVersion: s.structVersion + 1,
      statusVersion: s.statusVersion + 1,
      toasts: s.toasts.filter((t) => !archivedSet.has(t.sessionId)),
      selection: s.selection?.kind === "session" && archivedSet.has(s.selection.id) ? null : s.selection,
    }
  })
  for (const id of ids) {
    const key = `/session/${id}`
    if (getApp().tabs.some((t) => t.key === key)) closeTab(key)
  }
}
export const archiveSession = (id: ID) => archiveSessions([id])

export function restoreSessions(ids: ID[]) {
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
  pinSessionTab(id)
  patchSession(id, { title, titleSource: "custom", titleLocked: true })
}

export function setSessionSettings(id: ID, patch: { model?: string; effort?: Effort; permissionMode?: PermissionMode }) {
  patchSession(id, patch)
}

export function interrupt(id: ID) {
  const s = getApp().sessions[id]
  if (!s || (s.status !== "working" && s.status !== "starting")) return
  setStatus(id, "idle", { activity: "Interrupted by user", lastStopReason: "cancelled" })
}

export function resumeSession(id: ID) {
  const s = getApp().sessions[id]
  if (!s) return
  setStatus(id, "working", {
    control: "owned",
    archived: false,
    activity: "Resumed: reading transcript",
    providerSessionIds: [...s.providerSessionIds, crypto.randomUUID()],
  })
  setApp((st) => ({ structVersion: st.structVersion + 1 }))
  openSession(id)
}

let seq = 0
const newId = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`

export function forkSession(id: ID) {
  const s = getApp().sessions[id]
  if (!s) return
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
}

export function createSession(input: NewSessionInput): ID {
  const st = getApp()
  const repo = st.repos[input.repoId]
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
  setTimeout(() => setStatus(id, "working", { activity: "Reading the codebase" }), 1200)
  return id
}

// ---------- requests ----------
export function resolvePermission(requestId: ID, optionId: string, feedback?: string) {
  const s = getApp()
  const req = s.requests[requestId]
  if (!req || req.type === "question") return
  if (s.activeTab === `/session/${req.sessionId}`) pinSessionTab(req.sessionId)
  const option = req.options.find((o) => o.id === optionId)
  const rejected = option?.kind === "reject_once" || option?.kind === "reject_always"
  setApp((st) => ({
    requests: { ...st.requests, [requestId]: { ...req, state: "selected", selectedOptionId: optionId, resolvedAt: nowIso() } as typeof req },
    toasts: st.toasts.filter((t) => t.sessionId !== req.sessionId),
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

export function answerQuestion(requestId: ID, answers: Record<string, string | string[]>) {
  const req = getApp().requests[requestId] as QuestionRequest | undefined
  if (!req || req.type !== "question") return
  pinSessionTab(req.sessionId)
  setApp((st) => ({
    requests: { ...st.requests, [requestId]: { ...req, state: "answered" } },
    toasts: st.toasts.filter((t) => t.sessionId !== req.sessionId),
  }))
  const first = Object.values(answers)[0]
  setStatus(req.sessionId, "working", {
    waitingFor: undefined,
    activity: `Continuing with: ${Array.isArray(first) ? first.join(", ") : first}`,
  })
}

// ---------- messages ----------
export function sendMessage(sessionId: ID, text: string, mode: "queue" | "now" = "queue") {
  const s = getApp().sessions[sessionId]
  if (!s || !text.trim()) return
  pinSessionTab(sessionId)
  const t = getApp().transcripts[sessionId]
  if (t && (s.status === "working" || s.status === "starting") && mode === "queue") {
    setApp((st) => ({
      transcripts: {
        ...st.transcripts,
        [sessionId]: { ...t, queued: [...t.queued, { id: newId("q"), text }] },
      },
    }))
    return
  }
  // engine/transcript module appends the user message and starts a new turn
  void import("@/mocks/transcript").then((m) => m.appendUserMessage(sessionId, text))
  setStatus(sessionId, "working", { activity: "Thinking…", waitingFor: undefined })
}

export function removeQueued(sessionId: ID, queuedId: ID) {
  const t = getApp().transcripts[sessionId]
  if (!t) return
  setApp((st) => ({
    transcripts: { ...st.transcripts, [sessionId]: { ...t, queued: t.queued.filter((q) => q.id !== queuedId) } },
  }))
}

// ---------- map ui ----------
export function patchMap(patch: Partial<MapUi>) {
  setApp((s) => ({ map: { ...s.map, ...patch } }))
}
export function toggleRepoCollapsed(repoId: ID) {
  setApp((s) => {
    const next = { ...s.map.collapsedRepos }
    if (next[repoId]) delete next[repoId]
    else next[repoId] = true
    return { map: { ...s.map, collapsedRepos: next } }
  })
}
export function toggleStack(repoId: ID) {
  setApp((s) => {
    const next = { ...s.map.expandedStacks }
    if (next[repoId]) delete next[repoId]
    else next[repoId] = true
    return { map: { ...s.map, expandedStacks: next } }
  })
}
export function toggleSubagents(sessionId: ID) {
  setApp((s) => {
    const next = { ...s.map.expandedSubagents }
    if (next[sessionId]) delete next[sessionId]
    else next[sessionId] = true
    return { map: { ...s.map, expandedSubagents: next } }
  })
}
export function setHistoryRange(r: HistoryRange) {
  patchMap({ historyRange: r })
}

// ---------- dialogs ----------
export function openPalette(prefix = "") {
  setApp({ paletteOpen: true, palettePrefix: prefix })
}
export function closePalette() {
  setApp({ paletteOpen: false, palettePrefix: "" })
}
export function openNewSession(repoId?: ID, tab: "new" | "resume" = "new") {
  setApp({ newSession: { repoId, tab } })
}
export function closeNewSession() {
  setApp({ newSession: null })
}
export function openCrossRepo(open = true) {
  setApp({ crossRepoOpen: open })
}

// ---------- notifications ----------
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
    const tExisting = st.toasts.find((t) => t.sessionId === n.sessionId)
    const toast = {
      id: tExisting?.id ?? newId("t"),
      sessionId: n.sessionId,
      kind: n.kind,
      title: n.title,
      body: n.body,
      count: (tExisting?.count ?? 0) + 1,
      createdAt: Date.now(),
    }
    const toasts = [toast, ...st.toasts.filter((t) => t.sessionId !== n.sessionId)].slice(0, 3)
    return { notifications, toasts }
  })
}
export function dismissToast(id: ID) {
  setApp((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}
export function markNotificationRead(id: ID) {
  const at = nowIso()
  setApp((s) => ({ notifications: s.notifications.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: at } : n)) }))
}
export function markAllNotificationsRead() {
  const at = nowIso()
  setApp((s) => ({ notifications: s.notifications.map((n) => (n.readAt ? n : { ...n, readAt: at })) }))
}
export function setNotificationsOpen(open: boolean) {
  setApp({ notificationsOpen: open })
}

// ---------- settings & engine ----------
export function patchSettings(patch: Partial<Settings>) {
  setApp((s) => ({ settings: { ...s.settings, ...patch } }))
}
export function setEngine(patch: Partial<{ running: boolean; rate: number }>) {
  setApp((s) => ({ engine: { ...s.engine, ...patch } }))
}

/** Go to the next item that needs the user (tier 0 first). */
export async function goToNextWaiting() {
  const { selectAttention } = await import("./selectors")
  const { STATUS_TIER } = await import("@/lib/status")
  const all = selectAttention(getApp())
  const needs = all.filter((e) => STATUS_TIER[e.status] <= 1)
  const list = needs.length ? needs : all
  if (!list.length) return
  const current = getApp().activeTab
  const idx = list.findIndex((e) => current === `/session/${e.kind === "session" ? e.id : e.sessionId}`)
  const next = list[(idx + 1) % list.length]
  openSession(next.kind === "session" ? next.id : next.sessionId)
}
