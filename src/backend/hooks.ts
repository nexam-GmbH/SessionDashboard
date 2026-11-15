// Hook events (src-tauri/src/claude/hooks.rs): once the user installs the hook, every Claude Code
// session posts its events here, sessions in a terminal included. They turn into exact states —
// "waiting for permission: Bash npm test" instead of the pid file's "blocked" — and, for a VPS,
// into the session list itself (machines.ts). Each event carries the folder's git status.
import { listen } from "@tauri-apps/api/event"
import type { Session, SessionStatus } from "@/lib/model"
import { hookState, requestSync, type HookState } from "./ext"
import { gitFromPorcelain, readGit } from "./git"

let movedOn: (sessionId: string, at: number, agentId?: string) => void = () => undefined
/** real.ts: progress in a session (or one of its subagents) means its offered prompt was answered elsewhere */
export function onMovedOn(f: (sessionId: string, at: number, agentId?: string) => void) {
  movedOn = f
}

export interface HookPost {
  host: string
  local: boolean
  git: string
  at: number
  event: HookEvent
}
export interface HookEvent {
  hook_event_name: string
  session_id: string
  transcript_path?: string
  cwd?: string
  prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  message?: string
  notification_type?: string
  last_assistant_message?: string
  /** set when a subagent of the session fires the hook (its own tool calls, its own prompts) */
  agent_id?: string
  error?: unknown
  reason?: string
  source?: string
}

const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** One line for a tool call: "Bash npm test", "Edit src/x.ts". */
export function toolLine(name: string, input?: Record<string, unknown>) {
  const i = input ?? {}
  const arg = (i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description ?? "") as string
  const base = typeof arg === "string" ? arg.replace(/^\/home\/[^/]+\//, "~/") : ""
  return short(base ? `${name} ${base.split("\n")[0]}` : name)
}

/** The state a hook event puts a session in (undefined = no change). */
export function stateOf(e: HookEvent, at: number): HookState | undefined {
  const s = (status: SessionStatus, extra: Partial<HookState> = {}): HookState => ({ status, at, ...extra })
  switch (e.hook_event_name) {
    case "UserPromptSubmit":
      return s("working", { activity: "Thinking" })
    case "PreToolUse":
      return s("working", { activity: toolLine(e.tool_name ?? "Tool", e.tool_input) })
    case "PermissionRequest": {
      const line = toolLine(e.tool_name ?? "Tool", e.tool_input)
      const waitingFor: Session["waitingFor"] =
        e.tool_name === "AskUserQuestion" ? { kind: "question", summary: "Has a question for you" } : e.tool_name === "ExitPlanMode" ? { kind: "plan", summary: "Plan ready for review" } : { kind: "permission", summary: line }
      return s(e.tool_name === "AskUserQuestion" ? "waiting_input" : "waiting_permission", { waitingFor })
    }
    case "Notification":
      if (e.notification_type === "permission_prompt") return s("waiting_permission", { waitingFor: { kind: "permission", summary: short(e.message ?? "Needs permission") } })
      if (e.notification_type === "elicitation_dialog" || e.notification_type === "agent_needs_input") return s("waiting_input", { waitingFor: { kind: "input", summary: short(e.message ?? "Needs your input") } })
      return undefined
    case "Stop":
      return s("idle", { activity: e.last_assistant_message ? short(e.last_assistant_message.replace(/\s+/g, " "), 160) : undefined })
    case "StopFailure":
      return s("error", { errorMessage: short(typeof e.error === "string" ? e.error : "The turn failed", 160) })
    case "SessionEnd":
      return s("stopped")
    case "SessionStart":
      return s("idle")
    default:
      return undefined
  }
}

let remoteHandler: (p: HookPost) => void = () => undefined
/** machines.ts takes the posts that come from a VPS. */
export function onRemoteHook(f: (p: HookPost) => void) {
  remoteHandler = f
}

export async function startHooks() {
  await listen<HookPost>("hook-event", ({ payload }) => {
    const e = payload.event
    if (!e?.session_id) return
    // progress by the agent that asked: its prompt was answered (a subagent's progress says
    // nothing about the main agent's prompt, and the other way round)
    if (e.hook_event_name === "PreToolUse" || e.hook_event_name === "Stop" || e.hook_event_name === "SubagentStop" || e.hook_event_name === "UserPromptSubmit" || e.hook_event_name === "SessionEnd") movedOn(e.session_id, payload.at, e.agent_id)
    if (!payload.local) {
      if (!e.agent_id) remoteHandler(payload)
      return
    }
    // a subagent's tool calls are not the session's state (the session may be waiting for you)
    const st = e.agent_id ? undefined : stateOf(e, payload.at)
    if (st) {
      hookState.set(e.session_id, st)
      requestSync()
    }
    if (e.cwd && payload.git) gitFromPorcelain("", e.cwd, payload.git)
    // a finished turn may have committed or pushed: read the folder again (worktrees, branches)
    if (e.cwd && (e.hook_event_name === "Stop" || e.hook_event_name === "SessionEnd")) void readGit([e.cwd], undefined, true)
  })
}
