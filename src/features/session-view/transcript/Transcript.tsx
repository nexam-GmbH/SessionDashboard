// Adapted from BloopAI/vibe-kanban@5f06193:packages/web-core/src/features/workspace-chat/ui/ConversationListContainer.tsx (Apache-2.0). Modified for session-dashboard.
// Older turns inside TanStack Virtual, the live tail (last turn) rendered after the
// virtualizer, a bottom lock and a jump-to-latest affordance. Changes: our row model,
// turn blocks as virtual items, memoized rows that select their own item.
import { memo, useLayoutEffect, useMemo, useRef } from "react"
import { ArrowDown } from "lucide-react"
import type { ID } from "@/lib/model"
import { getApp } from "@/store/app"
import { EmptyState } from "@/components/common/bits"
import { useTranscriptShape } from "../sessionStore"
import { buildRows, groupBlocks, tailStartIndex, type Block, type Row } from "./rowModel"
import { useTranscriptVirtualizer } from "./useTranscriptVirtualizer"
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
} from "./rows"

const RowView = memo(function RowView({ sessionId, row, liveItemId, inTail }: { sessionId: ID; row: Row; liveItemId?: ID; inTail?: boolean }) {
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
      return <ThoughtRow sessionId={sessionId} itemId={row.itemId} />
    case "tools":
      return <ToolGroupRow sessionId={sessionId} itemIds={row.itemIds} groupKey={row.key} live={row.live} />
    case "tool":
      return <SingleToolRow sessionId={sessionId} itemId={row.itemId} />
    case "compaction":
      return <CompactionRow sessionId={sessionId} itemId={row.itemId} />
    case "notice":
      return <NoticeRow sessionId={sessionId} itemId={row.itemId} />
    case "receipt":
      return <ReceiptRow sessionId={sessionId} receipt={row.receipt} />
  }
})

const BlockView = memo(function BlockView({ sessionId, block, liveItemId, inTail }: { sessionId: ID; block: Block; liveItemId?: ID; inTail?: boolean }) {
  // group/turn: the turn receipt shows only while the pointer is over its turn
  return (
    <div className="group/turn">
      {block.rows.map((row) => (
        <RowView key={row.key} sessionId={sessionId} row={row} liveItemId={liveItemId} inTail={inTail} />
      ))}
    </div>
  )
})

const COLUMN = "mx-auto w-full max-w-[860px] px-5"

export const Transcript = memo(function Transcript({ sessionId }: { sessionId: ID }) {
  const { ready, order, turns, liveItemId } = useTranscriptShape(sessionId)
  // Rows depend on item *types* only, which never change: recompute on append, not on stream ticks.
  const rows = useMemo(() => buildRows(order, getApp().transcripts[sessionId]?.items ?? {}, turns), [order, turns, sessionId])
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

  // Open at the latest message.
  useLayoutEffect(() => {
    if (ready) scrollToBottom("auto")
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
        <div ref={contentRef} className="pt-1 pb-6">
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
                      <BlockView sessionId={sessionId} block={block} liveItemId={liveItemId} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <div className={COLUMN}>
            {tail.map((block) => (
              <BlockView key={block.key} sessionId={sessionId} block={block} liveItemId={liveItemId} inTail />
            ))}
          </div>
        </div>
      </div>
      {!isAtBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          aria-label="Jump to latest message"
          className="absolute bottom-3 left-1/2 inline-flex h-6 -translate-x-1/2 items-center gap-1 rounded-[4px] border border-line bg-elevated px-2 text-[11px] text-fg-muted shadow-md outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ArrowDown size={12} aria-hidden /> Latest
        </button>
      )}
    </div>
  )
})
