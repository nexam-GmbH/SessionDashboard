// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-chat/index.tsx (ThinkingBlock, WorkActivity, Apache-2.0). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/views/chat/messages/{work-block,reasoning-block,turn-receipt}.tsx
// (Apache-2.0) and BloopAI/vibe-kanban@5f06193:packages/ui/src/components/{ChatAggregatedToolEntries,ChatCollapsedThinking}.tsx (Apache-2.0).
// Changes: each row is memoized and selects only its own item by id, so
// only the live agent message re-renders while streaming; "Worked for 2m 14s · 9 tools"
// groups start collapsed and keep the last tool visible while the turn runs; calm
// rules: user messages are label-less bubbles with the time on hover, receipts
// show only while hovering their turn, diff stats on hover; notices carry a retry.
import { memo, useState } from "react"
import { Check, Copy, FileDiff, History, OctagonX, Paperclip, TriangleAlert } from "lucide-react"
import type { ID, ToolCall, Turn } from "@/lib/model"
import { useApp } from "@/store/app"
import { openReview, sendMessage } from "@/store/actions"
import { DiffStat } from "@/components/common/bits"
import { useNow } from "@/components/common/RelativeTime"
import { capabilities } from "@/lib/status"
import { compact, plural, usd } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Chevron } from "../common"
import { Markdown } from "../markdown/Markdown"
import { CachedMarkdown } from "../markdown/CachedMarkdown"
import { useCoalescedItem, useExpanded, useItem, useItems } from "../sessionStore"
import { ToolRow } from "../tools/ToolRow"
import { Pictures, SharedFiles } from "./Media"
import { formatWorkDuration, summarizeWork } from "../tools/toolSummary"

// ---------- user ----------
// One shared formatter: toLocaleTimeString per row is slow when many rows mount at once.
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" })
export const UserRow = memo(function UserRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useItem(sessionId, itemId)
  const canRewind = useApp((s) => {
    const c = s.sessions[sessionId]?.control
    return c ? capabilities(c).changeSettings : false
  })
  if (item?.type !== "user_message") return null
  return (
    <div className="group/user flex items-start justify-end gap-2 pt-3 pb-2">
      {/* on hover: time, Copy and "Rewind to here" (Claude Code desktop's per-message rewind) */}
      <div className="mt-1.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-within:opacity-100">
        <time className="tabular mr-1 text-xs text-muted-foreground/70" dateTime={item.at}>
          {TIME.format(new Date(item.at))}
        </time>
        <CopyButton text={item.text} />
        {canRewind && (
          <button
            type="button"
            title="Rewind to here"
            aria-label="Rewind to here"
            onClick={() => window.dispatchEvent(new CustomEvent("sd:rewind", { detail: { sessionId, turnId: item.turnId } }))}
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground/70 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <History size={11} />
          </button>
        )}
      </div>
      <div className="max-w-[85%] min-w-0 rounded-md bg-muted px-3 py-1.5">
        {item.images && item.images.length > 0 && <Pictures pictures={item.images} className={item.text ? "mb-1.5" : "my-0.5"} />}
        {item.text && <div className="text-sm leading-[20px] whitespace-pre-wrap text-foreground select-text">{item.text}</div>}
        {item.attachments && item.attachments.length > 0 && (
          <div className="mt-1 mb-0.5 flex flex-wrap gap-1">
            {item.attachments.map((a) => (
              <span key={a} className="inline-flex h-5 items-center gap-1 rounded-sm border border-border px-1.5 font-mono text-xs text-muted-foreground">
                <Paperclip size={10} /> {a}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

// ---------- files Claude handed you ----------
export const FilesRow = memo(function FilesRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useItem(sessionId, itemId)
  if (item?.type !== "tool_call" || !item.call.files?.length) return null
  return <SharedFiles sessionId={sessionId} files={item.call.files} caption={item.call.caption} />
})

// ---------- agent message ----------
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      title="Copy message"
      aria-label={done ? "Copied" : "Copy message"}
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
      className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground/70 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    >
      {done ? <Check size={11} /> : <Copy size={11} />}
    </button>
  )
}

export const AgentRow = memo(function AgentRow({ sessionId, itemId, eager }: { sessionId: ID; itemId: ID; eager?: boolean }) {
  const item = useItem(sessionId, itemId)
  if (item?.type !== "agent_message") return null
  return (
    <div className="group/msg relative py-1.5">
      <CachedMarkdown cacheKey={itemId} content={item.text} eager={eager} />
      <div className="absolute -top-1 right-0 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100">
        <CopyButton text={item.text} />
      </div>
    </div>
  )
})

/** The live item: coalesced to ≤1 commit per frame, streamdown in streaming mode. */
export const LiveAgentRow = memo(function LiveAgentRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useCoalescedItem(sessionId, itemId)
  if (item?.type !== "agent_message") return null
  return (
    <div className="py-1.5">
      <Markdown content={item.text} streaming={item.streaming} />
    </div>
  )
})

// ---------- thought ----------
/** "Thinking" while the duration is unknown, "Thought for Ns" once it is (Cline formatThoughtLabel). */
function thoughtLabel(ms?: number) {
  if (ms === undefined) return "Thinking"
  return `Thought for ${ms === 0 ? 0 : Math.max(1, Math.round(ms / 1000))}s`
}

export const ThoughtRow = memo(function ThoughtRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useItem(sessionId, itemId)
  const [open, setOpen] = useExpanded(`th:${itemId}`)
  if (item?.type !== "thought") return null
  return (
    <div className="py-px">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group/th -ml-1 flex h-7 items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground/80 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span>{thoughtLabel(item.durationMs)}</span>
        <Chevron open={open} className="opacity-60 group-hover/th:opacity-100" />
      </button>
      {open && (
        <div className="ml-[3px] border-l border-border py-1 pl-3">
          <Markdown content={item.text} className="sd-markdown-muted" />
        </div>
      )}
    </div>
  )
})

// ---------- tool group ----------
/** Ticking duration, only mounted for active groups (finished ones don't subscribe to the clock). */
function Elapsed({ since }: { since: number }) {
  const now = useNow()
  return <>{formatWorkDuration(Math.max(0, now - (since || now)))}</>
}

function groupStats(calls: (ToolCall | undefined)[]) {
  let start = Infinity
  let end = 0
  let running = false
  let waiting = false
  let failed = 0
  let added = 0
  let removed = 0
  for (const c of calls) {
    if (!c) continue
    start = Math.min(start, Date.parse(c.startedAt))
    if (c.completedAt) end = Math.max(end, Date.parse(c.completedAt))
    if (c.display === "running") running = true
    if (c.display === "awaiting_permission") waiting = true
    if (c.display === "failed") failed++
    for (const d of c.diff ?? []) {
      added += d.added
      removed += d.removed
    }
  }
  return { start, end, running, waiting, failed, added, removed }
}

export const ToolGroupRow = memo(function ToolGroupRow({
  sessionId,
  itemIds,
  groupKey,
  live,
}: {
  sessionId: ID
  itemIds: ID[]
  groupKey: string
  live: boolean
}) {
  const items = useItems(sessionId, itemIds)
  const [open, setOpen] = useExpanded(groupKey, false)
  const calls = items.map((it) => (it?.type === "tool_call" ? it.call : undefined))
  const st = groupStats(calls)
  const active = live && (st.running || st.waiting)
  const start = Number.isFinite(st.start) ? st.start : 0
  // While the turn runs, the last tool stays visible under the collapsed header: it is what Claude is doing now.
  const lastId = live ? itemIds.at(-1) : undefined
  return (
    <div className="py-px">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group/grp -ml-1 flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-sm text-muted-foreground/80 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className={cn("min-w-0 truncate", active && "text-muted-foreground")}>
          {summarizeWork(calls.filter((c): c is ToolCall => !!c))}
          {active && (
            <span className="tabular text-muted-foreground/70">
              {" · "}
              <Elapsed since={start} />
            </span>
          )}
          {st.failed > 0 && <span className="text-st-error-fg"> · {st.failed} failed</span>}
        </span>
        {(st.added > 0 || st.removed > 0) && <DiffStat added={st.added} removed={st.removed} className="ml-1 shrink-0" />}
        <Chevron open={open} className="opacity-60 group-hover/grp:opacity-100" />
      </button>
      {open ? (
        <div className="ml-[3px] flex flex-col border-l border-border pl-2">
          {itemIds.map((id) => (
            <ToolRow key={id} sessionId={sessionId} itemId={id} />
          ))}
        </div>
      ) : (
        lastId && (
          <div className="ml-[3px] flex flex-col border-l border-border pl-2">
            <ToolRow sessionId={sessionId} itemId={lastId} />
          </div>
        )
      )}
    </div>
  )
})

export const SingleToolRow = memo(function SingleToolRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  return (
    <div className="py-px">
      <ToolRow sessionId={sessionId} itemId={itemId} />
    </div>
  )
})

// ---------- compaction ----------
export const CompactionRow = memo(function CompactionRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useItem(sessionId, itemId)
  if (item?.type !== "compaction") return null
  return (
    <div className="flex items-center gap-3 py-3 text-xs text-muted-foreground/70">
      <div className="h-px flex-1 bg-border" />
      <span title={`${item.trigger === "auto" ? "Automatic" : "Manual"} · ${compact(item.preTokens)} tokens summarized`}>Context compacted</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
})

// ---------- notice ----------
export const NoticeRow = memo(function NoticeRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useItem(sessionId, itemId)
  const canSend = useApp((s) => {
    const c = s.sessions[sessionId]?.control
    return c ? capabilities(c).send : false
  })
  if (item?.type !== "notice") return null
  if (item.severity === "info") {
    return <div className="py-1 text-xs text-muted-foreground/70 select-text">{item.text}</div>
  }
  const Icon = item.severity === "error" ? OctagonX : TriangleAlert
  return (
    <div className="py-1.5">
      <div
        className={cn(
          "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs",
          item.severity === "error" ? "border-st-error/35 bg-st-error-tint text-st-error-fg" : "border-st-input/30 bg-st-input-tint text-st-input-fg",
        )}
      >
        <Icon size={13} className="mt-[3px] shrink-0" />
        <span className="min-w-0 flex-1 leading-[19px] select-text">{item.text}</span>
        {item.severity === "error" && canSend && (
          <button
            type="button"
            onClick={() => sendMessage(sessionId, "continue", "now")}
            className="h-5 shrink-0 rounded-sm border border-st-error/40 px-1.5 text-xs text-st-error-fg outline-none hover:border-st-error/70 focus-visible:ring-1 focus-visible:ring-ring"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
})

// ---------- turn receipt ----------
/** One muted line, visible only while the pointer is over its turn (BlockView sets group/turn). */
export const ReceiptRow = memo(function ReceiptRow({ sessionId, receipt }: { sessionId: ID; receipt: NonNullable<Turn["receipt"]> }) {
  return (
    <div
      className="flex h-6 items-center gap-1.5 text-xs text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 focus-within:opacity-100"
      title={`${compact(receipt.tokens)} tokens`}
    >
      <span className="tabular">{formatWorkDuration(receipt.durationMs)}</span>
      <span>·</span>
      <span className="tabular">{usd(receipt.costUsd)}</span>
      {receipt.filesChanged > 0 && (
        <>
          <span>·</span>
          <button
            type="button"
            onClick={() => openReview(sessionId)}
            className="inline-flex items-center gap-1 rounded-sm px-1 outline-none hover:bg-accent hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <FileDiff size={11} />
            {plural(receipt.filesChanged, "file")}
          </button>
        </>
      )}
    </div>
  )
})
