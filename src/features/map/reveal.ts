// Progressive card reveal after the overview tier (UI_PLAN §8: no main-thread task > 50 ms).
//
// At overview the cards are `hidden`, so zooming back in used to un-hide every card in view at
// once: ~50 cards mounting, measuring and laying out in one store update (one ~160 ms stall in the
// production build on the stress fixture). React Flow mounts nodes from its own store in a sync
// update, so React cannot time-slice that work; instead the canvas un-hides the cards in view a
// few per frame, nearest to the viewport center first, and then the rest at once (those are
// off-screen and culled by `onlyRenderVisibleElements`, so they mount only as they scroll in).
// The chunk size adapts to the measured frame time. Small maps (no culling) skip this entirely.
import { useEffect, useState } from "react"
import type { ID } from "@/lib/model"
import type { LayoutResult } from "./layout"

export type RevealViewport = { transform: [number, number, number]; width: number; height: number }

/** Card ids in view that are still hidden, nearest to the viewport center first. */
function nextChunk(layout: LayoutResult, shown: ReadonlySet<ID>, vp: RevealViewport, max: number): ID[] {
  const [tx, ty, k] = vp.transform
  const x0 = -tx / k
  const y0 = -ty / k
  const x1 = x0 + vp.width / k
  const y1 = y0 + vp.height / k
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hits: { id: ID; d: number }[] = []
  for (const [id, r] of layout.rects) {
    if (r.type === "repo" || r.type === "main" || shown.has(id)) continue
    if (r.x > x1 || r.x + r.w < x0 || r.y > y1 || r.y + r.h < y0) continue
    hits.push({ id, d: (r.x + r.w / 2 - cx) ** 2 + (r.y + r.h / 2 - cy) ** 2 })
  }
  hits.sort((a, b) => a.d - b.d)
  return hits.slice(0, max).map((h) => h.id)
}

/** first chunk, and the bounds the adaptive chunk size moves in */
const FIRST = 8
const MIN = 3
const MAX = 32
/** frame time the chunk size aims at; leaves room for the zoom gesture itself */
const TARGET_MS = 24

/** `at`: frame time of the step that revealed the last chunk (null for the first chunk) */
type RevealState = { overview: boolean; shown: Set<ID> | null; chunk: number; at: number | null }

/**
 * Which cards are un-hidden while the canvas reveals them after leaving overview: a set of ids,
 * or `null` when everything is shown (the steady state).
 */
export function useProgressiveReveal(
  layout: LayoutResult | null,
  overview: boolean,
  enabled: boolean,
  viewport: () => RevealViewport,
): ReadonlySet<ID> | null {
  const [state, setState] = useState<RevealState>({ overview, shown: null, chunk: FIRST, at: null })
  // leaving overview: start with the first chunk in this same render (adjust-state-while-rendering
  // pattern), so the frame that crosses the threshold already shows the nearest cards
  if (state.overview !== overview) {
    const start = !overview && enabled && layout
    setState({ overview, shown: start ? new Set(nextChunk(layout, new Set(), viewport(), FIRST)) : null, chunk: FIRST, at: null })
  }

  const { shown, chunk, at } = state
  useEffect(() => {
    if (!shown || !layout) return
    const t0 = performance.now()
    // one step per frame; the time since the previous step is the frame that carried the last
    // chunk's mount (and the layout of the one before), so the chunk size follows the frame time
    const raf = requestAnimationFrame((t) => {
      const ms = t - (at ?? t0)
      const size = Math.round(Math.min(MAX, Math.max(MIN, ms > TARGET_MS * 1.5 ? chunk / 2 : ms < TARGET_MS ? chunk * 1.5 : chunk)))
      const ids = nextChunk(layout, shown, viewport(), size)
      setState((s) => (s.shown !== shown ? s : { overview: s.overview, shown: ids.length ? new Set([...shown, ...ids]) : null, chunk: size, at: t }))
    })
    return () => cancelAnimationFrame(raf)
  }, [shown, chunk, at, layout, viewport])

  return overview ? null : shown
}
