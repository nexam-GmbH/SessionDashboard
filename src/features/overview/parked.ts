// Sessions that stopped at the plan's usage limit, and continuing a chosen few, one by one, once the
// limit resets. Claude Code's own auto-continue offers it for one session at a time and misfires both
// ways; here you pick which go on and in what order, and they start staggered (many sessions
// starting at the same second of a reset get throttled).
import { create } from "zustand"
import type { ID, Session } from "@/lib/model"
import { getApp } from "@/store/app"
import { continueSession } from "@/store/actions"

// Claude Code's own words when a plan limit stops a turn ("Claude usage limit reached…",
// "You've hit your limit · resets 7pm", "5-hour limit reached ∙ resets 3pm"); not "rate limit",
// which is what half of all API work talks about
const LIMIT = /usage limit reached|hit your (?:[\w-]+ )?limit|(?:5-hour|weekly|session|opus|sonnet) limit reached|limit will reset/i
const STAGGER_MS = 45_000

export function parkedAtLimit(s: Session) {
  if (s.archived || s.role === "main" || s.control === "history" || s.status === "working" || s.status === "starting" || s.status.startsWith("waiting")) return false
  // the limit notice is a short last message of its own, not a sentence inside a long answer
  const last = (s.lastText ?? "").trim()
  return LIMIT.test(s.errorMessage ?? "") || (last.length < 240 && LIMIT.test(last)) || (s.status !== "idle" && LIMIT.test(s.activity ?? ""))
}

interface Plan {
  ids: ID[]
  at: number
}
export const useParkedPlan = create<Plan | null>(() => null)
let timers: ReturnType<typeof setTimeout>[] = []

/**
 * Continue `ids` in this order from `at` on, one every 45 s, on the active account (a session whose
 * process ran on another one restarts under it: lib/accounts).
 */
export function scheduleContinue(ids: ID[], when: number) {
  cancelContinue()
  // 0: now
  const at = when || Date.now()
  useParkedPlan.setState({ ids, at }, true)
  const start = Math.max(0, at - Date.now())
  timers = ids.map((id, i) =>
    setTimeout(() => {
      const s = getApp().sessions[id]
      if (s && parkedAtLimit(s)) continueSession(id)
      if (i === ids.length - 1) useParkedPlan.setState(null, true)
    }, start + i * STAGGER_MS),
  )
}

export function cancelContinue() {
  timers.forEach(clearTimeout)
  timers = []
  useParkedPlan.setState(null, true)
}
