// Machines over ssh (Settings → Machines): a VPS where repos live that are not on this computer.
// Per machine the app keeps a reverse tunnel so the hook there posts to this app, polls
// `claude agents --json` there every 20 s, and reads transcripts and git over ssh. Sessions there
// appear in the same tree, under projects marked with the machine's name.
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getApp, setApp } from "@/store/app"
import type { ID, SessionStatus } from "@/lib/model"
import { extByMachine, gitByFolder, folderKey, requestSync, type ExtSession } from "./ext"
import { onRemoteHook, stateOf } from "./hooks"
import { gitFromPorcelain, readGit } from "./git"

export interface MachineStatus {
  host: string
  ok?: boolean
  hostname?: string
  claude?: string | null
  version?: string
  error?: string
  tunnel?: boolean
  tunnelError?: string
  hooks?: boolean
  checkedAt?: number
}

interface RemoteLive {
  pid?: number
  sessionId: string
  cwd: string
  kind?: "interactive" | "background"
  name?: string
  status?: string
  state?: string
  startedAt?: number
  updatedAt?: number
}

const statusOf = (l: RemoteLive): SessionStatus => {
  const s = (l.status ?? l.state ?? "").toLowerCase()
  if (s === "blocked" || s.includes("wait")) return "waiting_input"
  if (s === "busy" || s === "running" || s === "working") return "working"
  return "idle"
}

function machines(): string[] {
  return getApp().settings.machines.map((m) => m.host)
}

function setStatus(host: string, patch: Partial<MachineStatus>) {
  setApp((s) => ({ machineStatus: { ...s.machineStatus, [host]: { ...s.machineStatus[host], host, ...patch } } }))
}

/** hostname (what hooks report) → the ssh alias the user typed */
function aliasOf(hostname: string) {
  const st = getApp().machineStatus
  return machines().find((h) => h === hostname || st[h]?.hostname === hostname) ?? hostname
}

export async function probeMachine(host: string) {
  const r = await invoke<{ ok: boolean; hostname?: string; claude?: string | null; version?: string; error?: string }>("remote_probe", { host })
  setStatus(host, { ...r, checkedAt: Date.now() })
  if (r.ok) {
    const h = await invoke<{ installed: boolean; error?: string }>("hooks_status", { host }).catch(() => ({ installed: false }))
    setStatus(host, { hooks: h.installed })
  }
  return r
}

async function pollMachine(host: string) {
  try {
    const list = await invoke<RemoteLive[]>("remote_agents", { host })
    const prev = extByMachine.get(host) ?? new Map<ID, ExtSession>()
    const next = new Map<ID, ExtSession>()
    for (const l of list) {
      if (!l.sessionId) continue
      const old = prev.get(l.sessionId)
      // a fresh hook state is more exact than the poll
      const hookFresh = old && old.updatedMs > Date.now() - 20_000 && old.live
      next.set(l.sessionId, {
        id: l.sessionId,
        machine: host,
        cwd: l.cwd,
        title: old?.title && old.title !== "Session" ? old.title : (l.name ?? "Session"),
        status: hookFresh ? old.status : statusOf(l),
        waitingFor: hookFresh ? old.waitingFor : statusOf(l) === "waiting_input" ? { kind: "input", summary: "Waiting for you" } : undefined,
        activity: old?.activity,
        updatedMs: Math.max(old?.updatedMs ?? 0, l.updatedAt ?? 0),
        createdMs: l.startedAt,
        kind: l.kind,
        live: true,
        pid: l.pid,
      })
    }
    // ended sessions stay listed (stopped) until the app restarts
    for (const [id, s] of prev) if (!next.has(id)) next.set(id, { ...s, live: false, status: "stopped", waitingFor: undefined })
    extByMachine.set(host, next)
    setStatus(host, { ok: true, error: undefined })
    requestSync()
    // git of the folders in use there
    const cwds = [...new Set([...next.values()].filter((s) => s.live).map((s) => s.cwd))]
    void readGit(cwds, host)
  } catch (e) {
    setStatus(host, { ok: false, error: String(e) })
  }
}

function onHook({ host: hostname, git, at, event: e }: Parameters<Parameters<typeof onRemoteHook>[0]>[0]) {
  const host = aliasOf(hostname)
  const map = extByMachine.get(host) ?? new Map<ID, ExtSession>()
  extByMachine.set(host, map)
  const old = map.get(e.session_id)
  const st = stateOf(e, at)
  const cwd = e.cwd ?? old?.cwd ?? "~"
  map.set(e.session_id, {
    id: e.session_id,
    machine: host,
    cwd,
    title: old?.title ?? (e.prompt ? e.prompt.split("\n")[0].slice(0, 100) : "Session"),
    status: st?.status ?? old?.status ?? "idle",
    waitingFor: st ? st.waitingFor : old?.waitingFor,
    activity: st?.activity ?? old?.activity,
    errorMessage: st?.errorMessage,
    updatedMs: at,
    createdMs: old?.createdMs ?? at,
    kind: old?.kind,
    live: e.hook_event_name !== "SessionEnd",
    // the poll knows its process; a hook event does not (keep it for Take over)
    pid: old?.pid,
  })
  if (git) gitFromPorcelain(host, cwd, git)
  requestSync()
}

/** Keep tunnels and polls in step with Settings → Machines. */
let timer: ReturnType<typeof setInterval> | undefined
export async function startMachines() {
  onRemoteHook(onHook)
  await listen<{ host: string; tunnel: boolean; error?: string }>("remote-status", ({ payload }) => setStatus(payload.host, { tunnel: payload.tunnel, tunnelError: payload.error }))
  const tick = async () => {
    const hosts = machines()
    // machines removed in Settings go; the cloud's sessions are not a machine's (cloud.ts keeps them)
    for (const h of [...extByMachine.keys()]) if (h !== "cloud" && !hosts.includes(h)) extByMachine.delete(h)
    await invoke("remote_tunnels", { hosts }).catch((e) => console.warn("remote_tunnels", e))
    await Promise.all(hosts.map((h) => pollMachine(h)))
  }
  void tick()
  timer ??= setInterval(() => void tick(), 20_000)
  // machines added or removed in Settings: act now
  let last = machines().join("\n")
  const unsub = (await import("@/store/app")).useApp.subscribe((s) => {
    const now = s.settings.machines.map((m) => m.host).join("\n")
    if (now !== last) {
      last = now
      void tick()
    }
  })
  return unsub
}

export function remoteGit(host: string, cwd: string) {
  return gitByFolder.get(folderKey(host, cwd))
}

/** Remote transcript reads (window, then appended records). */
export function remoteTranscript(host: string, sessionId: string) {
  return invoke<{ records: Record<string, unknown>[]; offset: number; skipped: number }>("remote_transcript", { host, sessionId, max: 1500 })
}
export function remoteTranscriptSince(host: string, sessionId: string, offset: number) {
  return invoke<{ records: Record<string, unknown>[]; offset: number; skipped: number }>("remote_transcript_since", { host, sessionId, offset })
}
