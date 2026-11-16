// Adapted from BloopAI/vibe-kanban@5f06193:packages/web-core/src/features/workspace-chat/model/useConversationVirtualizer.ts (Apache-2.0). Modified for session-dashboard.
// Also adapted from BloopAI/vibe-kanban@5f06193:packages/web-core/src/features/workspace-chat/model/conversation-scroll-commands.ts (Apache-2.0).
// Changes: virtual items are turn blocks; the bottom lock starts engaged (open at the
// latest message) and is released only on user intent; growth outside the virtualizer
// (the streaming tail) re-pins through a ResizeObserver (Cline Conversation idea);
// size estimates are cached per row key.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { useVirtualizer, measureElement as defaultMeasureElement } from "@tanstack/react-virtual"
import type { ID, Item } from "@/lib/model"
import { getApp } from "@/store/app"
import { estimateBlock, type Block } from "./rowModel"

/** Measured block heights per chat, by block key, with the width they were measured at. */
const measuredSizes = new Map<ID, { width: number; sizes: Map<string, number> }>()

/** Pixel distance from the bottom within which the reader counts as "at bottom". */
export const NEAR_BOTTOM_THRESHOLD_PX = 64
const OVERSCAN = 2

export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number) {
  return scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_THRESHOLD_PX
}

export function useTranscriptVirtualizer({
  sessionId,
  rows,
  totalRowCount,
  scrollRef,
  contentRef,
}: {
  sessionId: ID
  /** virtualized head only (turn blocks) */
  rows: Block[]
  /** head + unvirtualized tail: the lock must fire when any row is added */
  totalRowCount: number
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
}) {
  const bottomLockedRef = useRef(true)
  const smoothDeadlineRef = useRef(0)
  // TanStack re-runs estimateSize for every unmeasured row after each measurement,
  // so estimates are cached per row key (and per 40px width bucket); never touch layout here.
  const widthRef = useRef(measuredSizes.get(sessionId)?.width ?? 800)
  const estimatesRef = useRef(new Map<string, number>())
  // sizes measured the last time this chat was on screen (at this width): a chat opened again
  // starts with them instead of estimates, so nothing jumps while it measures itself
  const remembered = measuredSizes.get(sessionId)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index]
      if (!row) return 40
      const known = remembered && remembered.width === widthRef.current ? remembered.sizes.get(row.key) : undefined
      if (known !== undefined) return known
      const hit = estimatesRef.current.get(row.key)
      if (hit !== undefined) return hit
      const items: Record<ID, Item> = getApp().transcripts[sessionId]?.items ?? {}
      const est = estimateBlock(row, items, widthRef.current)
      estimatesRef.current.set(row.key, est)
      return est
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: OVERSCAN,
    measureElement: defaultMeasureElement,
    useAnimationFrameWithResizeObserver: false,
  })

  // Preserve the reader's position only when a row fully above the viewport
  // changes size; compensating for visible rows causes mid-list flicker.
  useEffect(() => {
    // Instance values only: reading scrollHeight here would force a layout per measured row.
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const viewport = instance.scrollRect?.height ?? 0
      const offset = instance.scrollOffset ?? 0
      const total = instance.getTotalSize()
      return !bottomLockedRef.current && item.end <= offset && total - (offset + viewport) > NEAR_BOTTOM_THRESHOLD_PX
    }
    return () => {
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined
    }
  }, [virtualizer, scrollRef])

  const [isAtBottom, setIsAtBottom] = useState(true)
  // more than 200 px up: Claude Code desktop's "Scroll to bottom" shows
  const [farFromBottom, setFarFromBottom] = useState(false)
  const syncIsAtBottom = useCallback(() => {
    const el = scrollRef.current
    const next = bottomLockedRef.current ? true : el ? isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight) : true
    setIsAtBottom((cur) => (cur === next ? cur : next))
    const far = !next && !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 200
    setFarFromBottom((cur) => (cur === far ? cur : far))
  }, [scrollRef])

  const pin = useCallback(() => {
    const el = scrollRef.current
    if (!el || !bottomLockedRef.current || performance.now() < smoothDeadlineRef.current) return
    const max = el.scrollHeight - el.clientHeight
    if (max > 0 && Math.abs(max - el.scrollTop) > 1) el.scrollTop = max
  }, [scrollRef])

  // Release the lock only on user intent (wheel/keys/scrollbar drag/touch moving up):
  // scrollTop also drops when rows above are measured smaller than estimated, and
  // that must not read as the reader leaving the bottom. Re-engage at the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let prev = el.scrollTop
    let intentUntil = 0
    const markIntent = () => {
      intentUntil = performance.now() + 400
    }
    let raf = 0
    const onScroll = () => {
      const cur = el.scrollTop
      const user = performance.now() < intentUntil
      if (bottomLockedRef.current && user && prev - cur > 2) bottomLockedRef.current = false
      const down = cur > prev
      prev = cur
      // Layout reads (scrollHeight) batched into one per frame, after React's commit.
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (!bottomLockedRef.current && user && down && isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight)) {
          bottomLockedRef.current = true
        }
        syncIsAtBottom()
      })
    }
    const onWheel = (e: WheelEvent) => {
      markIntent()
      if (e.deltaY < 0) bottomLockedRef.current = false
    }
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) markIntent()
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") bottomLockedRef.current = false
    }
    let dragging = false
    const onPointerDown = (e: PointerEvent) => {
      // pointer on the scrollbar gutter = drag intent
      if (e.offsetX > el.clientWidth) dragging = true
    }
    const onPointerUp = () => {
      dragging = false
    }
    const onPointerMove = () => {
      if (dragging) markIntent()
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    el.addEventListener("wheel", onWheel, { passive: true })
    el.addEventListener("keydown", onKey)
    el.addEventListener("touchmove", markIntent, { passive: true })
    el.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointermove", onPointerMove, { passive: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      el.removeEventListener("scroll", onScroll)
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("keydown", onKey)
      el.removeEventListener("touchmove", markIntent)
      el.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("pointermove", onPointerMove)
    }
  }, [scrollRef, syncIsAtBottom])

  // Streaming text, expanding rows and async diff rendering grow the content
  // without changing row counts: re-pin on every size change while locked.
  useEffect(() => {
    const content = contentRef.current
    const el = scrollRef.current
    if (!content || !el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth / 40) * 40
      if (w && w !== widthRef.current) {
        widthRef.current = w
        estimatesRef.current.clear()
      }
      if (bottomLockedRef.current) pin()
      else syncIsAtBottom()
    })
    ro.observe(content)
    ro.observe(el)
    return () => ro.disconnect()
  }, [contentRef, scrollRef, pin, syncIsAtBottom])

  // keep what was measured when the chat leaves the screen (a hidden <Activity> runs this cleanup)
  useEffect(
    () => () => {
      const sizes = new Map<string, number>()
      for (const [k, v] of virtualizer.itemSizeCache) sizes.set(String(k), v)
      if (sizes.size) {
        measuredSizes.set(sessionId, { width: widthRef.current, sizes })
        // a few dozen chats at most
        if (measuredSizes.size > 40) measuredSizes.delete(measuredSizes.keys().next().value as ID)
      }
    },
    [virtualizer, sessionId],
  )

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  useLayoutEffect(() => {
    syncIsAtBottom()
    pin()
  }, [rows.length, totalRowCount, totalSize, syncIsAtBottom, pin])

  const scrollToBottom = useCallback(
    (behavior: "auto" | "smooth" = "smooth") => {
      const el = scrollRef.current
      if (!el) return
      bottomLockedRef.current = true
      if (behavior === "smooth") {
        smoothDeadlineRef.current = performance.now() + 450
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
        window.setTimeout(pin, 470)
      } else {
        el.scrollTop = el.scrollHeight - el.clientHeight
      }
      setIsAtBottom(true)
    },
    [scrollRef, pin],
  )

  const releaseBottomLock = useCallback(() => {
    bottomLockedRef.current = false
  }, [])

  const measure = useCallback((node: Element | null) => virtualizer.measureElement(node), [virtualizer])

  return { virtualizer, virtualItems, totalSize, measureElement: measure, scrollToBottom, releaseBottomLock, isAtBottom, farFromBottom }
}
