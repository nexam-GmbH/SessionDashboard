// The live line under the last message while a session works ("Thinking… · 1m 12s · 1.2k tokens", with
// Claude Code desktop's turning mark).
import { useEffect, useState } from "react"
import { useApp } from "@/store/app"
import { describeActivity, formatWorkDuration } from "../tools/toolSummary"
import { compact } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { ID, Transcript } from "@/lib/model"
import { useStopping } from "../sessionStore"

const clock = () => Date.now()

/** The time, every `ms` while `on`. */
function useClock(ms: number, on: boolean) {
  const [now, set] = useState(clock)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => set(clock()), ms)
    return () => clearInterval(t)
  }, [ms, on])
  return now
}

/** The tool running right now, in words ("Running npm test"), or whether Claude is thinking. */
function nowDoing(t: Transcript | undefined): string {
  if (!t) return ""
  for (let i = t.order.length - 1; i >= Math.max(0, t.order.length - 30); i--) {
    const it = t.items[t.order[i]]
    if (!it) continue
    if (it.type === "tool_call") {
      if (it.call.display === "running" || it.call.display === "awaiting_permission") return `${describeActivity(it.call)}…`
      break
    }
    if (it.type === "thought") return "Thinking"
    if (it.type === "user_message" || it.type === "agent_message") break
  }
  return t.thinkingNow ? "Thinking" : ""
}

/** Claude Code desktop's words for a long think. */
function thinkingLabel(ms: number) {
  return ms >= 60000 ? "Almost done thinking…" : ms >= 45000 ? "Thinking some more…" : ms >= 30000 ? "Thinking more…" : ms >= 15000 ? "Still thinking…" : "Thinking…"
}

/**
 * Claude Code desktop's working mark: four dots turning in Claude's clay, in a 20 px box.
 * Reduced motion: still.
 */
export function WorkingMark({ still, className }: { still?: boolean; className?: string }) {
  return (
    // the box turns, not the <svg> (see index.css: an SVG transform animates on the main thread)
    <span aria-hidden className={className} data-spin={still ? undefined : ""}>
      <svg viewBox="0 0 14 14" width="14" height="14">
        <circle cx="3.5" cy="3.5" r="1.6" fill="currentColor" />
        <circle cx="10.5" cy="3.5" r="1.6" fill="currentColor" opacity="0.55" />
        <circle cx="10.5" cy="10.5" r="1.6" fill="currentColor" />
        <circle cx="3.5" cy="10.5" r="1.6" fill="currentColor" opacity="0.55" />
      </svg>
    </span>
  )
}

const Dot = () => (
  <span className="px-1.5 text-cc-fg3" aria-hidden>
    ·
  </span>
)

/** The live line while the session works: "Running npm test… · 1m 12s · 1.2k tokens" (Claude Code desktop). */
export function LiveSpinner({ sessionId }: { sessionId: ID }) {
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const turn = useApp((s) => s.transcripts[sessionId]?.turns.at(-1))
  const since = useApp((s) => s.sessions[sessionId]?.statusObservedAt)
  const doing = useApp((s) => nowDoing(s.transcripts[sessionId]))
  const activity = useApp((s) => s.sessions[sessionId]?.activity)
  const still = useApp((s) => s.settings.reduceMotion)
  const stopping = useStopping(sessionId)
  const working = status === "working" || status === "starting"
  const now = useClock(1000, working)
  const thinking = working && doing === "Thinking" && !stopping
  const tool = doing && doing !== "Thinking" ? doing : undefined
  const [thinkFrom, setThinkFrom] = useState(0)
  if (thinking && !thinkFrom) setThinkFrom(now)
  else if (!thinking && thinkFrom) setThinkFrom(0)
  // a tool's words stay 2 s after it ends, so quick steps do not flicker
  const [held, setHeld] = useState({ label: "", until: 0 })
  if (tool && (held.label !== tool || held.until !== Infinity)) setHeld({ label: tool, until: Infinity })
  else if (!tool && held.until === Infinity) setHeld({ label: held.label, until: now + 2000 })
  if (!working) return null
  const toolLabel = tool ?? (now < held.until ? held.label : "")
  const start = Date.parse(turn?.status === "in_progress" ? turn.startedAt : (since ?? "")) || now
  const secs = Math.max(0, Math.round((now - start) / 1000))
  // Claude Code desktop's order: Stopping › a retry › compacting › the tool › thinking › starting › Working
  const what = stopping
    ? "Stopping…"
    : activity && /retry/i.test(activity)
      ? activity
      : activity && /compact/i.test(activity)
        ? "Compacting session…"
        : toolLabel
          ? toolLabel
          : thinking
            ? thinkingLabel(now - thinkFrom)
            : status === "starting"
              ? "Starting session…"
              : "Working…"
  // what Claude wrote in this turn so far
  const tokens = turn?.status === "in_progress" ? turn.outputTokens : undefined
  // still going 8 s after Stop (a tool that ignores the interrupt): end the process; the
  // conversation stays and continues when you write again
  const stuck = stopping > 0 && now - stopping > 8000
  return (
    <div className="mt-5 flex min-h-7 min-w-0 items-center gap-2 text-sm text-cc-fg2" role="status" aria-label={`${what}, ${secs} seconds`}>
      <span className="inline-flex size-5 shrink-0 items-center justify-center text-cc-clay">
        <WorkingMark still={still} />
      </span>
      <span className="flex min-w-0 items-center" aria-hidden>
        <span className={cn("min-w-0 truncate", !still && "cc-shimmer")}>{what}</span>
        {secs >= 2 && (
          <>
            <Dot />
            <span className="tabular shrink-0">{secs < 60 ? `${secs}s` : formatWorkDuration(secs * 1000)}</span>
          </>
        )}
        {!!tokens && (
          <>
            <Dot />
            <span className="tabular shrink-0">{tokens === 1 ? "1 token" : `${compact(tokens)} tokens`}</span>
          </>
        )}
      </span>
      {stuck && (
        <button
          type="button"
          onClick={() => void import("@/backend/real").then((r) => r.realStop(sessionId))}
          className="ml-1 h-6 shrink-0 rounded-md px-1.5 text-cc-danger outline-none hover:bg-cc-ghost focus-visible:ring-1 focus-visible:ring-cc-accent"
          title="Ends the process now; the conversation is kept and continues when you write again"
        >
          Force stop
        </button>
      )}
    </div>
  )
}
