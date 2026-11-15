// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-chat/index.tsx (ThinkingBlock, WorkActivity, Apache-2.0). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/views/chat/messages/{work-block,reasoning-block,turn-receipt}.tsx
// (Apache-2.0) and BloopAI/vibe-kanban@5f06193:packages/ui/src/components/{ChatAggregatedToolEntries,ChatCollapsedThinking}.tsx (Apache-2.0).
// Changes: laid out like the Claude Code desktop Code tab. User messages are right-aligned bubbles
// with their pictures inside; assistant prose is always shown in full; a run of tool calls is one
// muted line ("Read 3 files, edited 2 files, ran a command +12 −3") that opens to one line per
// call, and while it runs the line says what is happening now, with a spinner; thinking is a
// "Thought for 9s" line; a finished turn that edited files ends with an "Edited N files" card.
// Each row is memoized and selects only its own item by id, so only the live agent message
// re-renders while streaming.
import { memo, useState } from "react"
import { Check, ChevronDown, ChevronRight, Copy, FileDiff, FilePen, GitFork, History, Info, OctagonX, Paperclip, TriangleAlert } from "lucide-react"
import { REAL } from "@/backend/mode"
import type { ID, ToolCall, Turn } from "@/lib/model"
import { useApp } from "@/store/app"
import { forkSession, openReview, openSession, sendMessage } from "@/store/actions"
import { DiffStat } from "@/components/common/bits"
import { Button } from "@/components/ui/button"
import { capabilities } from "@/lib/status"
import { compact, plural, usd } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Chevron, openChatFile, Spin, ToolStatus, useSessionCwd } from "../common"
import { Markdown } from "../markdown/Markdown"
import { CachedMarkdown } from "../markdown/CachedMarkdown"
import { useCoalescedItem, useExpanded, useItem, useItems } from "../sessionStore"
import { ToolRow } from "../tools/ToolRow"
import { ToolLabel } from "../tools/ToolLine"
import { Pictures, SharedFiles } from "./Media"
import { WorkingMark } from "./Spinner"
import { buildToolSummary, formatWorkDuration, relPath, summarizeWork } from "../tools/toolSummary"
import type { TranscriptView } from "./rowModel"

/** The 14px slot at the left of every meta line (chevron, spinner, kind icon): text lines up under it. */
const SLOT = "inline-flex size-3.5 shrink-0 items-center justify-center"
/** A muted one-line row (thinking, tool groups): the whole line toggles, links on it sit above. */
const META_ROW = "group/meta relative -mx-1.5 flex h-7 max-w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-md px-1.5 text-sm text-muted-foreground"
const STRETCHED = "absolute inset-0 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"

// ---------- user ----------
// One shared formatter: toLocaleTimeString per row is slow when many rows mount at once.
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" })
/** A long message folds to this many lines (Claude Code desktop's ⌄ "show more"). */
const FOLD_LINES = 14
const FOLD_CHARS = 1400
const DATE_FULL = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })

/** "Fork from here": a copy of the session up to before this message, the message in its box. */
function forkFromHere(sessionId: ID, itemId: ID) {
  if (REAL) {
    void import("@/backend/real").then((r) => {
      const nid = r.realForkAt(sessionId, itemId)
      if (nid) openSession(nid)
    })
    return
  }
  forkSession(sessionId)
}

const ACTION_BTN =
  "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"

export const UserRow = memo(function UserRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useItem(sessionId, itemId)
  const control = useApp((s) => s.sessions[sessionId]?.control)
  // your own sessions and past ones (rewinding a past one continues it in the app)
  const canRewind = control === "owned" || control === "pty" || (REAL && control === "history")
  const canFork = control !== "cloud"
  const [open, setOpen] = useExpanded(`fold:${itemId}`, false)
  if (item?.type !== "user_message") return null
  const long = item.text.length > FOLD_CHARS || item.text.split("\n").length > FOLD_LINES
  return (
    <div className="group/user flex flex-col items-end pt-6 pb-3">
      <div className="max-w-[85%] min-w-0 rounded-2xl bg-muted px-4 py-2.5">
        {item.images && item.images.length > 0 && <Pictures pictures={item.images} className={item.text ? "mb-2" : "my-0.5"} />}
        {item.text && (
          <div
            className={cn("text-sm leading-relaxed whitespace-pre-wrap text-foreground select-text", item.command && "font-mono text-[13px]", long && !open && "max-h-[19rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]")}
          >
            {item.text}
          </div>
        )}
        {long && (
          <button type="button" onClick={() => setOpen(!open)} className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
            <ChevronDown size={13} className={cn("transition-transform", open && "rotate-180")} /> {open ? "Show less" : "Show more"}
          </button>
        )}
        {item.attachments && item.attachments.length > 0 && (
          <div className="mt-1.5 mb-0.5 flex flex-wrap gap-1">
            {item.attachments.map((a) => (
              <span key={a} className="inline-flex h-5 items-center gap-1 rounded-md bg-background/60 px-1.5 font-mono text-xs text-muted-foreground">
                <Paperclip size={10} /> {a}
              </span>
            ))}
          </div>
        )}
      </div>
      {/* under the bubble on hover: when, Copy, Rewind to here, Fork from here */}
      <div className="mt-1 flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-within:opacity-100">
        <time className="tabular mr-1 text-xs text-muted-foreground/70" dateTime={item.at} title={DATE_FULL.format(new Date(item.at))}>
          {TIME.format(new Date(item.at))}
        </time>
        <CopyButton text={item.text} />
        {canRewind && (
          <button
            type="button"
            title="Rewind to here: back to before this message (conversation, code or both)"
            aria-label="Rewind to here"
            onClick={() => window.dispatchEvent(new CustomEvent("sd:rewind", { detail: { sessionId, turnId: item.turnId } }))}
            className={ACTION_BTN}
          >
            <History size={13} />
          </button>
        )}
        {canFork && (
          <button type="button" title="Fork from here: a copy of the session up to before this message" aria-label="Fork from here" onClick={() => forkFromHere(sessionId, itemId)} className={ACTION_BTN}>
            <GitFork size={13} />
          </button>
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
      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

export const AgentRow = memo(function AgentRow({ sessionId, itemId, eager }: { sessionId: ID; itemId: ID; eager?: boolean }) {
  const item = useItem(sessionId, itemId)
  if (item?.type !== "agent_message") return null
  return (
    <div className="group/msg relative py-2">
      <CachedMarkdown cacheKey={itemId} content={item.text} eager={eager} />
      <div className="absolute top-0 -right-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100">
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
    <div className="py-2">
      <Markdown content={item.text} streaming={item.streaming} />
    </div>
  )
})

// ---------- thought ----------
function thoughtLabel(ms: number | undefined, live: boolean) {
  if (live) return "Thinking…"
  if (ms === undefined) return "Thought"
  return `Thought for ${formatWorkDuration(ms)}`
}

/** "Thought for 9s" (Thinking view: collapsed, Verbose: open); "Thinking…" with a spinner while it lasts. */
export const ThoughtRow = memo(function ThoughtRow({
  sessionId,
  itemId,
  durationMs,
  live,
  view,
}: {
  sessionId: ID
  itemId: ID
  durationMs?: number
  live: boolean
  view: TranscriptView
}) {
  const item = useItem(sessionId, itemId)
  const [open, setOpen] = useExpanded(`th:${view}:${itemId}`, view === "verbose")
  if (item?.type !== "thought") return null
  const label = thoughtLabel(durationMs, live)
  return (
    <div className="py-0.5">
      <div className={cn(META_ROW, "w-fit pr-2 hover:text-foreground")}>
        <button type="button" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)} className={STRETCHED} />
        <span className={SLOT}>{live ? <Spin size={12} /> : <Chevron open={open} />}</span>
        <span className="pointer-events-none">{label}</span>
      </div>
      {open && (
        <div className="ml-[6px] border-l border-border py-1 pr-1 pl-[15px]">
          <Markdown content={item.text} className="sd-markdown-muted" streaming={live} />
        </div>
      )}
    </div>
  )
})

// ---------- tool group ----------
function groupStats(calls: (ToolCall | undefined)[]) {
  let failed = 0
  let denied = 0
  let added = 0
  let removed = 0
  let current: ToolCall | undefined
  for (const c of calls) {
    if (!c) continue
    if (c.display === "running" || c.display === "awaiting_permission") current = c
    if (c.display === "failed") failed++
    if (c.display === "rejected") denied++
    if (c.display === "done" || c.display === "awaiting_permission")
      for (const d of c.diff ?? []) {
        added += d.added
        removed += d.removed
      }
  }
  return { failed, denied, added, removed, current }
}

/**
 * A run of tool calls as one muted line: "Read 3 files, edited 2 files, ran a command +12 −3".
 * While the run is live, the line says what happens now ("Running `npm test`") with a spinner.
 * Open (always in the Verbose view): one line per call.
 */
export const ToolGroupRow = memo(function ToolGroupRow({
  sessionId,
  itemIds,
  groupKey,
  live,
  view,
}: {
  sessionId: ID
  itemIds: ID[]
  groupKey: string
  live: boolean
  view: TranscriptView
}) {
  const items = useItems(sessionId, itemIds)
  const [open, setOpen] = useExpanded(`${groupKey}:${view === "verbose" ? "v" : "n"}`, view === "verbose")
  const calls = items.map((it) => (it?.type === "tool_call" ? it.call : undefined))
  const st = groupStats(calls)
  const summary = summarizeWork(calls.filter((c): c is ToolCall => !!c))
  const now = live ? st.current : undefined
  const nowSummary = now ? buildToolSummary(now) : undefined
  return (
    <div className="py-0.5">
      <div className={cn(META_ROW, "hover:text-foreground")}>
        <button type="button" aria-expanded={open} aria-label={nowSummary ? `${summary}, now: ${nowSummary.verb} ${nowSummary.target?.text ?? ""}` : summary} onClick={() => setOpen(!open)} className={STRETCHED} />
        {now?.display === "running" && (
          <span className={cn(SLOT, "text-spark")}>
            <WorkingMark />
          </span>
        )}
        {now && nowSummary ? (
          <>
            <ToolLabel sessionId={sessionId} summary={nowSummary} />
            {now.display === "awaiting_permission" && <ToolStatus display={now.display} asks={nowSummary.family === "question"} />}
            <span className="pointer-events-none shrink-0 text-xs text-muted-foreground/60">· {plural(itemIds.length, "step")}</span>
          </>
        ) : (
          <span className="pointer-events-none min-w-0 truncate">{summary}</span>
        )}
        {st.failed > 0 && <span className="pointer-events-none shrink-0 text-st-error-fg">· {st.failed} failed</span>}
        {st.denied > 0 && <span className="pointer-events-none shrink-0 text-muted-foreground/70">· {st.denied} denied</span>}
        <DiffStat added={st.added} removed={st.removed} pill className="pointer-events-none shrink-0" />
        {/* "›" after the summary, turning down while open (Claude Code desktop) */}
        <ChevronRight size={14} aria-hidden className={cn("pointer-events-none shrink-0 text-muted-foreground/60 transition-transform duration-150", open && "rotate-90")} />
      </div>
      {open && (
        <div className="ml-[6px] flex flex-col border-l border-border py-0.5 pl-3">
          {itemIds.map((id) => (
            <ToolRow key={id} sessionId={sessionId} itemId={id} />
          ))}
        </div>
      )}
    </div>
  )
})

export const SingleToolRow = memo(function SingleToolRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  return (
    <div className="py-0.5">
      <ToolRow sessionId={sessionId} itemId={itemId} />
    </div>
  )
})

// ---------- what a turn edited ----------
interface EditedFile {
  path: string
  added: number
  removed: number
  created: boolean
}

/** "Edited 3 files" at the end of a finished turn: each file it changed, a click opens it in Review. */
export const EditsCard = memo(function EditsCard({ sessionId, itemIds }: { sessionId: ID; itemIds: ID[] }) {
  const items = useItems(sessionId, itemIds)
  const cwd = useSessionCwd(sessionId)
  const byPath = new Map<string, EditedFile>()
  for (const it of items) {
    // only edits that went through: denied, failed or waiting ones never touched the file
    if (it?.type !== "tool_call" || it.call.display !== "done") continue
    for (const d of it.call.diff ?? []) {
      const f = byPath.get(d.path) ?? { path: d.path, added: 0, removed: 0, created: false }
      f.added += d.added
      f.removed += d.removed
      if (d.op === "add") f.created = true
      byPath.set(d.path, f)
    }
  }
  const files = [...byPath.values()]
  if (!files.length) return null
  const added = files.reduce((a, f) => a + f.added, 0)
  const removed = files.reduce((a, f) => a + f.removed, 0)
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border">
      <div className="flex h-10 items-center gap-2 pr-1.5 pl-3">
        <FilePen size={14} strokeWidth={1.75} className="shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-sm text-foreground">Edited {plural(files.length, "file")}</span>
        <DiffStat added={added} removed={removed} />
        <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => openReview(sessionId)}>
          Review
          <ChevronRight data-icon="inline-end" />
        </Button>
      </div>
      <ul>
        {files.map((f) => {
          const shown = relPath(f.path, cwd)
          const slash = shown.lastIndexOf("/")
          return (
            <li key={f.path} className="border-t border-border">
              <button
                type="button"
                title={`Review ${f.path}`}
                onClick={() => openChatFile(sessionId, f.path, true)}
                className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {slash > 0 && <span className="text-muted-foreground/70">{shown.slice(0, slash + 1)}</span>}
                  {shown.slice(slash + 1)}
                </span>
                {f.created && <span className="shrink-0 text-xs text-muted-foreground/70">new</span>}
                <DiffStat added={f.added} removed={f.removed} className="shrink-0" />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
})

// ---------- compaction ----------
export const CompactionRow = memo(function CompactionRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useItem(sessionId, itemId)
  if (item?.type !== "compaction") return null
  const how = item.trigger === "auto" ? "automatically" : "with /compact"
  return (
    <div className="flex items-center gap-3 pt-4 pb-1 text-xs text-muted-foreground/70" role="separator" aria-label="Session compacted">
      <div className="h-px flex-1 bg-border" />
      <span title={`Compacted ${how}: Claude keeps a summary of the earlier messages`}>
        Compacted session{item.preTokens ? ` · ${compact(item.preTokens)} tokens summarized` : ""}
      </span>
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
  const error = item.severity === "error"
  const Icon = error ? OctagonX : item.severity === "warning" ? TriangleAlert : Info
  const mcp = item.severity === "info" && /\/mcp\b/.test(item.text)
  // the turn you stopped: as Claude Code says it
  const text = item.text === "Interrupted" ? "Interrupted · What should Claude do instead?" : item.text
  return (
    <div
      className={cn(
        "flex min-h-7 items-start gap-2 py-1",
        error ? "text-sm text-st-error-fg" : item.severity === "warning" ? "text-sm text-st-input-fg" : "text-xs text-muted-foreground/70",
      )}
    >
      <span className={cn(SLOT, item.severity === "info" ? "mt-px" : "mt-[3px]")}>
        <Icon size={item.severity === "info" ? 12 : 14} strokeWidth={1.75} aria-hidden />
      </span>
      <span className={cn("min-w-0 flex-1 select-text", item.severity === "info" ? "leading-[18px]" : "leading-relaxed")}>{text}</span>
      {error && canSend && (
        <Button size="xs" variant="outline" className="shrink-0" onClick={() => sendMessage(sessionId, "continue", "now")} title="Sends “continue”: Claude picks up where it stopped">
          Try again
        </Button>
      )}
      {mcp && (
        <Button
          size="xs"
          variant="outline"
          className="-my-0.5 shrink-0"
          onClick={() => void import("@/features/terminal/terminals").then((t) => t.runSlashInTerminal("/mcp", sessionId))}
        >
          Open /mcp
        </Button>
      )}
    </div>
  )
})

// ---------- turn receipt ----------
/** One muted line, visible only while the pointer is over its turn (BlockView sets group/turn). */
export const ReceiptRow = memo(function ReceiptRow({ sessionId, receipt }: { sessionId: ID; receipt: NonNullable<Turn["receipt"]> }) {
  return (
    <div
      className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 focus-within:opacity-100"
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

// ---------- the day changes ----------
const DAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" })
const DAY_FMT_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" })

/** "Today", "Yesterday", "Monday 3 November" between messages of different days. */
export function DateRow({ at }: { at: string }) {
  const d = new Date(at)
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const label = t === start ? "Today" : t === start - 86_400_000 ? "Yesterday" : d.getFullYear() === today.getFullYear() ? DAY_FMT.format(d) : DAY_FMT_YEAR.format(d)
  return (
    <div className="flex items-center gap-3 pt-6 pb-1 text-xs text-muted-foreground/60" role="separator" aria-label={label}>
      <div className="h-px flex-1 bg-border/70" />
      <span>{label}</span>
      <div className="h-px flex-1 bg-border/70" />
    </div>
  )
}
