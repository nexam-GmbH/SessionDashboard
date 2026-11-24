// Commands from `sd`: the command line and its MCP server, through which other Claude Code sessions
// start, message and watch the app's sessions (claude/hooks.rs passes them here as `sd-command`).
// Each runs the way the app's own buttons do: a session started here is one of the app's, listed,
// restored after a restart, with its permission prompts answered by you.
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getApp, useApp } from "@/store/app"
import { addRepoFromPath, createSession, openSession, renameSession, sendMessage } from "@/store/actions"
import { DEFAULT_MODEL, type Effort, type ID, type PermissionMode, type Session, type SessionStatus } from "@/lib/model"
import { shownStatus } from "@/store/selectors"
import { archiveWithUndo, restoreWithUndo } from "@/features/notifications/undo"
import { ensureRealTranscript, homeDir, realInject, realInjectWay, realStop } from "./real"

type Args = Record<string, unknown>
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/**
 * A session by its id, an id prefix (6+), or a unique part of its title; else why not. An exact
 * id finds any session; prefixes and titles look among the live ones, or the archived ones.
 */
export function resolveSession(sessions: Record<ID, Session>, ref: string, among: "live" | "archived" = "live"): Session | string {
  const r = ref.trim()
  if (!r) return "no session given"
  if (sessions[r]) return sessions[r]
  const list = Object.values(sessions).filter((s) => !!s.archived === (among === "archived"))
  if (r.length >= 6) {
    const byId = list.filter((s) => s.id.startsWith(r))
    if (byId.length === 1) return byId[0]
  }
  const low = r.toLowerCase()
  const exact = list.filter((s) => s.title.toLowerCase() === low)
  if (exact.length === 1) return exact[0]
  const part = list.filter((s) => s.title.toLowerCase().includes(low))
  if (part.length === 1) return part[0]
  if (!part.length) return `no ${among === "archived" ? "archived " : ""}session matches "${r}"`
  return `"${r}" matches ${part.length} sessions: ${part
    .slice(0, 6)
    .map((s) => `${s.id.slice(0, 8)} ${s.title}`)
    .join("; ")}${part.length > 6 ? "; …" : ""}`
}

function summary(s: Session) {
  const st = getApp()
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    outcome: s.outcome?.label,
    cwd: s.cwd,
    repo: s.repoId ? st.repos[s.repoId]?.name : undefined,
    machine: s.machine,
    control: s.control,
    updatedAt: s.updatedAt,
    unread: !!s.unreadSince || undefined,
    archived: s.archived || undefined,
    waitingFor: s.waitingFor?.summary,
  }
}

/** Archiving these would cut a session off mid-work or leave a prompt nobody sees. */
const BUSY = new Set(["starting", "working", "waiting_permission"])

/** The caller's own Claude Code session ids (sdcli.rs `caller_sessions`). */
const callerIds = (a: Args) => (Array.isArray(a.caller) ? a.caller.filter((x): x is string => typeof x === "string" && !!x) : [])
const isCaller = (s: Session, ids: string[]) => ids.some((c) => c === s.id || s.providerSessionIds.includes(c))

/** A session's latest user and assistant messages, oldest first (loads its transcript if needed). */
async function lastMessages(id: ID, last: number) {
  ensureRealTranscript(id)
  // the transcript loads in a moment if it was not in memory
  for (let i = 0; i < 40 && !getApp().transcripts[id]; i++) await new Promise((r) => setTimeout(r, 100))
  const t = getApp().transcripts[id]
  return (t?.order ?? [])
    .map((k) => t!.items[k])
    .filter((it) => it && (it.type === "user_message" || it.type === "agent_message") && "text" in it && it.text)
    .slice(-last)
    .map((it) => ({ role: it.type === "user_message" ? "user" : "assistant", text: (it as { text: string }).text, at: (it as { at?: string }).at }))
}

// ---- notify when done ------------------------------------------------------------------------
// A Claude that started or messaged a session (new_session / send_message with notify_when_done,
// or notify_when_done) gets one short message when that session's turn ends, the way a user's
// message reaches it: a session the app runs gets it as a message (mid-turn: read at its next
// step), a terminal session gets it typed into its terminal (claude/inject.rs). Kept across a restart.

/** The turn is over: finished, asks something, waits for a permission answer, failed or stopped. */
const DONE = new Set<SessionStatus>(["idle", "done_unseen", "waiting_input", "waiting_permission", "error", "stopped"])
/** A session that never shows as working (a message it did not take, a turn too quick to see) counts as done after this. */
const ARM_GRACE_MS = 20_000
const WATCH_KEY = "sd.notify-when-done"

interface Watch {
  target: ID
  caller: ID
  since: number
  /** seen starting or working since the watch began */
  armed: boolean
}
let watches: Watch[] = []
const saveWatches = () => {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(watches))
  } catch {
    /* storage full or off: the watches live until the app quits */
  }
}

/** The session that asks, if the app can get a message to it; else why not. */
async function notifiable(a: Args): Promise<Session | string> {
  const ids = callerIds(a)
  if (!ids.length) return "no calling Claude Code session (notify_when_done works from inside a Claude Code session)"
  const me = Object.values(getApp().sessions).find((s) => isCaller(s, ids))
  if (!me) return "Session Dashboard does not see your session, so it cannot message it; use wait_for_session"
  if (me.control === "owned") return me
  if (await realInjectWay(me.id)) return me
  return "your session runs in a terminal the dashboard cannot type into; use wait_for_session"
}

/** Watches `target` for `a.caller`; the result's fields say whether it worked. */
async function watchFor(target: ID, a: Args): Promise<{ notify: boolean; notifyError?: string }> {
  const me = await notifiable(a)
  if (typeof me === "string") return { notify: false, notifyError: me }
  if (me.id === target) return { notify: false, notifyError: "that is your own session" }
  const shown = shownStatus(getApp(), target)
  watches = [...watches.filter((w) => !(w.target === target && w.caller === me.id)), { target, caller: me.id, since: Date.now(), armed: shown === "starting" || shown === "working" }]
  saveWatches()
  return { notify: true }
}

const clip = (t: string, lines: number, chars: number) => {
  const kept = t.trim().split("\n").filter((l) => l.trim()).slice(0, lines).join("\n")
  const cut = kept.length > chars ? `${kept.slice(0, chars).trimEnd()}…` : kept
  return cut.length < t.trim().length ? `${cut}${cut.endsWith("…") ? "" : "\n…"}` : cut
}

const PHRASE: Partial<Record<SessionStatus, string>> = {
  idle: "finished its turn",
  done_unseen: "finished its turn",
  waiting_input: "waits for an answer",
  waiting_permission: "waits for a permission answer from the human in the dashboard",
  error: "stopped with an error",
  stopped: "was stopped",
}

async function deliver(w: Watch, status: SessionStatus) {
  const t = getApp().sessions[w.target]
  const me = getApp().sessions[w.caller]
  // a caller that was archived or stopped is not woken up for this
  if (!t || !me || me.archived || me.status === "stopped") return
  const answer = (await lastMessages(w.target, 10).catch(() => [])).filter((m) => m.role === "assistant").at(-1)?.text
  const lines = [`[Session Dashboard] Session "${t.title}" (${t.id}) ${PHRASE[status] ?? status}: status ${status}.`]
  if (t.waitingFor?.summary && (status === "waiting_input" || status === "waiting_permission")) lines.push(`Waiting for: ${t.waitingFor.summary}`)
  if (answer) lines.push(`Its last answer begins:\n${clip(answer, 6, 600)}`)
  lines.push(`(read_session ${t.id} for more)`)
  const text = lines.join("\n")
  if (me.control === "owned") sendMessage(me.id, text)
  else await realInject(me.id, text).catch((e: unknown) => console.warn("notify_when_done: could not type into", me.id, e))
}

function checkWatches() {
  if (!watches.length) return
  const st = getApp()
  const keep: Watch[] = []
  let changed = false
  for (const w of watches) {
    const t = st.sessions[w.target]
    if (!t || t.archived || !st.sessions[w.caller]) {
      changed = true
      continue
    }
    const shown = shownStatus(st, w.target)
    if (shown === "starting" || shown === "working") {
      if (!w.armed) changed = true
      keep.push(w.armed ? w : { ...w, armed: true })
      continue
    }
    if (DONE.has(shown) && (w.armed || Date.now() - w.since > ARM_GRACE_MS)) {
      changed = true
      void deliver(w, shown)
      continue
    }
    keep.push(w)
  }
  if (changed) {
    watches = keep
    saveWatches()
  }
}

function startWatches() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCH_KEY) ?? "[]")
    if (Array.isArray(saved)) watches = saved.filter((w) => w && typeof w.target === "string" && typeof w.caller === "string")
  } catch {
    watches = []
  }
  useApp.subscribe((s, prev) => {
    if (watches.length && s.statusVersion !== prev.statusVersion) checkWatches()
  })
  // the grace period ends without a status change
  setInterval(checkWatches, 5000)
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"])
const MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"])

async function run(cmd: string, a: Args): Promise<unknown> {
  const st = getApp()
  const find = () => resolveSession(st.sessions, str(a.session))
  switch (cmd) {
    case "list": {
      const q = str(a.query).toLowerCase()
      const status = str(a.status)
      const withArchived = a.archived === true
      const list = Object.values(st.sessions)
        .filter((s) => withArchived || !s.archived)
        .filter((s) => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q))
        .filter((s) => !status || s.status === status)
        .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1))
      return { sessions: list.map(summary) }
    }
    case "new": {
      const dir = str(a.dir)
      if (!dir) return { error: "dir is required: the folder the session works in" }
      const d = st.settings.defaults
      const effort = str(a.effort)
      const mode = str(a.permissionMode)
      if (effort && !EFFORTS.has(effort)) return { error: `effort is one of ${[...EFFORTS].join(", ")}` }
      if (mode && !MODES.has(mode)) return { error: `permissionMode is one of ${[...MODES].join(", ")}` }
      const repoId = addRepoFromPath(dir.replace(/^~(?=\/|$)/, homeDir() || "~"))
      const name = str(a.name)
      const prompt = str(a.prompt)
      const worktree = a.worktree === true
      const id = createSession({
        repoId,
        where: worktree && !getApp().repos[repoId]?.isHome ? "worktree-new" : "main",
        worktreeName: (name || prompt).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 4).join("-") || "new-session",
        title: name || undefined,
        prompt,
        model: str(a.model) || d.model || DEFAULT_MODEL,
        effort: (effort || d.effort) as Effort,
        permissionMode: (mode || d.permissionMode) as PermissionMode,
        explicitMode: !!mode,
        additionalRepoIds: [],
        background: true,
      })
      // the name holds from the first moment (else the prompt's first line shows until Claude Code
      // writes the name itself): a script or a Claude can address the session by it at once
      if (name) renameSession(id, name)
      if (a.open === true) openSession(id)
      return { id, title: getApp().sessions[id]?.title ?? name, ...(a.notify === true ? await watchFor(id, a) : {}) }
    }
    case "send": {
      const s = find()
      if (typeof s === "string") return { error: s }
      const text = str(a.text)
      if (!text) return { error: "text is empty" }
      if (a.notify === true && isCaller(s, callerIds(a))) return { error: "that is your own session" }
      sendMessage(s.id, text)
      return { id: s.id, ...(a.notify === true ? await watchFor(s.id, a) : {}) }
    }
    case "status": {
      const s = find()
      return typeof s === "string" ? { error: s } : summary(s)
    }
    case "read": {
      const s = find()
      if (typeof s === "string") return { error: s }
      const messages = await lastMessages(s.id, Math.min(200, Math.max(1, Number(a.last) || 20)))
      return { ...summary(getApp().sessions[s.id] ?? s), messages }
    }
    case "stop": {
      const s = find()
      if (typeof s === "string") return { error: s }
      if (s.control !== "owned") return { error: "this session does not run in the app (it runs in a terminal, or not at all)" }
      realStop(s.id)
      return { id: s.id }
    }
    // the same as Archive in the session's menu (Undo notice included); refused while it works or
    // waits for a permission answer, and for the session that asks (it would hide itself)
    case "archive": {
      const s = find()
      if (typeof s === "string") return { error: s }
      if (s.archived) return { id: s.id, title: s.title, archived: true, already: true }
      if (s.role === "main") return { error: "the main agent cannot be archived" }
      const shown = shownStatus(st, s.id)
      if (BUSY.has(shown)) return { error: `"${s.title}" is ${shown}: archive it once it has stopped (stop_session, or wait_for_session)` }
      if (isCaller(s, callerIds(a))) return { error: "this is your own session: a session cannot archive itself" }
      archiveWithUndo([s.id])
      return { id: s.id, title: s.title, archived: !!getApp().sessions[s.id]?.archived }
    }
    case "unarchive": {
      const s = resolveSession(st.sessions, str(a.session), "archived")
      if (typeof s === "string") return { error: s }
      if (!s.archived) return { id: s.id, title: s.title, archived: false, already: true }
      restoreWithUndo([s.id])
      return { id: s.id, title: s.title, archived: !!getApp().sessions[s.id]?.archived }
    }
    // a message to the caller when this session's current work ends
    case "notify": {
      const s = find()
      if (typeof s === "string") return { error: s }
      const shown = shownStatus(st, s.id)
      if (shown !== "starting" && shown !== "working") return { error: `"${s.title}" is ${shown}, not working: there is nothing to wait for` }
      const r = await watchFor(s.id, a)
      return r.notify ? { id: s.id, title: s.title, ...r } : { error: r.notifyError }
    }
    case "open": {
      const s = find()
      if (typeof s === "string") return { error: s }
      openSession(s.id)
      return { id: s.id }
    }
    default:
      return { error: `unknown command "${cmd}"` }
  }
}

export async function startSdCommands() {
  startWatches()
  await listen<{ id: string; cmd: string; args?: Args }>("sd-command", ({ payload }) => {
    void run(String(payload.cmd ?? ""), payload.args && typeof payload.args === "object" ? payload.args : {})
      .catch((e: unknown) => ({ error: String(e) }))
      .then((result) => invoke("sd_reply", { id: payload.id, result }).catch(() => undefined))
  })
}
