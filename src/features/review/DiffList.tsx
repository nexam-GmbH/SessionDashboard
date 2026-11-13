// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-changes.tsx (AgentChangedFile; Apache-2.0). Modified for session-dashboard.
// Adapted from coollabsio/jean@1d53d3c:src/components/chat/MemoizedFileDiff.tsx (Apache-2.0). Modified for session-dashboard.
// Adapted from pingdotgg/t3code@be5f805:apps/web/src/components/DiffPanel.tsx and DiffPanelShell.tsx (MIT). Modified for session-dashboard.
// Right column of the Review screen (UI_PLAN §5.4, §8): one MultiFileDiff per file
// inside pierre's Virtualizer, highlighted by the shared worker pool. Each file has
// a sticky custom header (Cline's AgentChangedFile row: chevron, path, ±, actions)
// with Keep / Reject shown on hover or once set (calm rules §2.5); line-number
// clicks or drags open an inline comment (Jean's
// line selection → annotation flow). Options objects are memoized per file so a
// mark, comment or style change re-renders only the files it touches; files out
// of view do no layout or highlighting work (pierre virtualization).
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react"
import type {
  DiffFileInput,
  DiffLineAnnotation,
  FileContents,
  SelectedLineRange,
} from "@pierre/diffs"
import { MultiFileDiff, Virtualizer, useVirtualizer } from "@pierre/diffs/react"
import { Check, ChevronRight, MessageSquare, X } from "lucide-react"
import type { ID } from "@/lib/model"
import { DiffStat } from "@/components/common/bits"
import { cn } from "@/lib/utils"
import type { ReviewFile, ReviewModel } from "./reviewModel"
import {
  DIFF_HOST_STYLE,
  DIFF_METRICS,
  DIFF_THEME,
  DIFF_UNSAFE_CSS,
  HEADER_PX,
  ReviewWorkerPool,
  withTrailingNewline,
} from "./pierre"
import { renderCommentAnnotation } from "./Comments"
import {
  cancelDraft,
  isCollapsed,
  openDraft,
  selectAnnotations,
  toggleCollapsed,
  toggleMark,
  useReviewStore,
  type AnnotationMeta,
  type DiffStyle,
  type ReviewComment,
} from "./reviewStore"

export interface DiffListApi {
  toFile(key: string): void
  toComment(c: ReviewComment): void
}

export function DiffList({
  scope,
  model,
  apiRef,
  onActiveChange,
}: {
  scope: ID
  model: ReviewModel
  apiRef: RefObject<DiffListApi | null>
  onActiveChange: (key: string) => void
}) {
  return (
    <ReviewWorkerPool
      fallback={<DiffLoading label="Starting the highlighter" />}
    >
      <Virtualizer
        className="h-full overflow-x-hidden overflow-y-auto bg-canvas"
        contentClassName="pb-[45vh]"
        config={{ overscrollSize: 600, intersectionObserverMargin: 2000 }}
      >
        <DiffListBody
          scope={scope}
          model={model}
          apiRef={apiRef}
          onActiveChange={onActiveChange}
        />
      </Virtualizer>
    </ReviewWorkerPool>
  )
}

function DiffListBody({
  scope,
  model,
  apiRef,
  onActiveChange,
}: {
  scope: ID
  model: ReviewModel
  apiRef: RefObject<DiffListApi | null>
  onActiveChange: (key: string) => void
}) {
  const virtualizer = useVirtualizer()
  const diffStyle = useReviewStore((s) => s.diffStyle)
  const groupLabel = useMemo(() => {
    const m = new Map<string, string>()
    if (model.cross)
      for (const g of model.groups)
        if (!g.id.startsWith("self:")) m.set(g.id, g.label)
    return m
  }, [model])
  const programmatic = useRef(0)

  // Scroll API for the tree, keyboard navigation and the pending-comment list.
  useEffect(() => {
    const root = () => virtualizer?.getRoot()
    const fileEl = (key: string) =>
      (root() as HTMLElement | undefined)?.querySelector<HTMLElement>(
        `[data-review-file="${CSS.escape(key)}"]`
      )
    apiRef.current = {
      toFile(key) {
        const el = fileEl(key)
        if (!el || !virtualizer) return
        programmatic.current = performance.now()
        virtualizer.scrollTo({
          top: virtualizer.getOffsetInScrollContainer(el),
        })
      },
      toComment(c) {
        this.toFile(c.fileKey)
        // the annotation exists once its lines are rendered: two frames after the jump
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const el = fileEl(c.fileKey)?.querySelector<HTMLElement>(
              `[data-comment-id="${CSS.escape(c.id)}"]`
            )
            el?.scrollIntoView({ block: "center" })
          })
        )
      },
    }
    return () => {
      apiRef.current = null
    }
  }, [virtualizer, apiRef])

  // Active file = the last file whose top has scrolled past the viewport top.
  useEffect(() => {
    const root = virtualizer?.getRoot()
    if (!(root instanceof HTMLElement)) return
    let raf = 0
    const measure = () => {
      raf = 0
      const top = root.getBoundingClientRect().top
      let active: string | undefined
      for (const el of root.querySelectorAll<HTMLElement>(
        "[data-review-file]"
      )) {
        if (el.getBoundingClientRect().top - top <= HEADER_PX)
          active = el.dataset.reviewFile
        else break
      }
      if (active) onActiveChange(active)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    root.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      root.removeEventListener("scroll", onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [virtualizer, onActiveChange])

  return (
    <>
      {model.files.map((f) => (
        <FileBlock
          key={f.key}
          scope={scope}
          file={f}
          diffStyle={diffStyle}
          repo={groupLabel.get(f.groupId)}
        />
      ))}
    </>
  )
}

function fileInput(file: ReviewFile): DiffFileInput {
  const oldFile: FileContents | null =
    file.oldText == null
      ? null
      : {
          name: file.path,
          contents: withTrailingNewline(file.oldText),
          cacheKey: `${file.cacheKey}:a`,
        }
  const newFile: FileContents | null =
    file.newText == null
      ? null
      : {
          name: file.path,
          contents: withTrailingNewline(file.newText),
          cacheKey: `${file.cacheKey}:b`,
        }
  if (oldFile && newFile) return { oldFile, newFile }
  if (newFile) return { oldFile: null, newFile }
  return {
    oldFile: oldFile ?? { name: file.path, contents: "" },
    newFile: null,
  }
}

const renderAnnotation = (a: DiffLineAnnotation<AnnotationMeta>) =>
  renderCommentAnnotation(a.metadata)

const FileBlock = memo(function FileBlock({
  scope,
  file,
  diffStyle,
  repo,
}: {
  scope: ID
  file: ReviewFile
  diffStyle: DiffStyle
  repo: string | undefined
}) {
  const collapsed = useReviewStore((s) => isCollapsed(s, file.key))
  const annotations = useReviewStore((s) =>
    selectAnnotations(s, scope, file.key)
  )
  const selectedLines = useReviewStore((s) =>
    s.draft && s.draft.scope === scope && s.draft.fileKey === file.key
      ? s.draft.range
      : null
  )
  const input = useMemo(() => fileInput(file), [file])
  const label = repo ? `${repo}/${file.path}` : file.path

  const onSelect = useCallback(
    (range: SelectedLineRange | null) => {
      if (range) openDraft(scope, file.key, label, range)
      else {
        const s = useReviewStore.getState()
        if (s.draft?.fileKey === file.key && !s.draftText.trim()) cancelDraft()
      }
    },
    [scope, file.key, label]
  )

  const options = useMemo(
    () => ({
      theme: DIFF_THEME,
      themeType: "dark" as const,
      diffStyle,
      diffIndicators: "bars" as const,
      lineDiffType: "word-alt" as const,
      hunkSeparators: "line-info" as const,
      overflow: "scroll" as const,
      stickyHeader: true,
      collapsed,
      enableLineSelection: true,
      enableGutterUtility: true,
      lineHoverHighlight: "number" as const,
      onLineSelected: onSelect,
      onGutterUtilityClick: onSelect,
      unsafeCSS: DIFF_UNSAFE_CSS,
    }),
    [diffStyle, collapsed, onSelect]
  )

  const renderHeader = useCallback(
    () => (
      <FileHeader scope={scope} file={file} repo={repo} collapsed={collapsed} />
    ),
    [scope, file, repo, collapsed]
  )

  return (
    <div data-review-file={file.key} className="border-b border-line-subtle">
      <MultiFileDiff<AnnotationMeta>
        {...input}
        options={options}
        metrics={DIFF_METRICS}
        lineAnnotations={annotations}
        selectedLines={selectedLines}
        renderAnnotation={renderAnnotation}
        renderCustomHeader={renderHeader}
        style={DIFF_HOST_STYLE}
      />
    </div>
  )
})

const OP_TITLE: Partial<Record<ReviewFile["op"], string>> = {
  add: " · new file",
  delete: " · deleted",
  move: " · moved",
}

const FileHeader = memo(function FileHeader({
  scope,
  file,
  repo,
  collapsed,
}: {
  scope: ID
  file: ReviewFile
  repo: string | undefined
  collapsed: boolean
}) {
  const mark = useReviewStore((s) => s.marks[file.key])
  const comments = useReviewStore((s) => {
    let n = 0
    for (const c of s.comments)
      if (c.scope === scope && c.fileKey === file.key) n++
    return n
  })
  const toggle = () => toggleCollapsed(file.key)
  return (
    <div
      className="group/fh flex items-center gap-1.5 border-b border-line-subtle bg-chrome pr-2 pl-1 font-sans"
      style={{ height: HEADER_PX }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`}
        onClick={toggle}
        className="flex size-5 shrink-0 items-center justify-center rounded-[3px] text-fg-faint hover:bg-hover hover:text-fg"
      >
        <ChevronRight
          size={13}
          className={cn(
            "transition-transform duration-150",
            !collapsed && "rotate-90"
          )}
        />
      </button>
      <button
        type="button"
        onClick={toggle}
        title={`${repo ? `${repo} · ` : ""}${file.path}${OP_TITLE[file.op] ?? ""}`}
        className="flex min-w-0 items-baseline gap-0 text-left font-mono text-[12px]"
      >
        {repo && <span className="shrink-0 text-fg-muted">{repo}</span>}
        {repo && <span className="shrink-0 px-1 text-fg-faint">·</span>}
        {file.dir && (
          <span className="min-w-0 truncate text-fg-faint">{file.dir}/</span>
        )}
        <span
          className={cn(
            "shrink-0",
            mark === "rejected" ? "text-fg-faint line-through" : "text-fg"
          )}
        >
          {file.name}
        </span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className="h-full min-w-4 flex-1 cursor-default"
        onClick={toggle}
      />
      {comments > 0 && (
        <span
          className="flex shrink-0 items-center gap-1 text-[11px] text-fg-muted"
          title={`${comments} pending comment${comments === 1 ? "" : "s"}`}
        >
          <MessageSquare size={11} />
          <span className="tabular">{comments}</span>
        </span>
      )}
      <DiffStat
        added={file.added}
        removed={file.removed}
        className="shrink-0"
      />
      <span
        className={cn(
          "ml-1 flex shrink-0 items-center gap-1",
          !mark && "opacity-0 group-hover/fh:opacity-100 focus-within:opacity-100"
        )}
      >
      <MarkButton
        pressed={mark === "rejected"}
        onClick={() => toggleMark(file.key, "rejected")}
        title={
          mark === "rejected" ? "Undo reject" : "Reject this file's changes"
        }
      >
        <X /> {mark === "rejected" ? "Rejected" : "Reject"}
      </MarkButton>
      <MarkButton
        pressed={mark === "kept"}
        onClick={() => toggleMark(file.key, "kept")}
        title={mark === "kept" ? "Undo keep" : "Keep this file's changes"}
      >
        <Check /> {mark === "kept" ? "Kept" : "Keep"}
      </MarkButton>
      </span>
    </div>
  )
})

function MarkButton({
  pressed,
  onClick,
  title,
  children,
}: {
  pressed: boolean
  onClick: () => void
  title: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[4px] border px-1.5 text-[11.5px] font-medium transition-colors [&_svg]:size-3",
        pressed
          ? "border-line-strong bg-selected text-fg"
          : "border-line bg-elevated text-fg-muted hover:border-line-strong hover:bg-hover hover:text-fg"
      )}
    >
      {children}
    </button>
  )
}

// Loading skeleton after T3 Code's DiffPanelLoadingState: file header, separator, a few code lines.
export function DiffLoading({ label }: { label: string }) {
  const bar = "h-2.5 rounded-[2px] bg-elevated"
  const header = (w: string) => (
    <div
      className="flex items-center gap-2 border-b border-line-subtle bg-chrome px-2"
      style={{ height: HEADER_PX }}
    >
      <div className="size-3 rounded-[2px] bg-elevated" />
      <div className={cn(bar, w)} />
      <div className="ml-auto flex gap-1.5">
        <div className={cn(bar, "w-6")} />
        <div className={cn(bar, "w-6")} />
      </div>
    </div>
  )
  return (
    <div
      className="h-full overflow-hidden bg-canvas"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {header("w-56")}
      <div className="space-y-2.5 px-3 py-3">
        {["w-3/5", "w-4/5", "w-2/5", "w-2/3", "w-1/2"].map((w, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className={cn(bar, "w-5 shrink-0")} />
            <div className={cn(bar, w)} />
          </div>
        ))}
      </div>
      {header("w-40")}
      {header("w-72")}
      <span className="sr-only">{label}</span>
    </div>
  )
}
