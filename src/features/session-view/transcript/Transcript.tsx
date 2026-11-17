// Adapted from BloopAI/vibe-kanban@5f06193:packages/web-core/src/features/workspace-chat/ui/ConversationListContainer.tsx (Apache-2.0). Modified for session-dashboard.
// Older turns inside TanStack Virtual, the live tail (last turn) rendered after the
// virtualizer, a bottom lock and a jump-to-latest affordance. Changes: our row model,
// turn blocks as virtual items, memoized rows that select their own item.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { usePendingRequests } from "@/store/selectors"
import { ChevronDown } from "lucide-react"
import { REAL } from "@/backend/mode"
import { FindBar } from "../find/FindBar"
import { paintMatches, useFind, useJump } from "../find/find"
import type { ID } from "@/lib/model"
import { getApp, useApp } from "@/store/app"
import { EmptyState } from "@/components/common/bits"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useTranscriptShape, useUiValue } from "../sessionStore"
import { buildRows, groupBlocks, tailStartIndex, type Block, type Row, type TranscriptView } from "./rowModel"
import { DoneLine, LiveSpinner } from "./Spinner"
import { WaitingMessages } from "./Waiting"
import { useTranscriptVirtualizer } from "./useTranscriptVirtualizer"
import { TRANSCRIPT_VIEWS } from "./view"
import {
  AgentRow,
  CompactionRow,
  LiveAgentRow,
  NoticeRow,
  ReceiptRow,
  SingleToolRow,
  ThoughtRow,
  ToolGroupRow,
  UserRow,
  FilesRow,
  EditsCard,
  DateRow,
} from "./rows"

type ViewProps = { sessionId: ID; liveItemId?: ID; inTail?: boolean; view: TranscriptView }

const RowView = memo(function RowView({ sessionId, row, liveItemId, inTail, view }: ViewProps & { row: Row }) {
  switch (row.kind) {
    case "user":
      return <UserRow sessionId={sessionId} itemId={row.itemId} />
    case "agent":
      return row.itemId === liveItemId ? (
        <LiveAgentRow sessionId={sessionId} itemId={row.itemId} />
      ) : (
        <AgentRow sessionId={sessionId} itemId={row.itemId} eager={inTail} />
      )
    case "thought":
      return <ThoughtRow sessionId={sessionId} itemId={row.itemId} durationMs={row.durationMs} live={row.live} view={view} />
    case "tools":
      return <ToolGroupRow sessionId={sessionId} itemIds={row.itemIds} groupKey={row.key} live={row.live} view={view} />
    case "tool":
      return <SingleToolRow sessionId={sessionId} itemId={row.itemId} />
    case "files":
      return <FilesRow sessionId={sessionId} itemId={row.itemId} />
    case "edits":
      return <EditsCard sessionId={sessionId} itemIds={row.itemIds} />
    case "compaction":
      return <CompactionRow sessionId={sessionId} itemId={row.itemId} />
    case "notice":
      return <NoticeRow sessionId={sessionId} itemId={row.itemId} />
    case "done":
      return <DoneLine sessionId={sessionId} turnId={row.turnId} durationMs={row.durationMs} at={row.at} tokens={row.tokens} />
    case "receipt":
      return <ReceiptRow sessionId={sessionId} receipt={row.receipt} />
    case "date":
      return <DateRow at={row.at} />
  }
})

const BlockView = memo(function BlockView({ sessionId, block, liveItemId, inTail, view }: ViewProps & { block: Block }) {
  // group/turn: the turn receipt shows only while the pointer is over its turn; flow-root keeps
  // the rows' top margins inside the block, so the virtualizer measures them
  return (
    <div className="group/turn flow-root">
      {block.rows.map((row, i) => (
        // data-row-key: search hits and Find scroll to a message by its id
        <div key={row.key} data-row-key={row.key} style={block.gaps[i] ? { marginTop: block.gaps[i] } : undefined}>
          <RowView sessionId={sessionId} row={row} liveItemId={liveItemId} inTail={inTail} view={view} />
        </div>
      ))}
    </div>
  )
})

/** Claude Code desktop's column: 768 px of content (Settings → Chat width) in 32 px gutters, 16 px when the pane is narrow. */
const COLUMN = "mx-auto w-full max-w-[calc(var(--chat-w)+64px)] px-8 @max-[560px]:px-4"

export const Transcript = memo(function Transcript({ sessionId, requests }: { sessionId: ID; requests?: ReactNode }) {
  const { ready, order, turns, liveItemId } = useTranscriptShape(sessionId)
  // Normal: tool calls folded · Thinking: + Claude's thinking · Verbose: every step open (Ctrl+O)
  const view = useApp((s) => s.settings.transcriptView ?? "normal")
  // Rows depend on item *types* only, which never change: recompute on append, not on stream ticks.
  const rows = useMemo(() => buildRows(order, getApp().transcripts[sessionId]?.items ?? {}, turns, view), [order, turns, sessionId, view])
  const blocks = useMemo(() => groupBlocks(rows), [rows])
  const split = useMemo(() => tailStartIndex(blocks, turns), [blocks, turns])
  const head = useMemo(() => blocks.slice(0, split), [blocks, split])
  const tail = useMemo(() => blocks.slice(split), [blocks, split])

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { virtualizer, virtualItems, totalSize, measureElement, scrollToBottom, releaseBottomLock, farFromBottom, fades } = useTranscriptVirtualizer({
    sessionId,
    rows: head,
    totalRowCount: rows.length,
    scrollRef,
    contentRef,
  })

  // Open at the latest message, once: a kept-mounted chat shown again (<Activity>) re-runs its
  // effects, and jumping to the bottom then lost the place you were reading
  const opened = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!ready || opened.current === sessionId) return
    opened.current = sessionId
    scrollToBottom("auto")
  }, [ready, sessionId, scrollToBottom])

  // You sent a message: the chat goes to its end, where it shows (Claude Code desktop)
  const sent = useUiValue<number>(`sent:${sessionId}`, 0)
  useEffect(() => {
    if (sent) scrollToBottom("auto")
  }, [sent, scrollToBottom])

  // A message asked for (a search hit, Find): scroll to it, reading further back first when an old
  // part of a long chat is not loaded yet; then a short glow
  const jump = useJump(sessionId)
  const done = useRef(0)
  const triedLoad = useRef(0)
  const [current, setCurrent] = useState<Element | null>(null)
  useEffect(() => {
    if (!jump || !ready || done.current === jump.n) return
    const has = (b: Block) => b.rows.some((r) => r.key === jump.itemId || ("itemIds" in r && r.itemIds.includes(jump.itemId)) || ("itemId" in r && r.itemId === jump.itemId))
    const bi = blocks.findIndex(has)
    if (bi < 0) {
      if (REAL && triedLoad.current !== jump.n) {
        triedLoad.current = jump.n
        void import("@/backend/real").then((r) => r.realLoadTo(sessionId, jump.itemId))
      }
      return
    }
    done.current = jump.n
    releaseBottomLock()
    if (bi < split) virtualizer.scrollToIndex(bi, { align: "center" })
    let tries = 0
    const reveal = () => {
      const box = scrollRef.current
      const el = box?.querySelector(`[data-row-key="${CSS.escape(jump.itemId)}"]`) ?? box?.querySelector(`[data-index="${bi}"]`)
      if (el && box) {
        const r = el.getBoundingClientRect()
        const b = box.getBoundingClientRect()
        box.scrollTop += r.top - b.top - Math.max(16, (b.height - Math.min(r.height, b.height * 0.8)) / 2)
        el.classList.remove("sd-flash")
        void (el as HTMLElement).offsetWidth
        el.classList.add("sd-flash")
        setCurrent(el)
      } else if (tries++ < 20) requestAnimationFrame(reveal)
    }
    requestAnimationFrame(() => requestAnimationFrame(reveal))
  }, [jump, ready, blocks, split, sessionId, virtualizer, releaseBottomLock])

  // Find: light the words everywhere they are on screen (again as rows mount while scrolling)
  const find = useFind(sessionId)
  useEffect(() => {
    const box = contentRef.current
    if (!find.open || !find.query.trim() || !box) {
      paintMatches(null, "", null)
      return
    }
    let raf = 0
    const paint = () => {
      raf = 0
      paintMatches(box, find.query, current)
    }
    paint()
    const mo = new MutationObserver(() => {
      raf ||= requestAnimationFrame(paint)
    })
    mo.observe(box, { childList: true, subtree: true, characterData: true })
    return () => {
      mo.disconnect()
      if (raf) cancelAnimationFrame(raf)
      paintMatches(null, "", null)
    }
  }, [find.open, find.query, current])

  // The scroll container always renders so the virtualizer's listeners attach on mount.
  return (
    <div className="@container relative min-h-0 flex-1">
      {/* role=log implies aria-live=polite, which would read every streamed token: turned off here;
          StatusAnnouncer speaks state changes instead. Focusable so the keyboard can scroll it. */}
      <div
        ref={scrollRef}
        role="log"
        aria-label="Session transcript"
        aria-live="off"
        tabIndex={0}
        className="absolute inset-0 scroll-pt-8 scroll-pb-12 overflow-y-auto outline-none [overflow-anchor:none] focus-visible:ring-1 focus-visible:ring-cc-accent/60 focus-visible:ring-inset"
      >
        {ready && !rows.length && <EmptyState>No messages yet.</EmptyState>}
        {!ready && <TranscriptSkeleton />}
        <div ref={contentRef} className="pt-6 pb-12">
          {head.length > 0 && (
            <div className="relative w-full" style={{ height: totalSize }}>
              {virtualItems.map((v) => {
                const block = head[v.index]
                if (!block) return null
                return (
                  <div
                    key={block.key}
                    data-index={v.index}
                    ref={measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    <div className={COLUMN}>
                      <BlockView sessionId={sessionId} block={block} liveItemId={liveItemId} view={view} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <div className={COLUMN}>
            {tail.map((block) => (
              <BlockView key={block.key} sessionId={sessionId} block={block} liveItemId={liveItemId} inTail view={view} />
            ))}
            {requests}
            <LiveSpinner sessionId={sessionId} />
            <WaitingMessages sessionId={sessionId} />
          </div>
        </div>
      </div>
      {/* edge fades: strips in the page colour over the scroller (no mask-image: WebKit paints a
          mask offscreen on every frame), clear of its scrollbar */}
      <div aria-hidden className={cn("sd-fade-top pointer-events-none absolute top-0 right-2.5 left-0 h-8", !(fades & 1) && "opacity-0")} />
      <div aria-hidden className={cn("sd-fade-bottom pointer-events-none absolute right-2.5 bottom-0 left-0 h-12", !(fades & 2) && "opacity-0")} />
      <ViewNotice view={view} />
      <FindBar sessionId={sessionId} />
      <JumpToLatest sessionId={sessionId} show={farFromBottom} onClick={() => scrollToBottom("smooth")} />
    </div>
  )
})

/** Back to the end of the chat (Claude Code desktop): a caret pill, or "Needs your input" when a card waits there. */
function JumpToLatest({ sessionId, show, onClick }: { sessionId: ID; show: boolean; onClick: () => void }) {
  const waiting = usePendingRequests(sessionId).length > 0
  return (
    <button
      type="button"
      onClick={onClick}
      inert={!show}
      aria-label={waiting ? "Needs your input. Scroll to the request" : "Scroll to bottom"}
      className={cn(
        "sd-pill absolute bottom-8 left-1/2 z-10 inline-flex h-6 -translate-x-1/2 items-center gap-1.5 rounded-lg px-1.5 text-[13px] text-cc-fg2 outline-none transition-opacity duration-150 focus-visible:ring-1 focus-visible:ring-cc-accent",
        !show && "opacity-0",
      )}
    >
      {waiting && (
        <>
          <span aria-hidden className="size-1.5 rounded-full bg-cc-accent" />
          Needs your input
        </>
      )}
      <ChevronDown size={16} aria-hidden />
    </button>
  )
}

/** After Ctrl+O (or the menu) the view changed: say which one, briefly (it fades out by CSS). */
function ViewNotice({ view }: { view: TranscriptView }) {
  const [prev, setPrev] = useState(view)
  const [changed, setChanged] = useState(0)
  if (prev !== view) {
    setPrev(view)
    setChanged((n) => n + 1)
  }
  if (!changed) return null
  const v = TRANSCRIPT_VIEWS.find((x) => x.id === view)
  return (
    <div
      key={changed}
      role="status"
      className="sd-view-notice pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-cc-raised px-2.5 py-1 text-[13px] text-cc-fg2 shadow-[var(--cc-shadow-panel)]"
    >
      <span className="text-foreground">{v?.label} view</span> · {v?.hint}
    </div>
  )
}

/** While a chat is read: the shape of its latest messages, at the bottom where the chat opens. */
function TranscriptSkeleton() {
  return (
    <div className={cn(COLUMN, "flex min-h-full flex-col justify-end gap-6 pt-6 pb-6")} aria-busy="true" aria-label="Loading the chat">
      {[0, 1].map((k) => (
        <div key={k} className="flex flex-col gap-3">
          <Skeleton className="h-11 w-64 self-end rounded-xl" />
          <Skeleton className="h-4 w-40" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-[92%]" />
            <Skeleton className="h-4 w-[85%]" />
            <Skeleton className="h-4 w-[60%]" />
          </div>
        </div>
      ))}
    </div>
  )
}
