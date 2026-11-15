// Claude Code's own voice in the chat: while a session works, the live line under the last message
// ("✻ Drizzling… 12s · Running npm test"), and when a turn ends, "✻ Cooked for 26s · done 19:49".
// The words are the installed claude's (read from it at start, see discover.rs spinner_verbs); the
// glyph steps through the same frames as the terminal.
import { useEffect, useState } from "react"
import { useApp } from "@/store/app"
import { describeActivity, formatWorkDuration } from "../tools/toolSummary"
import type { ID, Transcript } from "@/lib/model"

const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]
const PAST = ["Worked"]
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" })

/** The same word for the same turn, every render. */
function pick(list: string[], seed: string) {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0
  return list[(h >>> 0) % list.length] ?? list[0]
}

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

/** The live line while the session works: Claude Code's verb, for how long, and what it does now. */
export function LiveSpinner({ sessionId }: { sessionId: ID }) {
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const turn = useApp((s) => s.transcripts[sessionId]?.turns.at(-1))
  const since = useApp((s) => s.sessions[sessionId]?.statusObservedAt)
  const doing = useApp((s) => nowDoing(s.transcripts[sessionId]))
  const present = useApp((s) => s.verbs?.present)
  const still = useApp((s) => s.settings.reduceMotion)
  const working = status === "working" || status === "starting"
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!working || still) return
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 120)
    return () => clearInterval(t)
  }, [working, still])
  const now = useClock(1000, working)
  if (!working) return null
  const start = Date.parse(turn?.status === "in_progress" ? turn.startedAt : (since ?? "")) || now
  const secs = Math.max(0, Math.round((now - start) / 1000))
  const verb = present?.length ? pick(present, turn?.id ?? sessionId) : "Working"
  return (
    <div className="flex h-9 min-w-0 items-center gap-2 pt-1 text-sm" role="status" aria-label={`${verb}: ${doing}`}>
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-spark" aria-hidden>
        {still ? "✻" : FRAMES[frame]}
      </span>
      <span className="shrink-0 text-foreground/90">{verb}…</span>
      <span className="tabular shrink-0 text-xs text-muted-foreground/70" aria-hidden>
        {secs < 60 ? `${secs}s` : formatWorkDuration(secs * 1000)}
      </span>
      {doing !== "Working" && <span className="min-w-0 truncate text-muted-foreground">· {doing}</span>}
    </div>
  )
}

/** "✻ Cooked for 26s · done 19:49" after a finished turn. */
export function DoneLine({ turnId, durationMs, at }: { turnId: ID; durationMs: number; at?: string }) {
  const past = useApp((s) => s.verbs?.past) ?? PAST
  return (
    <div className="flex h-7 items-center gap-2 text-xs text-muted-foreground/70">
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
        ✻
      </span>
      <span>
        {pick(past, turnId)} for {formatWorkDuration(durationMs)}
        {at ? ` · done ${TIME.format(new Date(at))}` : ""}
      </span>
    </div>
  )
}
