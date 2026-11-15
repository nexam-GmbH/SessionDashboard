import type { ID, PendingRequest, Session, SessionStatus } from "@/lib/model"
import { getApp, setApp, useApp } from "@/store/app"
import { addDiscoveredSession, pushNotification, removeQueued, sendMessage } from "@/store/actions"
import { Rng } from "./rng"

/**
 * Mock engine: simulates what the Phase 2 backend will deliver.
 * Events are queued and applied once per animation frame in a single store
 * update — the same batching path the real Tauri Channel handler will use
 *. Rate = events per second across all sessions.
 */

export type EngineEvent =
  | { t: "activity"; sid: ID; activity: string }
  | { t: "usage"; sid: ID; dIn: number; dOut: number; dCost: number; dCtx: number }
  | { t: "diff"; sid: ID; files: number; add: number; del: number }
  | { t: "status"; sid: ID; status: SessionStatus; patch?: Partial<Session>; request?: PendingRequest }
  | { t: "subagent-done"; aid: ID }
  | { t: "transcript"; sid: ID }

const queue: EngineEvent[] = []
let rafScheduled = false
const listeners = new Set<(batch: EngineEvent[]) => void>()

/** Other modules (transcripts, perf harness) can observe applied batches. */
export function onEngineBatch(fn: (batch: EngineEvent[]) => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function enqueue(ev: EngineEvent) {
  queue.push(ev)
  if (!rafScheduled) {
    rafScheduled = true
    requestAnimationFrame(flush)
  }
}

let appliedTotal = 0
export const engineStats = { applied: 0, batches: 0, lastBatch: 0 }

function flush() {
  rafScheduled = false
  if (!queue.length) return
  const batch = queue.splice(0, queue.length)
  const notify: Parameters<typeof pushNotification>[0][] = []
  setApp((s) => {
    let sessions = s.sessions
    let subagents = s.subagents
    let requests = s.requests
    let statusVersion = s.statusVersion
    const touch = (sid: ID) => {
      if (sessions === s.sessions) sessions = { ...s.sessions }
      const cur = sessions[sid]
      sessions[sid] = { ...cur }
      return sessions[sid]
    }
    for (const ev of batch) {
      if (ev.t === "subagent-done") {
        const a = subagents[ev.aid]
        if (!a || a.status !== "running") continue
        if (subagents === s.subagents) subagents = { ...s.subagents }
        subagents[ev.aid] = { ...a, status: "completed", finishedAt: new Date().toISOString(), summary: "Done. Reported findings to the parent session." }
        statusVersion++
        continue
      }
      if (ev.t === "transcript") continue
      const cur = sessions[ev.sid]
      if (!cur) continue
      const x = touch(ev.sid)
      x.updatedAt = new Date().toISOString()
      if (ev.t === "activity") x.activity = ev.activity
      else if (ev.t === "usage") {
        x.usage = {
          inputTokens: x.usage.inputTokens + ev.dIn,
          outputTokens: x.usage.outputTokens + ev.dOut,
          costUsd: Math.round((x.usage.costUsd + ev.dCost) * 100) / 100,
          contextPct: Math.min(97, x.usage.contextPct + ev.dCtx),
        }
      } else if (ev.t === "diff") {
        x.diff = {
          ...x.diff,
          filesChanged: Math.max(x.diff.filesChanged, ev.files),
          linesAdded: x.diff.linesAdded + ev.add,
          linesRemoved: x.diff.linesRemoved + ev.del,
        }
      } else if (ev.t === "status") {
        Object.assign(x, ev.patch)
        x.status = ev.status
        x.statusObservedAt = new Date().toISOString()
        statusVersion++
        if (ev.request) {
          if (requests === s.requests) requests = { ...s.requests }
          requests[ev.request.id] = ev.request
        }
        const repoName = x.repoId ? s.repos[x.repoId]?.name : "main"
        const kind =
          ev.status === "waiting_permission" ? "permission" :
          ev.status === "waiting_input" ? "question" :
          ev.status === "error" ? "error" :
          ev.status === "done_unseen" ? "finished" : null
        if (kind && s.settings.notify[kind]) {
          notify.push({
            sessionId: x.id,
            kind,
            title: `${repoName} · ${x.title}`,
            body: x.waitingFor?.summary ?? (kind === "finished" ? (x.diff.filesChanged ? `${x.diff.filesChanged} files changed · +${x.diff.linesAdded} −${x.diff.linesRemoved}` : "") : kind === "error" ? (x.errorMessage ?? "Error") : ""),
            createdAt: x.statusObservedAt,
          })
        }
      }
    }
    return { sessions, subagents, requests, statusVersion }
  })
  appliedTotal += batch.length
  engineStats.applied = appliedTotal
  engineStats.batches++
  engineStats.lastBatch = batch.length
  // a finished turn delivers the next queued message (as Claude Code does after the turn ends)
  const delivered = new Set<ID>()
  for (const ev of batch) {
    if (ev.t !== "status" || ev.status !== "done_unseen" || delivered.has(ev.sid)) continue
    const q = getApp().transcripts[ev.sid]?.queued[0]
    if (!q) continue
    delivered.add(ev.sid)
    removeQueued(ev.sid, q.id)
    sendMessage(ev.sid, q.text, "now", q.attachments)
  }
  for (const n of notify) {
    // don't toast for the session the user is looking at, or one that just picked up its queue
    if (getApp().route !== `/session/${n.sessionId}` && !delivered.has(n.sessionId)) pushNotification(n)
  }
  listeners.forEach((l) => l(batch))
}

const rng = new Rng(4242)
let timer: ReturnType<typeof setInterval> | null = null
const TICK_MS = 250

const ACTIVITIES = [
  (f: string) => `Editing ${f}`,
  (f: string) => `Reading ${f}`,
  () => "Running tests",
  () => "Thinking…",
  (f: string) => `Searching for usages near ${f.split("/").pop()}`,
  () => "Waiting on subagent",
]

/**
 * Sessions "started in your terminal" while the app runs (Phase 2 discovers real ones): one in a
 * tracked project, one in a folder that becomes a new project.
 */
const DISCOVERIES = [
  { afterTicks: 100, path: "~/code/web-app", task: "Fix flaky checkout e2e test" },
  { afterTicks: 220, path: "~/code/scratch", task: "Try the new streaming API" },
]
let ticks = 0

function tick() {
  const s = getApp()
  if (!s.engine.running) return
  ticks++
  const found = DISCOVERIES.find((d) => d.afterTicks === ticks)
  if (found) addDiscoveredSession(found.path, found.task)
  const n = Math.max(1, Math.round((s.engine.rate * TICK_MS) / 1000 + (rng.float() - 0.5)))
  const working = Object.values(s.sessions).filter((x) => x.status === "working" && !x.archived)
  if (!working.length) return
  for (let i = 0; i < n; i++) {
    const x = rng.pick(working)
    const files = x.repoId ? s.repoSpecs[x.repoId]?.files : undefined
    const roll = rng.float()
    if (roll < 0.45) {
      enqueue({ t: "usage", sid: x.id, dIn: rng.int(800, 6000), dOut: rng.int(80, 900), dCost: rng.float() * 0.02, dCtx: rng.chance(0.2) ? 1 : 0 })
    } else if (roll < 0.75 && files) {
      enqueue({ t: "activity", sid: x.id, activity: rng.pick(ACTIVITIES)(rng.pick(files)) })
    } else if (roll < 0.9) {
      enqueue({ t: "diff", sid: x.id, files: x.diff.filesChanged + (rng.chance(0.2) ? 1 : 0), add: rng.int(1, 14), del: rng.int(0, 5) })
    } else if (roll < 0.94) {
      const running = (s.subagentIdsBySession[x.id] ?? []).filter((a) => s.subagents[a].status === "running")
      if (running.length) enqueue({ t: "subagent-done", aid: rng.pick(running) })
    } else if (roll < 0.9435 && x.role !== "main") {
      // occasional transitions (~1/min at the default rate) so the attention queue stays alive without noise
      const next = rng.pick(["done_unseen", "done_unseen", "waiting_permission", "waiting_input"] as const)
      if (next === "waiting_permission") {
        const id = `r_${rng.hex(8)}`
        const command = rng.pick(["npm run lint -- --fix", "go test ./...", "pytest -q", "git push -u origin HEAD"])
        enqueue({
          t: "status",
          sid: x.id,
          status: next,
          patch: { waitingFor: { kind: "permission", summary: `Bash: ${command}`, requestId: id }, activity: undefined },
          request: {
            type: "permission",
            id,
            sessionId: x.id,
            toolName: "Bash",
            title: "Bash command",
            subject: { type: "command", command, cwd: x.cwd },
            options: [
              { id: "allow-once", name: "Yes", kind: "allow_once" },
              { id: "allow-always", name: `Yes, and don't ask again for ${command.split(" ").slice(0, 2).join(" ")}:* in this project`, kind: "allow_always" },
              { id: "reject", name: "No, and tell Claude what to do differently", kind: "reject_once" },
            ],
            state: "pending",
            requestedAt: new Date().toISOString(),
          },
        })
      } else if (next === "waiting_input") {
        enqueue({
          t: "status",
          sid: x.id,
          status: "waiting_input",
          patch: { waitingFor: { kind: "input", summary: "Finished the first step. Continue with the next one?" }, activity: undefined },
        })
      } else {
        enqueue({ t: "status", sid: x.id, status: "done_unseen", patch: { activity: undefined, lastStopReason: "end_turn", todo: undefined } })
      }
    }
  }
}

export function startEngine() {
  if (timer) return
  timer = setInterval(tick, TICK_MS)
}

export function stopEngine() {
  if (timer) clearInterval(timer)
  timer = null
}

// keep idle sessions from piling up: occasionally "start" idle ones again (rare)
useApp.subscribe(
  (s) => s.engine.running,
  (running) => {
    if (running) startEngine()
  },
)
