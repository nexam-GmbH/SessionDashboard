// The live line under the last message while a session works ("1m 12s · Running npm test", with
// Claude Code desktop's turning dots), and under a finished turn how long it took and when.
import { useEffect, useState } from "react"
import { useApp } from "@/store/app"
import { describeActivity, formatWorkDuration } from "../tools/toolSummary"
import type { ID, Transcript } from "@/lib/model"

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" })

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

/** What the session is doing right now, in words (a running tool, thinking, writing). */
function nowDoing(t: Transcript | undefined): string {
  if (!t) return "Working"
  for (let i = t.order.length - 1; i >= Math.max(0, t.order.length - 30); i--) {
    const it = t.items[t.order[i]]
    if (!it) continue
    if (it.type === "tool_call") {
      if (it.call.display === "running" || it.call.display === "awaiting_permission") return describeActivity(it.call)
      break
    }
    if (it.type === "agent_message" && it.streaming) return "Writing"
    if (it.type === "thought") return "Thinking"
    if (it.type === "user_message" || it.type === "agent_message") break
  }
  return t.thinkingNow ? "Thinking" : "Working"
}

/**
 * Claude Code desktop's working mark: four dots turning (stepped, cheap to paint), in Claude's
 * orange. Reduced motion: still.
 */
export function WorkingMark({ still, className }: { still?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden className={className} style={still ? undefined : { animation: "sd-spin 1.2s steps(8) infinite" }}>
      <circle cx="3.5" cy="3.5" r="1.6" fill="currentColor" />
      <circle cx="10.5" cy="3.5" r="1.6" fill="currentColor" opacity="0.55" />
      <circle cx="10.5" cy="10.5" r="1.6" fill="currentColor" />
      <circle cx="3.5" cy="10.5" r="1.6" fill="currentColor" opacity="0.55" />
    </svg>
  )
}

/** The live line while the session works: "1m 12s · Running npm test" (Claude Code desktop). */
export function LiveSpinner({ sessionId }: { sessionId: ID }) {
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const turn = useApp((s) => s.transcripts[sessionId]?.turns.at(-1))
  const since = useApp((s) => s.sessions[sessionId]?.statusObservedAt)
  const doing = useApp((s) => nowDoing(s.transcripts[sessionId]))
  const activity = useApp((s) => s.sessions[sessionId]?.activity)
  const still = useApp((s) => s.settings.reduceMotion)
  const working = status === "working" || status === "starting"
  const now = useClock(1000, working)
  if (!working) return null
  const start = Date.parse(turn?.status === "in_progress" ? turn.startedAt : (since ?? "")) || now
  const secs = Math.max(0, Math.round((now - start) / 1000))
  // what it does now; an API retry or "Starting" from the session itself when the chat has nothing newer
  const what = doing !== "Working" ? doing : activity && /retry|starting|compact/i.test(activity) ? activity : "Working"
  return (
    <div className="flex h-9 min-w-0 items-center gap-2 pt-1 text-sm" role="status" aria-label={`${what}, ${secs} seconds`}>
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-spark">
        <WorkingMark still={still} />
      </span>
      <span className="tabular shrink-0 text-muted-foreground" aria-hidden>
        {secs < 60 ? `${secs}s` : formatWorkDuration(secs * 1000)}
      </span>
      <span className="text-muted-foreground/60" aria-hidden>
        ·
      </span>
      <span className="min-w-0 truncate text-muted-foreground">{what}</span>
    </div>
  )
}

const DATE = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })

/** Under a finished turn: how long it worked and when it finished ("26s · 19:49"). */
export function DoneLine({ durationMs, at }: { turnId: ID; durationMs: number; at?: string }) {
  return (
    <div className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground/60" title={at ? `Finished ${DATE.format(new Date(at))}` : undefined}>
      <span className="tabular">{formatWorkDuration(durationMs)}</span>
      {at && (
        <>
          <span aria-hidden>·</span>
          <time dateTime={at} className="tabular">
            {TIME.format(new Date(at))}
          </time>
        </>
      )}
    </div>
  )
}
