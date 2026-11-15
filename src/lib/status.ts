import type { ControlMode, PermissionMode, Session, SessionStatus, Subagent } from "./model"
import { REAL } from "@/backend/mode"

/**
 * Status system.
 * Attention tiers follow Agent of Empires `attention_tier` (MIT): waiting first,
 * then errors, then finished-unseen; within tier 0 most-recently-waiting first
 * (agent-deck, MIT).
 */
export const STATUS_TIER: Record<SessionStatus, number> = {
  waiting_permission: 0,
  waiting_input: 0,
  error: 1,
  done_unseen: 2,
  working: 4,
  starting: 4,
  idle: 5,
  stopped: 6,
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  waiting_permission: "Needs permission",
  waiting_input: "Waiting for input",
  error: "Error",
  done_unseen: "Done, unseen",
  working: "Working",
  starting: "Starting",
  idle: "Idle",
  stopped: "Not running",
}

export const STATUS_SHORT: Record<SessionStatus, string> = {
  waiting_permission: "permission",
  waiting_input: "input",
  error: "error",
  done_unseen: "unseen",
  working: "working",
  starting: "starting",
  idle: "idle",
  stopped: "stopped",
}

/** CSS color variable per status (dot color). */
export const STATUS_COLOR: Record<SessionStatus, string> = {
  waiting_permission: "var(--st-perm)",
  waiting_input: "var(--st-input)",
  error: "var(--st-error)",
  done_unseen: "var(--st-done)",
  working: "var(--st-working)",
  starting: "var(--st-working)",
  idle: "var(--st-idle)",
  stopped: "var(--st-idle)",
}

export const STATUS_FG: Record<SessionStatus, string> = {
  waiting_permission: "var(--st-perm-fg)",
  waiting_input: "var(--st-input-fg)",
  error: "var(--st-error-fg)",
  done_unseen: "var(--st-done-fg)",
  working: "var(--st-working-fg)",
  starting: "var(--st-working-fg)",
  idle: "var(--muted-foreground)",
  stopped: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)",
}

export const STATUS_TINT: Partial<Record<SessionStatus, string>> = {
  waiting_permission: "var(--st-perm-tint)",
  waiting_input: "var(--st-input-tint)",
  error: "var(--st-error-tint)",
  done_unseen: "var(--st-done-tint)",
  working: "var(--st-working-tint)",
}

export const ATTENTION_STATUSES: SessionStatus[] = [
  "waiting_permission",
  "waiting_input",
  "error",
  "done_unseen",
]

export function needsYou(status: SessionStatus) {
  return STATUS_TIER[status] <= 2
}

export function isWaiting(status: SessionStatus) {
  return status === "waiting_permission" || status === "waiting_input"
}

export function isLive(status: SessionStatus) {
  return status !== "stopped"
}

/** Sort comparator: attention tier, then most recently waiting/updated first. */
export function compareAttention(a: Session, b: Session) {
  const t = STATUS_TIER[a.status] - STATUS_TIER[b.status]
  if (t !== 0) return t
  // ISO timestamps compare correctly as plain strings (much faster than localeCompare)
  return a.statusObservedAt < b.statusObservedAt ? 1 : a.statusObservedAt > b.statusObservedAt ? -1 : 0
}

export const SUBAGENT_STATUS_AS_SESSION: Record<Subagent["status"], SessionStatus> = {
  running: "working",
  waiting_permission: "waiting_permission",
  completed: "idle",
  failed: "error",
  stopped: "stopped",
}

// ---------- control modes ----------
export const CONTROL_TAG: Record<ControlMode, string> = {
  owned: "OWN",
  pty: "PTY",
  observed: "OBS",
  history: "HIST",
  cloud: "CLOUD",
}

export const CONTROL_LABEL: Record<ControlMode, string> = {
  owned: "Started by the app: full control (stream, approvals, interrupt, settings).",
  pty: "Interactive CLI in the app's terminal: approvals via hook, full control.",
  observed:
    "Started in your terminal. You can read it and send messages here; approvals happen in that terminal.",
  history: "Not running. Resume to continue it here, or fork a copy.",
  cloud: "Runs on claude.ai. Messages go in from here; permission prompts are answered on claude.ai.",
}

export interface ControlCapabilities {
  send: boolean
  approve: boolean
  interrupt: boolean
  changeSettings: boolean
  resume: boolean
}

export function capabilities(mode: ControlMode): ControlCapabilities {
  switch (mode) {
    case "owned":
    case "pty":
      return { send: true, approve: true, interrupt: true, changeSettings: true, resume: false }
    case "observed":
      // a real terminal session can't take messages from here yet (two writers on one session);
      // Take over (stop it in the terminal, resume it here) gives full control
      // prompts come through the hook (Settings → Exact states from hooks) and can be answered
      // here or in the terminal, whichever is first; messages need Take over
      return { send: !REAL, approve: REAL, interrupt: false, changeSettings: false, resume: REAL }
    case "history":
      return { send: false, approve: false, interrupt: false, changeSettings: false, resume: true }
    case "cloud":
      // messages go in with `claude -p --cloud <id>`; permission prompts are answered on claude.ai
      return { send: true, approve: false, interrupt: false, changeSettings: false, resume: false }
  }
}

export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  default: "Manual",
  acceptEdits: "Accept edits",
  plan: "Plan",
  auto: "Auto",
  dontAsk: "Don't ask",
  bypassPermissions: "Bypass permissions",
}

export function modelShort(model: string) {
  if (model.includes("opus")) return "opus"
  if (model.includes("sonnet")) return "sonnet"
  if (model.includes("haiku")) return "haiku"
  if (model.includes("fable")) return "fable"
  return model
}
