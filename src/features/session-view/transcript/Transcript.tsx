// Adapted from BloopAI/vibe-kanban@5f06193:packages/web-core/src/features/workspace-chat/ui/ConversationListContainer.tsx (Apache-2.0). Modified for session-dashboard.
// Older turns inside TanStack Virtual, the live tail (last turn) rendered after the
// virtualizer, a bottom lock and a jump-to-latest affordance. Changes: our row model,
// turn blocks as virtual items, memoized rows that select their own item.
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowDown } from "lucide-react"
import type { ID } from "@/lib/model"
import { getApp, useApp } from "@/store/app"
import { EmptyState } from "@/components/common/bits"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useTranscriptShape } from "../sessionStore"
import { buildRows, groupBlocks, tailStartIndex, type Block, type Row, type TranscriptView } from "./rowModel"
import { DoneLine, LiveSpinner } from "./Spinner"
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
      return <DoneLine turnId={row.turnId} durationMs={row.durationMs} at={row.at} />
    case "receipt":
      return <ReceiptRow sessionId={sessionId} receipt={row.receipt} />
  }
})

const BlockView = memo(function BlockView({ sessionId, block, liveItemId, inTail, view }: ViewProps & { block: Block }) {
  // group/turn: the turn receipt shows only while the pointer is over its turn
  return (
    <div className="group/turn">
      {block.rows.map((row) => (
        <RowView key={row.key} sessionId={sessionId} row={row} liveItemId={liveItemId} inTail={inTail} view={view} />
      ))}
    </div>
  )
})

const COLUMN = "mx-auto w-full max-w-[var(--chat-w)] px-5"

export const Transcript = memo(function Transcript({ sessionId }: { sessionId: ID }) {
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
  const { virtualItems, totalSize, measureElement, scrollToBottom, isAtBottom } = useTranscriptVirtualizer({
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

  // The scroll container always renders so the virtualizer's listeners attach on mount.
  return (
    <div className="relative min-h-0 flex-1">
      {/* role=log implies aria-live=polite, which would read every streamed token: turned off here;
          StatusAnnouncer speaks state changes instead. Focusable so the keyboard can scroll it. */}
      <div
        ref={scrollRef}
        role="log"
        aria-label="Session transcript"
        aria-live="off"
        tabIndex={0}
        className="absolute inset-0 overflow-y-auto outline-none [overflow-anchor:none] focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-inset"
      >
        {ready && !rows.length && <EmptyState>No messages yet.</EmptyState>}
        {!ready && <TranscriptSkeleton />}
        <div ref={contentRef} className="pb-8">
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
            <LiveSpinner sessionId={sessionId} />
          </div>
        </div>
      </div>
      <ViewNotice view={view} />
      {!isAtBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          aria-label="Jump to latest message"
          className="absolute bottom-3 left-1/2 inline-flex h-6 -translate-x-1/2 items-center gap-1 rounded-md border border-border bg-muted px-2 text-xs text-muted-foreground shadow-md outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ArrowDown size={12} aria-hidden /> Latest
        </button>
      )}
    </div>
  )
})

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
      className="sd-view-notice pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1 text-xs text-muted-foreground shadow-md"
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
          <Skeleton className="h-9 w-64 self-end rounded-lg" />
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
