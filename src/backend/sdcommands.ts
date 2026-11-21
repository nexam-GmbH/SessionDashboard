// Commands from `sd`: the command line and its MCP server, through which other Claude Code sessions
// start, message and watch the app's sessions (claude/hooks.rs passes them here as `sd-command`).
// Each runs the way the app's own buttons do: a session started here is one of the app's, listed,
// restored after a restart, with its permission prompts answered by you.
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getApp } from "@/store/app"
import { addRepoFromPath, createSession, openSession, renameSession, sendMessage } from "@/store/actions"
import { DEFAULT_MODEL, type Effort, type ID, type PermissionMode, type Session } from "@/lib/model"
import { ensureRealTranscript, homeDir, realStop } from "./real"

type Args = Record<string, unknown>
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** A session by its id, an id prefix (6+), or a unique part of its title; else why not. */
export function resolveSession(sessions: Record<ID, Session>, ref: string): Session | string {
  const r = ref.trim()
  if (!r) return "no session given"
  if (sessions[r]) return sessions[r]
  const list = Object.values(sessions).filter((s) => !s.archived)
  if (r.length >= 6) {
    const byId = list.filter((s) => s.id.startsWith(r))
    if (byId.length === 1) return byId[0]
  }
  const low = r.toLowerCase()
  const exact = list.filter((s) => s.title.toLowerCase() === low)
  if (exact.length === 1) return exact[0]
  const part = list.filter((s) => s.title.toLowerCase().includes(low))
  if (part.length === 1) return part[0]
  if (!part.length) return `no session matches "${r}"`
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
    waitingFor: s.waitingFor?.summary,
  }
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
      const list = Object.values(st.sessions)
        .filter((s) => !s.archived)
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
      return { id, title: getApp().sessions[id]?.title ?? name }
    }
    case "send": {
      const s = find()
      if (typeof s === "string") return { error: s }
      const text = str(a.text)
      if (!text) return { error: "text is empty" }
      sendMessage(s.id, text)
      return { id: s.id }
    }
    case "status": {
      const s = find()
      return typeof s === "string" ? { error: s } : summary(s)
    }
    case "read": {
      const s = find()
      if (typeof s === "string") return { error: s }
      ensureRealTranscript(s.id)
      // the transcript loads in a moment if it was not in memory
      for (let i = 0; i < 40 && !getApp().transcripts[s.id]; i++) await new Promise((r) => setTimeout(r, 100))
      const t = getApp().transcripts[s.id]
      const last = Math.min(200, Math.max(1, Number(a.last) || 20))
      const messages = (t?.order ?? [])
        .map((k) => t!.items[k])
        .filter((it) => it && (it.type === "user_message" || it.type === "agent_message") && "text" in it && it.text)
        .slice(-last)
        .map((it) => ({ role: it.type === "user_message" ? "user" : "assistant", text: (it as { text: string }).text, at: (it as { at?: string }).at }))
      return { ...summary(getApp().sessions[s.id] ?? s), messages }
    }
    case "stop": {
      const s = find()
      if (typeof s === "string") return { error: s }
      if (s.control !== "owned") return { error: "this session does not run in the app (it runs in a terminal, or not at all)" }
      realStop(s.id)
      return { id: s.id }
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
  await listen<{ id: string; cmd: string; args?: Args }>("sd-command", ({ payload }) => {
    void run(String(payload.cmd ?? ""), payload.args && typeof payload.args === "object" ? payload.args : {})
      .catch((e: unknown) => ({ error: String(e) }))
      .then((result) => invoke("sd_reply", { id: payload.id, result }).catch(() => undefined))
  })
}
