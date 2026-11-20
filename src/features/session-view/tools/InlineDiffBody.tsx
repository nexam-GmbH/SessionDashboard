// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-chat/tool-diff.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from BloopAI/vibe-kanban@5f06193:packages/ui/src/components/PierreConversationDiff.tsx (Apache-2.0):
// unsafeCSS overrides, classic indicators, hunk separators dropped for chat rows.
// Changes: themed from our tokens, clamped height with an expand
// control, highlighting through a shared @pierre/diffs worker pool; token overrides
// on `:host` (pierre never sets data-theme-type, so the old selector was ignored).
import { memo, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { parseDiffFromFile } from "@pierre/diffs"
import { FileDiff, WorkerPoolContextProvider } from "@pierre/diffs/react"
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { DIFF_THEME, DIFF_TOKEN_CSS, HIGHLIGHTER_OPTIONS, POOL_OPTIONS, withTrailingNewline } from "./diffPool"
import { LINE_PX } from "./InlineDiff"

// One shared pool (singleton inside @pierre/diffs, options shared with the Review
// screen): Shiki tokenizes off the main thread; components fall back to main-thread
// highlighting if workers fail. This module loads lazily (InlineDiff.tsx), so the pool
// can't wrap the session view from above: each diff joins it through its own provider,
// and the keeper below holds it open while a session view is mounted, so scrolling the
// last diff out of view doesn't tear the workers down.
function DiffWorkerPool({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={POOL_OPTIONS} highlighterOptions={HIGHLIGHTER_OPTIONS}>
      {children}
    </WorkerPoolContextProvider>
  )
}

export function DiffPoolKeeper() {
  return <DiffWorkerPool>{null}</DiffWorkerPool>
}

/**
 * Injected at @pierre/diffs' `unsafe` layer: our token tints (on `:host`), then Claude Code
 * desktop's chat look on top (the page mixed with the diff green / red, 12 % light, 20 % dark;
 * stronger for the changed words), dense rows, classic indicators.
 */
const UNSAFE_CSS = `${DIFF_TOKEN_CSS}
  :host {
    --diffs-bg-context-override: var(--cc-surface) !important;
    --diffs-bg-context-gutter-override: var(--cc-surface) !important;
    --diffs-bg-buffer-override: var(--cc-surface) !important;
    --diffs-bg-addition-override: color-mix(in srgb, var(--cc-add) var(--sd-mix), var(--cc-surface)) !important;
    --diffs-bg-addition-number-override: color-mix(in srgb, var(--cc-add) var(--sd-mix), var(--cc-surface)) !important;
    --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--cc-add) var(--sd-em), var(--cc-surface)) !important;
    --diffs-bg-deletion-override: color-mix(in srgb, var(--cc-del) var(--sd-mix), var(--cc-surface)) !important;
    --diffs-bg-deletion-number-override: color-mix(in srgb, var(--cc-del) var(--sd-mix), var(--cc-surface)) !important;
    --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--cc-del) var(--sd-em), var(--cc-surface)) !important;
    --diffs-dark-addition-color: var(--cc-add) !important;
    --diffs-dark-deletion-color: var(--cc-del) !important;
    --diffs-light-addition-color: var(--cc-add) !important;
    --diffs-light-deletion-color: var(--cc-del) !important;
    --diffs-fg-number-override: var(--cc-fg2) !important;
  }
  [data-code] { padding-bottom: 0 !important; }
  [data-disable-line-numbers][data-indicators='classic'] [data-column-content] { padding-inline-start: calc(2ch + 1ch); }
  [data-disable-line-numbers][data-indicators='classic'] [data-line-type='change-addition'] [data-column-content]::before,
  [data-disable-line-numbers][data-indicators='classic'] [data-line-type='change-deletion'] [data-column-content]::before { left: 1ch; }
`

export default memo(function InlineDiffBody({
  path,
  oldText,
  newText,
  fragment = true,
  maxLines = 12,
  className,
}: {
  path: string
  oldText?: string
  newText: string
  /** Fragments hide line numbers, which would otherwise misleadingly start at 1. */
  fragment?: boolean
  /** Clamp; an expand control reveals the rest. */
  maxLines?: number
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const fileDiff = useMemo(() => {
    try {
      return parseDiffFromFile(
        oldText ? { contents: withTrailingNewline(oldText), name: path } : null,
        { contents: withTrailingNewline(newText), name: path },
      )
    } catch {
      return null
    }
  }, [oldText, newText, path])
  const totalLines = useMemo(() => {
    if (!fileDiff) return 0
    let n = 0
    for (const h of fileDiff.hunks) n += h.unifiedLineCount ?? 0
    return n || newText.split("\n").length
  }, [fileDiff, newText])
  // the app is dark, but the diff follows a light theme if one is ever set
  const dark = document.documentElement.classList.contains("dark")
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      diffIndicators: "classic" as const,
      disableFileHeader: true,
      disableLineNumbers: fragment,
      theme: DIFF_THEME,
      themeType: dark ? ("dark" as const) : ("light" as const),
      overflow: "scroll" as const,
      hunkSeparators: "line-info-basic" as const,
      lineDiffType: "word" as const,
      unsafeCSS: UNSAFE_CSS,
    }),
    [fragment, dark],
  )
  if (!fileDiff) return null
  const clamped = !expanded && totalLines > maxLines
  return (
    <div className={cn("relative overflow-hidden rounded-lg bg-background after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:ring-1 after:ring-cc-wash-2 after:ring-inset", className)}>
      <div style={{ maxHeight: clamped ? maxLines * LINE_PX + 4 : undefined }} className="overflow-hidden">
        <DiffWorkerPool>
        <FileDiff
          fileDiff={fileDiff}
          options={options}
          style={
            {
              "--diffs-font-family": "var(--font-mono)",
              "--diffs-header-font-family": "var(--font-sans)",
              "--diffs-font-size": "13px",
              "--diffs-line-height": `${LINE_PX}px`,
              "--diffs-dark-bg": "var(--cc-surface)",
              "--diffs-light-bg": "var(--cc-surface)",
              "--diffs-tab-size": "2",
              "--sd-mix": dark ? "20%" : "12%",
              "--sd-em": dark ? "32%" : "22%",
              colorScheme: dark ? "dark" : "light",
            } as CSSProperties
          }
        />
        </DiffWorkerPool>
      </div>
      {totalLines > maxLines && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex h-7 w-full items-center justify-center gap-1 border-t border-cc-wash-2 text-sm text-cc-fg3 outline-none hover:bg-cc-ghost hover:text-cc-fg2 focus-visible:ring-1 focus-visible:ring-cc-accent focus-visible:ring-inset"
        >
          {expanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
          {expanded ? "Collapse" : `Show all ${totalLines} lines`}
        </button>
      )}
    </div>
  )
})
