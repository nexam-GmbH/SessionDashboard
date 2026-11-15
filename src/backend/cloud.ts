// Cloud sessions (claude.ai/code and Remote Control) of the signed-in account, read the way the
// Claude Code desktop app does: `list_cloud_sessions` and `get_cloud_session_transcript` control
// requests to a claude the app started; a message goes in with `claude -p <text> --cloud <id>`.
// A cloud session's permission prompts are answered on claude.ai (the CLI has no headless way).
import { invoke } from "@tauri-apps/api/core"
import { setApp } from "@/store/app"
import type { ID, SessionStatus } from "@/lib/model"
import { extByMachine, requestSync, type ExtSession } from "./ext"

export const CLOUD = "cloud"

interface RawCloud {
  id: string
  title: string
  updated_at: string
  status?: "running" | "idle" | "requires_action" | "archived" | "pending" | "failed"
  environment_kind?: "bridge" | "anthropic_cloud" | "byoc" | "snap"
  repository?: { owner: string; name: string }
  branch?: string
}

const STATUS: Record<string, SessionStatus> = { running: "working", pending: "starting", requires_action: "waiting_input", failed: "error", idle: "idle" }
const DAY = 24 * 3600_000

export const cloudUrl = (id: string) => `https://claude.ai/code/${id}`

function toExt(c: RawCloud, prev?: ExtSession): ExtSession {
  const status = STATUS[c.status ?? "idle"] ?? "idle"
  const repo = c.repository ? `${c.repository.owner}/${c.repository.name}` : c.environment_kind === "bridge" ? "Remote Control" : "Cloud"
  return {
    id: c.id,
    machine: CLOUD,
    cwd: repo,
    title: c.title || prev?.title || "Cloud session",
    status,
    waitingFor: status === "waiting_input" ? { kind: "input", summary: "Needs you on claude.ai" } : undefined,
    // while it works: what it does now (read from its newest entries); else where it is
    activity: status === "working" || status === "starting" ? (prev?.activity && !prev.activity.startsWith("On ") ? prev.activity : "Working") : c.branch ? `On ${c.branch}` : prev?.activity,
    updatedMs: Date.parse(c.updated_at) || Date.now(),
    branch: c.branch,
    url: cloudUrl(c.id),
    live: status !== "idle" && status !== "error",
  }
}

/** Sessions shown: active ones, and idle ones touched in the last 2 days. */
function shown(c: RawCloud) {
  if (c.status === "archived") return false
  if (c.status === "running" || c.status === "pending" || c.status === "requires_action") return true
  return Date.now() - (Date.parse(c.updated_at) || 0) < 2 * DAY
}

export function applyCloudList(list?: { status: string; sessions?: RawCloud[]; message?: string }) {
  if (!list) return
  setApp({ cloudStatus: list.status === "ok" ? { ok: true, count: list.sessions?.length ?? 0 } : { ok: false, message: list.message ?? list.status } })
  if (list.status !== "ok") return
  const prev = extByMachine.get(CLOUD) ?? new Map<ID, ExtSession>()
  const next = new Map<ID, ExtSession>()
  for (const c of list.sessions ?? []) if (shown(c)) next.set(c.id, toExt(c, prev.get(c.id)))
  extByMachine.set(CLOUD, next)
  requestSync()
}

export async function pollCloud() {
  try {
    applyCloudList(await invoke<{ status: string; sessions?: RawCloud[]; message?: string }>("cloud_list"))
  } catch (e) {
    setApp({ cloudStatus: { ok: false, message: String(e) } })
  }
}

/** Every stored page of a cloud transcript, oldest first (the service pages forward). */
export async function cloudTranscript(id: ID, from?: string): Promise<{ entries: Record<string, unknown>[]; cursor?: string }> {
  const entries: Record<string, unknown>[] = []
  let cursor = from
  for (let page = 0; page < 40; page++) {
    const r = await invoke<{ status: string; entries?: Record<string, unknown>[]; next_cursor?: string; message?: string }>("cloud_transcript", { sessionId: id, cursor })
    if (r.status !== "ok") throw new Error(r.message ?? r.status)
    entries.push(...(r.entries ?? []))
    if (!r.next_cursor) break
    cursor = r.next_cursor
  }
  // the cursor of the last page read: reading from there again picks up what was added
  return { entries, cursor }
}

export async function cloudSend(id: ID, text: string) {
  return invoke<{ ok?: boolean; url?: string }>("cloud_send", { sessionId: id, text })
}
