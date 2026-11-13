// Adapted from coollabsio/jean@1d53d3c:src/components/chat/GitDiffModal.tsx (CommentInputBar; Apache-2.0). Modified for session-dashboard.
// Adapted from coollabsio/jean@1d53d3c:src/components/chat/MemoizedFileDiff.tsx (renderAnnotation; Apache-2.0). Modified for session-dashboard.
// Line comments (UI_PLAN §5.4): an inline draft box rendered as a pierre annotation
// under the selected line(s), saved comments as compact cards, and the pending list
// in the left column. Jean's isolated input (typing never re-renders the diff) and
// Enter-to-add / Escape-to-cancel; here the text lives in the review store so a
// draft survives the file scrolling out of the virtualized window. Calm copy (§2.5):
// key hints in tooltips, no instruction text when there are no comments.
import { memo, useEffect, useRef } from "react"
import { MessageSquare, Pencil, Trash2, X } from "lucide-react"
import { useShallow } from "zustand/react/shallow"
import type { ID } from "@/lib/model"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  cancelDraft,
  clearComments,
  editComment,
  removeComment,
  saveDraft,
  selectScopeComments,
  setDraftText,
  useReviewStore,
  type AnnotationMeta,
  type Draft,
  type ReviewComment,
} from "./reviewStore"

function lineLabel(
  start: number,
  end: number,
  side: "deletions" | "additions"
) {
  const lines = start === end ? `Line ${start}` : `Lines ${start}–${end}`
  return side === "deletions" ? `${lines} (old)` : lines
}

/** Rendered by pierre into the annotation slot under the commented line. */
export function renderCommentAnnotation(meta: AnnotationMeta | undefined) {
  if (!meta) return null
  return meta.kind === "draft" ? (
    <DraftBox draft={meta.draft} />
  ) : (
    <CommentCard comment={meta.comment} />
  )
}

const DraftBox = memo(function DraftBox({ draft }: { draft: Draft }) {
  const text = useReviewStore((s) => s.draftText)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [draft])
  return (
    <div
      className="font-sans"
      data-review-draft=""
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="@container mx-2 my-1.5 max-w-[720px] min-w-0 rounded-[4px] border border-line bg-elevated">
        <div className="flex h-6 items-center gap-1.5 px-2 text-[11px] text-fg-faint">
          <MessageSquare size={11} className="shrink-0" />
          <span className="truncate">
            {lineLabel(draft.start, draft.end, draft.side)}
          </span>
        </div>
        <textarea
          ref={ref}
          value={text}
          rows={2}
          onChange={(e) => setDraftText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Escape") {
              e.preventDefault()
              cancelDraft()
            } else if (
              e.key === "Enter" &&
              (e.metaKey || e.ctrlKey || !e.shiftKey)
            ) {
              e.preventDefault()
              saveDraft()
            }
          }}
          placeholder="Comment"
          aria-label="Comment"
          className="block max-h-40 min-h-11 w-full resize-y border-y border-line-subtle bg-canvas px-2 py-1.5 text-[12.5px] leading-[18px] text-fg outline-none placeholder:text-fg-faint focus:border-y-brand/60"
        />
        <div className="flex h-8 items-center gap-1.5 px-2">
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={cancelDraft}
            title="Esc"
          >
            Cancel
          </Button>
          <Button
            size="xs"
            variant="default"
            disabled={!text.trim()}
            onClick={saveDraft}
            title="Enter · Shift+Enter for a newline"
          >
            {draft.editingId ? "Save" : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  )
})

const CommentCard = memo(function CommentCard({
  comment,
}: {
  comment: ReviewComment
}) {
  return (
    <div
      className="font-sans"
      onPointerDown={(e) => e.stopPropagation()}
      data-comment-id={comment.id}
    >
      <div className="group/c mx-2 my-1 flex max-w-[720px] gap-2 rounded-[4px] border border-line-subtle bg-chrome px-2 py-1.5">
        <MessageSquare size={12} className="mt-[3px] shrink-0 text-fg-faint" />
        <div className="min-w-0 flex-1">
          <div className="flex h-4 items-center gap-1.5 text-[11px] text-fg-faint">
            <span>{lineLabel(comment.start, comment.end, comment.side)}</span>
          </div>
          <p className="mt-0.5 text-[12.5px] leading-[18px] whitespace-pre-wrap text-fg">
            {comment.text}
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity duration-150 group-hover/c:opacity-100 focus-within:opacity-100">
          <Button
            size="icon-xs"
            variant="ghost"
            title="Edit comment"
            aria-label="Edit comment"
            onClick={() => editComment(comment.id)}
          >
            <Pencil />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            title="Delete comment"
            aria-label="Delete comment"
            onClick={() => removeComment(comment.id)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>
  )
})

/** Left-column list of pending comments: click to jump, × to drop. */
export const PendingComments = memo(function PendingComments({
  scope,
  onJump,
}: {
  scope: ID
  onJump: (c: ReviewComment) => void
}) {
  const comments = useReviewStore(
    useShallow((s) => selectScopeComments(s, scope))
  )
  if (!comments.length) return null
  return (
    <div className="flex max-h-[42%] shrink-0 flex-col border-t border-line-subtle">
      <div className="flex h-7 shrink-0 items-center gap-1.5 pr-1.5 pl-3">
        <span className="section-label">Comments</span>
        <span className="text-[11px] text-fg-faint tabular">
          {comments.length}
        </span>
        <button
          type="button"
          className="ml-auto h-5 rounded-[3px] px-1.5 text-[11px] text-fg-faint hover:bg-hover hover:text-fg-muted"
          onClick={() => clearComments(scope)}
        >
          Clear
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto px-1 pb-1.5">
        {comments.map((c) => (
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            onClick={() => onJump(c)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return
              e.preventDefault()
              onJump(c)
            }}
            className="group/pc flex cursor-default gap-1.5 rounded-[3px] px-2 py-1 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
            title={c.text}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[10.5px] text-fg-faint">
                {c.label}:{c.start === c.end ? c.start : `${c.start}-${c.end}`}
                {c.side === "deletions" && " · old"}
              </div>
              <div className="line-clamp-2 text-[12px] leading-4 text-fg-muted">
                {c.text}
              </div>
            </div>
            <button
              type="button"
              aria-label="Delete comment"
              title="Delete comment"
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[3px] text-fg-faint opacity-0 outline-none group-hover/pc:opacity-100 hover:bg-selected hover:text-fg focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
              )}
              onClick={(e) => {
                e.stopPropagation()
                removeComment(c.id)
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
})
