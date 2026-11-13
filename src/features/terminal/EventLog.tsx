import { useEffect, useMemo, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useApp, getApp } from "@/store/app"
import { clockTime } from "@/lib/format"
import { EmptyState } from "@/components/common/bits"
import type { ID } from "@/lib/model"
import { cn } from "@/lib/utils"
import { cmpIso } from "@/features/sessions/search"

/**
 * Events — the normalized event stream of a session (hook events + stream
 * events, RESEARCH §1.3). A debug and trust view: what the backend actually saw.
 */
type Ev = { at: string; type: string; detail: string; tone?: "perm" | "error" | "done" }

function deriveEvents(sessionId: ID): Ev[] {
  const st = getApp()
  const s = st.sessions[sessionId]
  if (!s) return []
  const out: Ev[] = []
  out.push({ at: s.createdAt, type: "SessionStart", detail: `source=${s.control === "history" ? "resume" : "startup"} model=${s.model} cwd=${s.cwd.replace(/^\/home\/[^/]+/, "~")}` })
  const t = st.transcripts[sessionId]
  if (t) {
    for (const id of t.order) {
      const it = t.items[id]
      if (it.type === "user_message") out.push({ at: it.at, type: "UserPromptSubmit", detail: JSON.stringify(it.text.slice(0, 80)) })
      else if (it.type === "tool_call") {
        out.push({ at: it.call.startedAt, type: "PreToolUse", detail: `${it.call.name} tool_use_id=${it.call.id.slice(0, 14)}… ${it.call.title}` })
        if (it.call.display === "awaiting_permission") out.push({ at: it.call.startedAt, type: "PermissionRequest", detail: `${it.call.name} ${it.call.title}`, tone: "perm" })
        else if (it.call.completedAt) out.push({ at: it.call.completedAt, type: it.call.status === "failed" ? "PostToolUseFailure" : "PostToolUse", detail: `${it.call.name} ${it.call.status}`, tone: it.call.status === "failed" ? "error" : undefined })
        if (it.call.subagentId) out.push({ at: it.call.startedAt, type: "SubagentStart", detail: `agent_id=${it.call.subagentId} type=${String(it.call.input.subagent_type ?? "")}` })
      } else if (it.type === "compaction") out.push({ at: it.at, type: "PreCompact", detail: `trigger=${it.trigger} pre_tokens=${it.preTokens}` })
      else if (it.type === "notice" && it.severity === "error") out.push({ at: it.at, type: "StopFailure", detail: it.text, tone: "error" })
    }
    for (const turn of t.turns) if (turn.completedAt && turn.status === "completed") out.push({ at: turn.completedAt, type: "Stop", detail: `turn=${turn.id.slice(-6)} stop_reason=end_turn`, tone: "done" })
  } else {
    out.push({ at: s.updatedAt, type: "UserPromptSubmit", detail: JSON.stringify(s.firstPrompt.slice(0, 80)) })
  }
  if (s.status === "waiting_permission") out.push({ at: s.statusObservedAt, type: "Notification", detail: `notification_type=permission_prompt message="${s.waitingFor?.summary}"`, tone: "perm" })
  if (s.status === "waiting_input") out.push({ at: s.statusObservedAt, type: "Notification", detail: "notification_type=elicitation_dialog", tone: "perm" })
  out.sort((a, b) => cmpIso(a.at, b.at))
  return out
}

// color only for attention (§2.5): permission and failures; everything else neutral
const TONE = { perm: "text-st-perm-fg", error: "text-st-error-fg", done: "text-fg-muted" }

export default function EventLog({ sessionId }: { sessionId: ID | null }) {
  // Re-derive only when this session's status or transcript changes (not on every global tick).
  const version = useApp((s) => {
    if (!sessionId) return ""
    const x = s.sessions[sessionId]
    const t = s.transcripts[sessionId]
    return `${x?.status}:${x?.statusObservedAt}:${t?.order.length ?? 0}:${t?.turns.length ?? 0}`
  })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const events = useMemo(() => (sessionId ? deriveEvents(sessionId) : []), [sessionId, version])
  const ref = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: events.length, getScrollElement: () => ref.current, estimateSize: () => 22, overscan: 20, useFlushSync: false })
  // Log behaviour: newest at the bottom, follow while the user is at the bottom.
  const atBottom = useRef(true)
  useEffect(() => {
    atBottom.current = true
  }, [sessionId])
  useEffect(() => {
    if (atBottom.current && events.length) v.scrollToIndex(events.length - 1, { align: "end" })
  }, [events.length, sessionId, v])
  if (!sessionId) return <EmptyState>No session selected.</EmptyState>
  return (
    // a log for assistive tech, but silent (the stream would be read line by line); focusable so the
    // keyboard can scroll it
    <div
      ref={ref}
      role="log"
      aria-label="Session events"
      aria-live="off"
      tabIndex={0}
      className="absolute inset-0 overflow-auto font-mono text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-inset"
      onScroll={(e) => {
        const el = e.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((vi) => {
          const e = events[vi.index]
          return (
            <div key={vi.key} className="absolute inset-x-0 flex h-[22px] items-center gap-3 px-3 hover:bg-hover" style={{ transform: `translateY(${vi.start}px)` }}>
              <span className="tabular w-11 shrink-0 text-fg-faint">{clockTime(e.at)}</span>
              <span className={cn("w-36 shrink-0", e.tone ? TONE[e.tone] : "text-fg-muted")}>{e.type}</span>
              <span className="truncate text-fg-muted">{e.detail}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
