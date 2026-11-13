// Adapted from dagster-io/dagster@56029e3:js_modules/ui-core/src/asset-graph/AssetGraphExplorer.tsx (Apache-2.0). Modified for session-dashboard.
// Adapted from nimbalyst/nimbalyst@ab6a549:packages/runtime/src/canvas/canvasCardLod.ts (MIT). Modified for session-dashboard.
// Adapted from xyflow React Flow examples (example-apps.xyflow.com, fetched 2026-11-14):react/examples/interaction/contextual-zoom/ZoomNode.jsx (MIT). Modified for session-dashboard.
// Level of detail for map cards — UI_PLAN §5.1.
//
// Thresholds after Dagster's asset graph (Apache-2.0, dagster-io/dagster@56029e3:
// js_modules/ui-core/src/asset-graph/AssetGraphExplorer.tsx `MINIMAL_SCALE = 0.6`,
// `GROUPS_ONLY_SCALE`): full cards ≥ 0.6, a minimal card below, groups only at the bottom. We use
// 0.3 instead of 0.15: our groups carry more cards, and the calm compact title (26px) drops below
// ~8px on screen under 0.3, the same floor the full tier's 13px titles reach at 0.6. Calm cards
// are ~2.5x denser than the old metric cards, so stopping compact earlier also keeps the number of
// mounted cards (and the paint per pan frame) close to what it was.
//
// Subscription pattern: React Flow's contextual-zoom example (MIT): a *boolean-ish* selector on
// `transform[2]`, so a node re-renders only when its tier flips, not on every wheel frame.
// Hysteresis band idea from Nimbalyst's canvasCardLod.ts (MIT, nimbalyst@ab6a549:
// packages/runtime/src/canvas/canvasCardLod.ts `warmAboveZoom`/`coldBelowZoom`): a viewport
// resting on a threshold must not flip hundreds of cards back and forth on every wheel tick.
import { useDeferredValue } from "react"
import { useStore, type ReactFlowState } from "@xyflow/react"
import { useApp } from "@/store/app"

export type LodTier = "full" | "compact" | "overview"

export const FULL_ZOOM = 0.6
export const COMPACT_ZOOM = 0.3
/** width of the hysteresis band below each threshold */
const BAND = 0.03

/** Pure tier transition with hysteresis: idempotent for a fixed zoom. */
export function nextTier(prev: LodTier | undefined, z: number): LodTier {
  if (z >= FULL_ZOOM) return "full"
  if (z < COMPACT_ZOOM - BAND) return "overview"
  if (z >= COMPACT_ZOOM && z < FULL_ZOOM - BAND) return "compact"
  // inside a band: keep the previous regime when it is adjacent, otherwise take the nearest
  if (z >= FULL_ZOOM - BAND) return prev === "full" ? "full" : "compact"
  return prev === "overview" ? "overview" : "compact"
}

// One shared memory for every node: the selector is called by many subscribers per store update,
// and `nextTier` is idempotent, so all of them agree on the same tier for a given frame.
let current: LodTier | undefined
export const tierSelector = (s: ReactFlowState): LodTier => {
  current = nextTier(current, s.transform[2])
  return current
}

/**
 * The rendering tier for map nodes. Respects Settings → Map default LOD. The value is deferred:
 * crossing a threshold re-renders every mounted card, so React does it at transition priority,
 * time-sliced across frames, instead of blocking the zoom gesture.
 */
export function useLodTier(): LodTier {
  const tier = useStore(tierSelector)
  const pref = useApp((s) => s.settings.mapDefaultLod)
  return useDeferredValue(tier === "overview" || pref === "auto" ? tier : pref)
}

/** Viewport-visibility check for one node (used to run spinners only on screen). */
export function nodeOnScreen(s: ReactFlowState, id: string): boolean {
  const n = s.nodeLookup.get(id)
  if (!n) return false
  const [tx, ty, k] = s.transform
  const { x, y } = n.internals.positionAbsolute
  const w = (n.width ?? n.measured.width ?? 0) * k
  const h = (n.height ?? n.measured.height ?? 0) * k
  const sx = x * k + tx
  const sy = y * k + ty
  return sx < s.width && sx + w > 0 && sy < s.height && sy + h > 0
}
