import type { PendingRequest, Session, Subagent } from "./model"
import { plural } from "./format"
import type { OutcomeTone } from "./outcome"

export type WhereTone = "perm" | "input" | "error" | "done" | "open" | "muted" | "faint"

/**
 * "Where is this session?" in one short line: what it asks, the error, what it is doing, or how it
 * ended. The owner's main orientation question; shown on overview cards and in the
 * session list's hover card. `childWaiting`: a subagent of this session waits for a permission.
 */
export function whereItIs(s: Session, req?: PendingRequest, childWaiting?: Subagent): { text: string; tone: WhereTone; mono?: boolean } {
  switch (s.status) {
    case "waiting_permission": {
      if (req?.type === "permission" && req.subject?.type === "command") return { text: req.subject.command, tone: "perm", mono: true }
      if (req?.type === "permission" && req.subject?.type === "tool_call" && req.subject.path) return { text: `Edit ${req.subject.path}`, tone: "perm" }
      return { text: s.waitingFor?.summary ?? "Needs permission", tone: "perm" }
    }
    case "waiting_input":
      return s.waitingFor?.kind === "plan"
        ? { text: "Plan ready for review", tone: "input" }
        : { text: s.waitingFor?.summary ?? "Has a question", tone: "input" }
    case "error":
      return { text: s.errorMessage ?? "Stopped with an error", tone: "error" }
    case "working":
    case "starting":
      if (childWaiting) return { text: `${childWaiting.agentType} needs permission`, tone: "perm" }
      // started outside the app: say where it runs (you approve there, not here)
      if (s.control === "observed") return { text: `In your terminal · ${s.activity ?? "working"}`, tone: "muted" }
      return { text: s.activity ?? (s.status === "starting" ? "Starting" : "Working"), tone: "muted" }
    case "done_unseen":
    case "idle":
    case "stopped":
      if (s.backgroundTasks > 0) return { text: `${plural(s.backgroundTasks, "background task")} running`, tone: "faint" }
      // how its work ended (red / yellow / green), then the last thing it said
      if (s.outcome) return { text: s.activity ? `${s.outcome.label} · ${s.activity}` : s.outcome.label, tone: OUTCOME_WHERE[s.outcome.tone] }
      if (s.status === "done_unseen") return { text: s.diff.filesChanged ? `Done · ${plural(s.diff.filesChanged, "file")} changed` : "Done", tone: "done" }
      if (s.status === "stopped") return { text: s.activity ? `Stopped · ${s.activity}` : "Not running", tone: "faint" }
      // where it stopped: the last thing it said (real sessions), else what changed
      if (s.activity) return { text: s.activity, tone: "faint" }
      return { text: s.diff.filesChanged ? `${plural(s.diff.filesChanged, "file")} changed` : "", tone: "faint" }
  }
}

const OUTCOME_WHERE: Record<OutcomeTone, WhereTone> = { red: "error", orange: "perm", yellow: "open", green: "done" }

export const WHERE_TONE_CLASS: Record<WhereTone, string> = {
  perm: "text-st-perm-fg",
  input: "text-st-perm-fg",
  open: "text-st-input-fg",
  error: "text-st-error-fg",
  done: "text-st-done-fg",
  muted: "text-muted-foreground",
  faint: "text-muted-foreground/70",
}
