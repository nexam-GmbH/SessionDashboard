// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-chat/index.tsx (ThinkingBlock, WorkActivity, Apache-2.0). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/views/chat/messages/{work-block,reasoning-block,turn-receipt}.tsx
// (Apache-2.0) and BloopAI/vibe-kanban@5f06193:packages/ui/src/components/{ChatAggregatedToolEntries,ChatCollapsedThinking}.tsx (Apache-2.0).
// Changes: laid out like the Claude Code desktop Code tab. User messages are right-aligned bubbles
// with their pictures above and a hover action bar under; assistant prose is always shown in full;
// a run of tool calls is one step row ("Read 3 files, edited 2 files and ran a command +12 −3") that
// opens to one row per call, and while it runs the row says what is happening now; thinking is a
// "Thought for 9s" line; a finished turn that edited files ends with an "Edited N files" card.
// Each row is memoized and selects only its own item by id, so only the live agent message
// re-renders while streaming.
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Brain, Check, Copy, Ellipsis, FileDiff, GitFork, History, Info, OctagonX, Paperclip, RotateCcw, TriangleAlert } from "lucide-react"
import { REAL } from "@/backend/mode"
import type { ID, ToolCall, Turn } from "@/lib/model"
import { getApp, useApp } from "@/store/app"
import { forkSession, openReview, openSession, sendMessage } from "@/store/actions"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { capabilities } from "@/lib/status"
import { compact, plural, usd } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Chevron, openChatFile, ToolIcon, ToolStatus, useSessionCwd } from "../common"
import { Markdown } from "../markdown/Markdown"
import { CachedMarkdown } from "../markdown/CachedMarkdown"
import { useCoalescedItem, useExpanded, useItem, useItems } from "../sessionStore"
import { ToolRow } from "../tools/ToolRow"
import { DiffCount, STEP_BODY, STEP_LABEL, STEP_MARK, STEP_ROW, STEP_TOGGLE, ToolLabel } from "../tools/ToolLine"
import { Pictures, SharedFiles } from "./Media"
import { WorkingMark } from "./Spinner"
import { buildToolSummary, classifyTool, formatWorkDuration, relPath, summarizeWork } from "../tools/toolSummary"
import type { TranscriptView } from "./rowModel"

// ---------- user ----------
// One shared formatter: toLocaleTimeString per row is slow when many rows mount at once.
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" })
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" })
const DATE_FULL = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })

/** "11:06" today, "Yesterday" or "3 Nov" before (the full date is in its title). */
function when(at: string) {
  const d = new Date(at)
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000)
  return days <= 0 ? TIME.format(d) : days === 1 ? "Yesterday" : DAY.format(d)
}

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

/** Ghost icon button of a message's action bar (28 px, Claude Code desktop). */
const ACTION_BTN =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-cc-fg2 outline-none hover:bg-cc-ghost hover:text-foreground focus-visible:ring-1 focus-visible:ring-cc-accent aria-expanded:bg-cc-ghost-sel aria-expanded:text-foreground"

/** A tooltip with a title and, under it, what the action does. */
function Tip({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="flex-col items-start gap-0.5">
        <span>{title}</span>
        {detail && <span className="opacity-70">{detail}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

const chooseAnother = (sessionId: ID, turnId: ID) => setTimeout(() => window.dispatchEvent(new CustomEvent("sd:rewind", { detail: { sessionId, turnId } })), 0)

/**
 * Rewind on a message of yours (Claude Code's own choices): the conversation, the code or both back
 * to before it. Not while Claude works (Claude Code desktop): it would change files under its feet.
 */
function RewindMenu({ sessionId, turnId, busy, onOpenChange }: { sessionId: ID; turnId: ID; busy: boolean; onOpenChange: (open: boolean) => void }) {
  const rewind = (scope: "both" | "conversation" | "code") => void import("../rewind").then((r) => r.rewindTo(sessionId, turnId, scope))
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <Tip title={busy ? "Rewind is unavailable while Claude is working" : "Rewind to here"} detail={busy ? undefined : "Takes this message and everything after it out of the conversation."}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Rewind to here" className={ACTION_BTN}>
            <RotateCcw size={16} />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-64">
        {busy && <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Rewind waits until Claude stops</DropdownMenuLabel>}
        <DropdownMenuItem disabled={busy} onSelect={() => rewind("conversation")}>
          <History /> Rewind conversation to here
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={() => rewind("code")}>
          <FileDiff /> Rewind code to here
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={() => rewind("both")}>
          <History /> Rewind conversation and code
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => chooseAnother(sessionId, turnId)}>
          Choose another message…
          <DropdownMenuShortcut>Esc Esc</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Hidden until the message is hovered or focused, under it (Claude Code desktop): Copy, Rewind, Fork, More, when. */
/** What you may do with a prompt of yours: rewind your own sessions and past ones (rewinding a past one continues it in the app); fork any but a cloud one. */
function usePromptRights(sessionId: ID) {
  const control = useApp((s) => s.sessions[sessionId]?.control)
  const busy = useApp((s) => {
    const st = s.sessions[sessionId]?.status
    return st === "working" || st === "starting" || st === "waiting_permission" || st === "waiting_input"
  })
  return { busy, canRewind: control === "owned" || control === "pty" || (REAL && control === "history"), canFork: control !== "cloud" }
}

/** Rewind and Fork for a prompt: under your message, and again at the end of its reply. */
function PromptActions({ sessionId, itemId, turnId, onOpenChange }: { sessionId: ID; itemId: ID; turnId: ID; onOpenChange?: (open: boolean) => void }) {
  const { busy, canRewind, canFork } = usePromptRights(sessionId)
  return (
    <>
      {canRewind && <RewindMenu sessionId={sessionId} turnId={turnId} busy={busy} onOpenChange={onOpenChange ?? (() => {})} />}
      {canFork && (
        <Tip title="Fork from here" detail="Starts a new session from this point. This one stays as it is.">
          <button type="button" aria-label="Fork from here" className={ACTION_BTN} onClick={() => forkFromHere(sessionId, itemId)}>
            <GitFork size={16} />
          </button>
        </Tip>
      )}
    </>
  )
}

/** Hidden until the message is hovered or focused, under it (Claude Code desktop): Copy, Rewind, Fork, More, when. */
function MessageActions({ sessionId, itemId, turnId, text, at }: { sessionId: ID; itemId: ID; turnId: ID; text: string; at: string }) {
  const { busy, canRewind, canFork } = usePromptRights(sessionId)
  const [menu, setMenu] = useState(false)
  return (
    <div className="sd-msg-actions -mt-1 flex items-center" data-open={menu || undefined}>
      <CopyButton text={text} />
      <PromptActions sessionId={sessionId} itemId={itemId} turnId={turnId} onOpenChange={setMenu} />
      <DropdownMenu onOpenChange={setMenu}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More" title="More" className={ACTION_BTN}>
            <Ellipsis size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(text)}>
            <Copy /> Copy message
          </DropdownMenuItem>
          {canRewind && canFork && (
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => {
                void import("../rewind").then((r) => r.rewindTo(sessionId, turnId, "code"))
                forkFromHere(sessionId, itemId)
              }}
            >
              <GitFork /> Fork conversation and rewind code
            </DropdownMenuItem>
          )}
          {canRewind && (
            <DropdownMenuItem onSelect={() => chooseAnother(sessionId, turnId)}>
              <History /> Rewind to another message…
              <DropdownMenuShortcut>Esc Esc</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <time className="tabular flex h-7 items-center pl-[5px] text-sm text-cc-fg3" dateTime={at} title={DATE_FULL.format(new Date(at))}>
        {when(at)}
      </time>
    </div>
  )
}

export const UserRow = memo(function UserRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useItem(sessionId, itemId)
  const [open, setOpen] = useExpanded(`fold:${itemId}`, false)
  const msg = item?.type === "user_message" ? item : undefined
  // just sent: the bubble pops in once (450 ms overshoot); history mounts still
  const [fresh] = useState(() => !!msg && Date.now() - Date.parse(msg.at) < 3000)
  // over 300 px tall it folds to 200 px; only a message that could be that long is measured
  const textRef = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState(false)
  const maybeTall = !!msg && (msg.text.length > 600 || msg.text.split("\n", 14).length > 13)
  useLayoutEffect(() => {
    if (maybeTall && textRef.current) setTall(textRef.current.scrollHeight > 300)
  }, [maybeTall])
  if (!msg) return null
  const folded = tall && !open
  return (
    <div className="group/user sd-msg flex flex-col items-end gap-2">
      {msg.images && msg.images.length > 0 && <Pictures pictures={msg.images} className="justify-end" />}
      {msg.attachments && msg.attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {msg.attachments.map((a) => (
            <span key={a} className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-lg bg-cc-card px-2 text-[13px] text-cc-fg2 ring-1 ring-cc-wash ring-inset">
              <Paperclip size={13} className="shrink-0" /> <span className="truncate">{a}</span>
            </span>
          ))}
        </div>
      )}
      {msg.text && (
        <div className={cn("flex max-w-[85%] min-w-0 flex-col items-start", fresh && "sd-bubble-in")}>
          <div
            ref={textRef}
            className={cn(
              "relative min-w-0 rounded-xl bg-cc-wash px-4 py-3 text-[15px] leading-[21px] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] select-text",
              msg.command && "font-mono text-[13px] leading-[19px]",
              folded && "max-h-[200px] overflow-hidden",
            )}
          >
            {msg.text}
            {/* a fade into the bubble's colour (a mask-image is an offscreen pass per frame in WebKit) */}
            {folded && <div aria-hidden className="sd-fold pointer-events-none absolute inset-x-0 bottom-0 h-12" />}
          </div>
          {folded && <span className="sr-only">Message collapsed</span>}
          {tall && (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="mt-1 ml-2 h-6 rounded-md px-2 text-[13px] text-cc-fg2 outline-none hover:bg-cc-ghost hover:text-foreground focus-visible:ring-1 focus-visible:ring-cc-accent"
            >
              {open ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
      <MessageActions sessionId={sessionId} itemId={itemId} turnId={msg.turnId} text={msg.text} at={msg.at} />
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
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <>
      <Tip title="Copy message">
        <button
          type="button"
          aria-label="Copy message"
          onClick={() => {
            void navigator.clipboard?.writeText(text)
            setDone(true)
            setTimeout(() => setDone(false), 1200)
          }}
          className={cn(ACTION_BTN, className)}
        >
          {done ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </Tip>
      <span role="status" className="sr-only">
        {done ? "Copied" : ""}
      </span>
    </>
  )
}

export const AgentRow = memo(function AgentRow({ sessionId, itemId, eager }: { sessionId: ID; itemId: ID; eager?: boolean }) {
  const item = useItem(sessionId, itemId)
  if (item?.type !== "agent_message") return null
  return (
    <div className="sd-msg relative">
      <CachedMarkdown cacheKey={itemId} content={item.text} eager={eager} className="sd-reply" />
      <div className="sd-msg-actions absolute -top-1 -right-2">
        <CopyButton text={item.text} />
      </div>
    </div>
  )
})

/** The live item: coalesced to ≤1 commit per frame, streamdown in streaming mode. */
export const LiveAgentRow = memo(function LiveAgentRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useCoalescedItem(sessionId, itemId)
  if (item?.type !== "agent_message") return null
  return <Markdown content={item.text} streaming={item.streaming} className="sd-reply" />
})

// ---------- thought ----------
/** "Copy as quote": the thought as a Markdown quote headed "Thinking (~N tok)". */
function QuoteButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="sd-msg-actions h-7 rounded-lg px-2 text-sm text-cc-fg2 outline-none hover:bg-cc-ghost hover:text-foreground focus-visible:ring-1 focus-visible:ring-cc-accent"
      onClick={() => {
        const quote = `Thinking (~${compact(Math.ceil(text.length / 4))} tok)\n\n${text}`.replace(/^/gm, "> ")
        void navigator.clipboard?.writeText(quote)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? "Copied" : "Copy as quote"}
    </button>
  )
}
function thoughtLabel(ms: number | undefined, live: boolean) {
  if (live) return "Thinking…"
  if (ms === undefined) return "Thought"
  return `Thought for ${formatWorkDuration(ms)}`
}

/** "Thought for 9s" (Thinking view: collapsed, Verbose: open), opening to its "Thought process". */
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
    <div>
      <div className={cn(STEP_ROW, "w-fit pr-1")}>
        <button type="button" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)} className={STEP_TOGGLE} />
        <span className={cn(STEP_MARK, live ? "text-cc-clay" : "text-cc-fg3")}>{live ? <WorkingMark /> : <Brain size={16} strokeWidth={1.75} />}</span>
        <span className={cn(STEP_LABEL, live && "cc-breathe")}>{label}</span>
        <Chevron open={open} />
      </div>
      {open && (
        <div className={cn(STEP_BODY, "sd-msg")}>
          <div className="flex h-7 items-center justify-between text-cc-fg3">
            Thought process
            <QuoteButton text={item.text} />
          </div>
          <div className="whitespace-pre-wrap select-text">{item.text}</div>
        </div>
      )}
    </div>
  )
})

// ---------- tool group ----------
function groupStats(calls: (ToolCall | undefined)[]) {
  let failed = 0
  let finished = 0
  let agents = 0
  let agentsDone = 0
  let denied = 0
  let added = 0
  let removed = 0
  let current: ToolCall | undefined
  for (const c of calls) {
    if (!c) continue
    if (c.display === "running" || c.display === "awaiting_permission") current = c
    if (c.display === "failed") failed++
    if (c.display === "failed" || c.display === "done") finished++
    if (classifyTool(c.name) === "agent") {
      agents++
      if (c.display === "done") agentsDone++
    }
    if (c.display === "rejected") denied++
    if (c.display === "done" || c.display === "awaiting_permission")
      for (const d of c.diff ?? []) {
        added += d.added
        removed += d.removed
      }
  }
  return { failed, finished, agents, agentsDone, denied, added, removed, current }
}

/**
 * A run of tool calls as one step row: "Read 3 files, edited 2 files and ran a command +12 −3".
 * While the run is live, the row says what happens now ("Running `npm test`") with the working
 * mark. Open (always in the Verbose view): one row per call.
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
  const first = calls.find(Boolean)
  return (
    <div>
      <div className={STEP_ROW}>
        <button type="button" aria-expanded={open} aria-label={nowSummary ? `${summary}, now: ${nowSummary.verb} ${nowSummary.target?.text ?? ""}` : summary} onClick={() => setOpen(!open)} className={STEP_TOGGLE} />
        <span className={cn(STEP_MARK, now?.display === "running" && "text-cc-clay")}>
          {now?.display === "running" ? <WorkingMark /> : first && <ToolIcon family={classifyTool(first.name)} name={first.name} />}
        </span>
        {now && nowSummary ? (
          <>
            <ToolLabel sessionId={sessionId} summary={nowSummary} />
            <ToolStatus display={now.display} asks={nowSummary.family === "question"} />
          </>
        ) : (
          <span className={cn(STEP_LABEL, "min-w-0 truncate")}>{summary}</span>
        )}
        {st.failed > 0 && <span className="pointer-events-none shrink-0 text-cc-danger">{st.failed === st.finished ? "Failed" : `${st.failed} failed`}</span>}
        {st.denied > 0 && <span className="pointer-events-none shrink-0 text-cc-danger">{st.denied} denied</span>}
        <Chevron open={open} />
        <span className="tabular pointer-events-none ml-auto flex shrink-0 items-center gap-2 pl-2 text-cc-fg2">
          {st.agents > 1 && st.agentsDone < st.agents && <span>{`${st.agentsDone} of ${st.agents} agents done`}</span>}
          {now && <span>{plural(itemIds.length, "step")}</span>}
          <DiffCount added={st.added} removed={st.removed} />
        </span>
      </div>
      {open && (
        <div className="flex flex-col pl-7">
          {itemIds.map((id) => (
            <ToolRow key={id} sessionId={sessionId} itemId={id} />
          ))}
        </div>
      )}
    </div>
  )
})

export const SingleToolRow = memo(function SingleToolRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  return <ToolRow sessionId={sessionId} itemId={itemId} />
})

// ---------- what a turn edited ----------
interface EditedFile {
  path: string
  added: number
  removed: number
  created: boolean
}

/** "Edited 3 files +12 −3" at the end of a finished turn (Claude Code desktop): up to 3 files, then "Show N more". */
export const EditsCard = memo(function EditsCard({ sessionId, itemIds, turnId }: { sessionId: ID; itemIds: ID[]; turnId: ID }) {
  const items = useItems(sessionId, itemIds)
  // Undo asks Claude, so only on the last turn of a session you can write to that is not busy
  const canUndo = useApp((s) => {
    const ses = s.sessions[sessionId]
    return !!ses && capabilities(ses.control).send && (ses.status === "idle" || ses.status === "done_unseen") && s.transcripts[sessionId]?.turns.at(-1)?.id === turnId
  })
  const cwd = useSessionCwd(sessionId)
  const [all, setAll] = useExpanded(`edits:${itemIds[0]}`, false)
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
  const created = files.filter((f) => f.created).length
  const verb = created === files.length ? "Created" : created ? "Changed" : "Edited"
  const shown = all ? files : files.slice(0, 3)
  return (
    <div className="overflow-hidden rounded-xl bg-cc-card ring-1 ring-cc-wash ring-inset">
      <div className="flex h-10 items-center gap-2 pr-1.5 pl-3 text-sm">
        <span className="text-foreground">
          {verb} {files.length === 1 ? "a file" : `${files.length} files`}
        </span>
        <DiffCount added={added} removed={removed} />
        <span className="ml-auto" />
        {canUndo && (
          <Tip title="Ask Claude to undo this turn’s file changes">
            <button
              type="button"
              onClick={() => sendMessage(sessionId, "Undo the file changes you made in your last turn.", "now")}
              className="h-7 rounded-lg px-2 text-cc-fg2 outline-none hover:bg-cc-ghost hover:text-foreground focus-visible:ring-1 focus-visible:ring-cc-accent"
            >
              Undo
            </button>
          </Tip>
        )}
        <Tip title="View this turn’s changes">
          <button type="button" aria-label="View this turn’s changes" onClick={() => openReview(sessionId)} className={ACTION_BTN}>
            <Chevron open={false} />
          </button>
        </Tip>
      </div>
      <ul>
        {shown.map((f) => {
          const rel = relPath(f.path, cwd)
          const slash = rel.lastIndexOf("/")
          return (
            <li key={f.path}>
              <button
                type="button"
                title={`Review ${f.path}`}
                onClick={() => openChatFile(sessionId, f.path, true)}
                className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left text-sm outline-none hover:bg-cc-card-hover focus-visible:ring-1 focus-visible:ring-cc-accent focus-visible:ring-inset"
              >
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {slash > 0 && <span className="text-cc-fg3">{rel.slice(0, slash + 1)}</span>}
                  {rel.slice(slash + 1)}
                </span>
                {f.created && <span className="shrink-0 text-cc-fg3">new</span>}
                <DiffCount added={f.added} removed={f.removed} />
              </button>
            </li>
          )
        })}
      </ul>
      {files.length > 3 && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="flex h-8 w-full items-center px-3 text-sm text-cc-fg2 outline-none hover:bg-cc-card-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-cc-accent focus-visible:ring-inset"
        >
          {all ? "Show less" : `Show ${files.length - 3} more`}
        </button>
      )}
    </div>
  )
})

// ---------- end of a turn ----------
/** Everything Claude wrote in one turn, its messages one after another (Copy all). */
function turnText(sessionId: ID, turnId: ID): string {
  const t = getApp().transcripts[sessionId]
  const turn = t?.turns.find((x) => x.id === turnId)
  if (!t || !turn) return ""
  return turn.itemIds
    .map((id) => t.items[id])
    .filter((it) => it?.type === "agent_message")
    .map((it) => (it as { text: string }).text.trim())
    .filter(Boolean)
    .join("\n\n")
}

/**
 * Under a finished turn: how long it worked, what it wrote, when ("26s · 1.2k tokens · 19:49"), then
 * the reply's actions (Claude Code desktop): Rewind and Fork for its prompt, and Copy all (Claude's
 * whole answer of that turn).
 */
export const DoneLine = memo(function DoneLine({
  sessionId,
  turnId,
  promptId,
  durationMs,
  at,
  tokens,
}: {
  sessionId: ID
  turnId: ID
  promptId?: ID
  durationMs: number
  at?: string
  tokens?: number
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex h-7 items-center gap-1.5 text-[13px] leading-[17px] text-cc-fg3" title={at ? `Finished ${DATE_FULL.format(new Date(at))}` : undefined}>
      <span className="tabular">{formatWorkDuration(durationMs)}</span>
      {!!tokens && (
        <>
          <span aria-hidden>·</span>
          <span className="tabular">{compact(tokens)} tokens</span>
        </>
      )}
      {at && (
        <>
          <span aria-hidden>·</span>
          <time dateTime={at} className="tabular">
            {TIME.format(new Date(at))}
          </time>
        </>
      )}
      <span className="ml-auto" />
      {promptId && <PromptActions sessionId={sessionId} itemId={promptId} turnId={turnId} />}
      <button
        type="button"
        title="Copy all of Claude's answer in this turn"
        aria-label={copied ? "Copied" : "Copy all"}
        onClick={() => {
          const text = turnText(sessionId, turnId)
          if (!text) return
          void navigator.clipboard?.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
        className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 outline-none hover:bg-cc-ghost hover:text-foreground focus-visible:ring-1 focus-visible:ring-cc-accent"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy all"}
      </button>
    </div>
  )
})

// ---------- compaction ----------
export const CompactionRow = memo(function CompactionRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useItem(sessionId, itemId)
  if (item?.type !== "compaction") return null
  const how = item.trigger === "auto" ? "automatically" : "with /compact"
  return (
    <div className="flex items-center gap-3 text-[13px] text-cc-fg3" role="separator" aria-label="Session compacted">
      <div className="h-px flex-1 bg-cc-wash-2" />
      <span title={`Compacted ${how}: Claude keeps a summary of the earlier messages`}>
        Compacted session{item.preTokens ? ` · ${compact(item.preTokens)} tokens summarized` : ""}
      </span>
      <div className="h-px flex-1 bg-cc-wash-2" />
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
        "flex min-h-7 items-start gap-2 py-1 text-sm leading-5",
        error ? "text-cc-danger" : item.severity === "warning" ? "text-st-input-fg" : "text-cc-fg2",
      )}
    >
      <span className={STEP_MARK}>
        <Icon size={16} strokeWidth={1.75} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 select-text">{text}</span>
      {error && canSend && (
        <Button size="xs" variant="ghost" className="-my-0.5 shrink-0" onClick={() => sendMessage(sessionId, "continue", "now")} title="Sends “continue”: Claude picks up where it stopped">
          Try again
        </Button>
      )}
      {mcp && (
        <Button
          size="xs"
          variant="ghost"
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
      className="flex h-6 items-center gap-1.5 text-[13px] text-cc-fg3 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 focus-within:opacity-100"
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
            className="inline-flex items-center gap-1 rounded-md px-1 outline-none hover:bg-cc-ghost hover:text-foreground focus-visible:ring-1 focus-visible:ring-cc-accent"
          >
            <FileDiff size={13} />
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
    <div className="flex items-center gap-3 text-[13px] text-cc-fg3" role="separator" aria-label={label}>
      <div className="h-px flex-1 bg-cc-wash" />
      <span>{label}</span>
      <div className="h-px flex-1 bg-cc-wash" />
    </div>
  )
}
