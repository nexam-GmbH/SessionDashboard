// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-chat/tool-diff.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from BloopAI/vibe-kanban@5f06193:packages/ui/src/components/PierreConversationDiff.tsx (Apache-2.0):
// unsafeCSS overrides, classic indicators, hunk separators dropped for chat rows.
// Changes: themed from our tokens (UI_PLAN §2.2), clamped height with an expand
// control, highlighting through a shared @pierre/diffs worker pool; token overrides
// on `:host` (pierre never sets data-theme-type, so the old selector was ignored).
import { memo, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { parseDiffFromFile } from "@pierre/diffs"
import { FileDiff, WorkerPoolContextProvider } from "@pierre/diffs/react"
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { DIFF_TOKEN_CSS, HIGHLIGHTER_OPTIONS, POOL_OPTIONS, withTrailingNewline } from "./diffPool"

// One shared pool (singleton inside @pierre/diffs, options shared with the Review
// screen): Shiki tokenizes off the main thread; components fall back to main-thread
// highlighting if workers fail.
export function DiffWorkerPool({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={POOL_OPTIONS} highlighterOptions={HIGHLIGHTER_OPTIONS}>
      {children}
    </WorkerPoolContextProvider>
  )
}

/** Injected at @pierre/diffs' `unsafe` layer: our token tints (on `:host`), dense rows, classic indicators. */
const UNSAFE_CSS = `${DIFF_TOKEN_CSS}
  [data-code] { padding-bottom: 0 !important; }
  [data-disable-line-numbers][data-indicators='classic'] [data-column-content] { padding-inline-start: calc(2ch + 1ch); }
  [data-disable-line-numbers][data-indicators='classic'] [data-line-type='change-addition'] [data-column-content]::before,
  [data-disable-line-numbers][data-indicators='classic'] [data-line-type='change-deletion'] [data-column-content]::before { left: 1ch; }
`

const LINE_PX = 18

export const InlineDiff = memo(function InlineDiff({
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
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      diffIndicators: "classic" as const,
      disableFileHeader: true,
      disableLineNumbers: fragment,
      themeType: "dark" as const,
      overflow: "scroll" as const,
      hunkSeparators: "line-info-basic" as const,
      lineDiffType: "word" as const,
      unsafeCSS: UNSAFE_CSS,
    }),
    [fragment],
  )
  if (!fileDiff) return null
  const clamped = !expanded && totalLines > maxLines
  return (
    <div className={cn("relative overflow-hidden rounded-[4px] border border-line-subtle bg-canvas", className)}>
      <div style={{ maxHeight: clamped ? maxLines * LINE_PX + 4 : undefined }} className="overflow-hidden">
        <FileDiff
          fileDiff={fileDiff}
          options={options}
          style={
            {
              "--diffs-font-family": "var(--font-code)",
              "--diffs-header-font-family": "var(--font-ui)",
              "--diffs-font-size": "12px",
              "--diffs-line-height": `${LINE_PX}px`,
              "--diffs-dark-bg": "var(--bg-canvas)",
              "--diffs-light-bg": "var(--bg-canvas)",
              "--diffs-tab-size": "2",
              colorScheme: "dark",
            } as CSSProperties
          }
        />
      </div>
      {totalLines > maxLines && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex h-6 w-full items-center justify-center gap-1 border-t border-line-subtle bg-chrome text-[11px] text-fg-faint hover:bg-hover hover:text-fg-muted"
        >
          {expanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
          {expanded ? "Collapse" : `Show all ${totalLines} lines`}
        </button>
      )}
    </div>
  )
})
