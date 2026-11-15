// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-chat/tool-diff.tsx (Apache-2.0). Modified for session-dashboard.
// Adapted from pingdotgg/t3code@be5f805:apps/web/src/components/DiffWorkerPoolProvider.tsx (MIT). Modified for session-dashboard.
// Our @pierre/diffs setup for the Review screen: one shared
// Shiki worker pool (pierre's singleton; options shared with the session view in
// session-view/tools/diffPool.ts), a readiness gate before the first highlighted render (T3
// Code's DiffWorkerReady), and the Shadow DOM theme set from our tokens through
// pierre's CSS variables (Cline's ToolFileDiff host-variable approach).
import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import type { VirtualFileMetrics } from "@pierre/diffs"
import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react"
import {
  DIFF_THEME,
  DIFF_TOKEN_CSS,
  HIGHLIGHTER_OPTIONS,
  POOL_OPTIONS,
  withTrailingNewline,
} from "@/features/session-view/tools/diffPool"

export { DIFF_THEME, withTrailingNewline }

export function ReviewWorkerPool({
  children,
  fallback,
}: {
  children: ReactNode
  fallback: ReactNode
}) {
  return (
    <WorkerPoolContextProvider
      poolOptions={POOL_OPTIONS}
      highlighterOptions={HIGHLIGHTER_OPTIONS}
    >
      <WorkerReady fallback={fallback}>{children}</WorkerReady>
    </WorkerPoolContextProvider>
  )
}

/** Hold the first render until the pool has initialized (or failed and fallen back to the main thread). */
function WorkerReady({
  children,
  fallback,
}: {
  children: ReactNode
  fallback: ReactNode
}) {
  const pool = useWorkerPool()
  const [readyPool, setReadyPool] = useState<typeof pool>()
  const ready =
    !pool || readyPool === pool || pool.isInitialized() || !pool.isWorkingPool()
  useEffect(() => {
    if (ready || !pool) return
    let alive = true
    const done = () => alive && setReadyPool(pool)
    void pool.initialize().then(done, done)
    return () => {
      alive = false
    }
  }, [ready, pool])
  return ready ? children : fallback
}

/** 12px JetBrains Mono on 18px rows; header height matches FileHeader (30px). */
export const LINE_PX = 18
export const HEADER_PX = 30
export const DIFF_METRICS: VirtualFileMetrics = {
  hunkLineCount: 50,
  lineHeight: LINE_PX,
  diffHeaderHeight: HEADER_PX,
  spacing: 8,
}

/** Host variables: inherited into pierre's Shadow DOM. */
export const DIFF_HOST_STYLE = {
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-header-font-family": "var(--font-sans)",
  "--diffs-font-size": "12px",
  "--diffs-line-height": `${LINE_PX}px`,
  "--diffs-dark-bg": "var(--background)",
  "--diffs-light-bg": "var(--background)",
  "--diffs-tab-size": "2",
  colorScheme: "dark",
} as CSSProperties

/** Injected at pierre's `unsafe` layer: shared token colors plus annotations and clickable line numbers. */
export const DIFF_UNSAFE_CSS = `${DIFF_TOKEN_CSS}
  [data-line-annotation], [data-gutter-buffer='annotation'] { --diffs-annotation-bg: #18191b; }
  [data-column-number] { cursor: pointer; }
`
