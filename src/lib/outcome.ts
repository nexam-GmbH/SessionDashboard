// How a session's work ended, shown while it does not run: red when it was cut off (a usage limit,
// an API error, stopped before it finished), yellow while its changes have no PR or merge yet,
// green when it is done (a PR, merged, on the main branch, or it changed nothing). Worked out from
// the transcript and the folder's git, never from what you looked at: it stays after you open the
// session and after a restart, until the work itself is done.
import type { RepoGit } from "./model"
import { plural } from "./format"

export type OutcomeTone = "red" | "yellow" | "green"
export type OutcomeKind = "limit" | "error" | "aborted" | "uncommitted" | "unpushed" | "no_pr" | "pr" | "merged" | "landed" | "removed" | "done" | "marked"

export interface Outcome {
  tone: OutcomeTone
  kind: OutcomeKind
  label: string
}

export interface OutcomeInput {
  apiError?: string
  endedTurn: boolean
  lastRole?: string
  madeChanges?: boolean
  prUrl?: string
  prNumber?: number
  /** the branch it worked on (its transcript's last) */
  branch?: string
  /** its folder's git */
  git?: RepoGit
}

const DEFAULT_BRANCH = /^(main|master|develop|development|dev|trunk)$/

export function outcomeOf(i: OutcomeInput): Outcome {
  if (i.apiError) return /limit/i.test(i.apiError) ? { tone: "red", kind: "limit", label: "Hit the usage limit" } : { tone: "red", kind: "error", label: i.apiError }
  // the last word is the prompt's or a tool's: Claude never answered it (stopped, killed, crashed)
  if (!i.endedTurn && (i.lastRole === "user" || i.lastRole === "tool")) return { tone: "red", kind: "aborted", label: "Stopped before it finished" }
  if (i.prUrl) return { tone: "green", kind: "pr", label: i.prNumber ? `PR #${i.prNumber}` : "PR opened" }
  if (!i.madeChanges) return { tone: "green", kind: "done", label: "Done" }
  const g = i.git
  if (!g) return { tone: "yellow", kind: "no_pr", label: "No PR yet" }
  if (!g.isRepo) return g.error ? { tone: "green", kind: "removed", label: "Folder removed" } : { tone: "green", kind: "done", label: "Done" }
  // the branch it worked on: the one checked out here, or another branch of the repository
  const branch = i.branch && i.branch !== "HEAD" ? i.branch : g.branch
  const here = !branch || branch === g.branch
  if (here && g.changed > 0) return { tone: "yellow", kind: "uncommitted", label: `${plural(g.changed, "file")} not committed` }
  const b = branch ? g.branches?.[branch] : undefined
  const unpushed = here ? g.unpushed : (b?.unpushed ?? 0)
  if (unpushed > 0) return { tone: "yellow", kind: "unpushed", label: `${plural(unpushed, "commit")} not pushed` }
  if (branch && DEFAULT_BRANCH.test(branch)) return { tone: "green", kind: "landed", label: `On ${branch}` }
  // its upstream deleted after the merge, or the branch itself deleted: merged and cleaned up
  if (b?.gone) return { tone: "green", kind: "merged", label: "Branch merged" }
  if (branch && !here && g.branches && !b) return { tone: "green", kind: "merged", label: "Branch deleted" }
  return { tone: "yellow", kind: "no_pr", label: "No PR yet" }
}

/** You marked it done yourself (right-click → Mark as done): green until it works again. */
export const MARKED_DONE: Outcome = { tone: "green", kind: "marked", label: "Marked done" }

export const OUTCOME_COLOR: Record<OutcomeTone, string> = {
  red: "var(--st-error)",
  yellow: "var(--st-input)",
  green: "var(--st-done)",
}
export const OUTCOME_FG: Record<OutcomeTone, string> = {
  red: "var(--st-error-fg)",
  yellow: "var(--st-input-fg)",
  green: "var(--st-done-fg)",
}
export const OUTCOME_TINT: Record<OutcomeTone, string> = {
  red: "var(--st-error-tint)",
  yellow: "var(--st-input-tint)",
  green: "var(--st-done-tint)",
}
