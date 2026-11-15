// A handoff brief for starting a long session over: the goal, what you asked since, the files it
// changed, the plan, whether checks passed and where it stopped. Built from the transcript (no model
// call, no cost). Long contexts get worse at using what sits in their middle; a fresh session with a
// short brief keeps what matters at the start, where it is used best.
import type { Session, Transcript } from "@/lib/model"
import { deriveChangedFiles } from "./sessionStore"
import { verification } from "./signals"

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+\n/g, "\n").trim()
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t
}

export function buildBrief(s: Session, t: Transcript | undefined, branch?: string): string {
  const prompts: string[] = []
  let last: string | undefined
  if (t) {
    for (const id of t.order) {
      const it = t.items[id]
      if (it?.type === "user_message" && it.text.trim()) prompts.push(it.text)
      else if (it?.type === "agent_message" && !it.streaming && it.text.trim()) last = it.text
    }
  }
  const goal = s.firstPrompt || prompts[0] || s.title
  const later = prompts.slice(prompts[0] === goal ? 1 : 0).slice(-6)
  const files = deriveChangedFiles(t).filter((f) => !f.pending)
  const v = t ? verification(t) : null
  const out: string[] = []
  out.push(`I'm continuing work from an earlier session ("${s.title}") whose conversation got long. This brief replaces it; ask me if something important is missing.`)
  out.push("", "## Goal", clip(goal, 1200))
  if (later.length) out.push("", "## What I asked along the way", ...later.map((p) => `- ${clip(p, 240).replace(/\n+/g, " ")}`))
  if (files.length) {
    const shown = files.slice(0, 15).map((f) => `- ${f.path} (${f.op}, +${f.added} −${f.removed})`)
    out.push("", "## Files changed so far", ...shown)
    if (files.length > 15) out.push(`- and ${files.length - 15} more`)
  }
  if (t?.todos.length) out.push("", "## Plan", ...t.todos.map((x) => `- [${x.status === "completed" ? "x" : " "}] ${x.content}`))
  if (v && v.state !== "none") {
    const line =
      v.state === "passed"
        ? `\`${v.command}\` passed after the last edit.`
        : v.state === "failed"
          ? `\`${v.command}\` failed after the last edit.`
          : v.state === "stale"
            ? `Files were edited after the last check (\`${v.command}\`); it needs to run again.`
            : v.state === "unchecked"
              ? "Nothing was tested or checked after the edits yet."
              : `\`${v.command}\` was running.`
    out.push("", "## Checks", line)
  }
  if (last) out.push("", "## Where it stopped (the last reply)", clip(last, 1200))
  out.push("", `Work in ${s.cwd}${branch ? ` (branch ${branch})` : ""}. Start by looking at the current state (git status, git diff) before changing anything.`)
  return out.join("\n")
}
