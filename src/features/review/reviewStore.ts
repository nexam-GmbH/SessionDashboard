// Adapted from coollabsio/jean@1d53d3c:src/components/chat/GitDiffModal.tsx (Apache-2.0). Modified for session-dashboard.
// Review state: per-file Keep/Reject marks
// (Zed's keep/reject idea), pending line comments and the one open draft. Comment
// model, per-file annotation maps with stable empty references and the comment
// formatting for "send to session" follow Jean's GitDiffModal; here they live in a
// zustand store so state survives tab switches and every file subscribes only to
// its own slice.
import { create } from "zustand"
import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs"
import type { ID } from "@/lib/model"

export type ReviewMark = "kept" | "rejected"
export type DiffStyle = "unified" | "split"
export type Side = "deletions" | "additions"

export interface ReviewComment {
  id: string
  /** the reviewed session (where comments are sent) */
  scope: ID
  fileKey: string
  /** display path, repo-prefixed in cross-repo reviews */
  label: string
  side: Side
  start: number
  end: number
  text: string
  createdAt: number
}

export interface Draft {
  scope: ID
  fileKey: string
  label: string
  /** stable object: passed to pierre as the controlled selection */
  range: SelectedLineRange
  side: Side
  start: number
  end: number
  /** editing an existing comment */
  editingId?: string
}

export type AnnotationMeta =
  { kind: "comment"; comment: ReviewComment } | { kind: "draft"; draft: Draft }

interface ReviewState {
  marks: Record<string, ReviewMark>
  /** explicit collapse overrides; default is collapsed once a file is reviewed */
  collapsed: Record<string, boolean>
  comments: ReviewComment[]
  draft: Draft | null
  draftText: string
  diffStyle: DiffStyle
  turnByScope: Record<ID, number | "all">
  activeByScope: Record<ID, string>
  sent: Record<ID, { count: number; at: number }>
  /** files whose diff has been on screen, by content (a changed file counts as unseen again) */
  seen: Record<string, true>
}

function readDiffStyle(): DiffStyle {
  try {
    return localStorage.getItem("sd.review.diffStyle") === "split"
      ? "split"
      : "unified"
  } catch {
    return "unified"
  }
}

export const useReviewStore = create<ReviewState>()(() => ({
  marks: {},
  collapsed: {},
  comments: [],
  draft: null,
  draftText: "",
  diffStyle: readDiffStyle(),
  turnByScope: {},
  activeByScope: {},
  seen: {},
  sent: {},
}))

const set = useReviewStore.setState
const get = useReviewStore.getState

// ---------- marks ----------
export function setMarks(keys: string[], mark: ReviewMark | null) {
  set((s) => {
    const marks = { ...s.marks }
    const collapsed = { ...s.collapsed }
    for (const k of keys) {
      if (mark) marks[k] = mark
      else delete marks[k]
      delete collapsed[k]
    }
    return { marks, collapsed }
  })
}
export function toggleMark(key: string, mark: ReviewMark) {
  setMarks([key], get().marks[key] === mark ? null : mark)
}
export function isCollapsed(s: ReviewState, key: string) {
  return s.collapsed[key] ?? !!s.marks[key]
}
export function toggleCollapsed(key: string) {
  set((s) => ({ collapsed: { ...s.collapsed, [key]: !isCollapsed(s, key) } }))
}

// ---------- view prefs ----------
export function setDiffStyle(diffStyle: DiffStyle) {
  set({ diffStyle })
  try {
    localStorage.setItem("sd.review.diffStyle", diffStyle)
  } catch {
    /* storage unavailable */
  }
}
export function setTurn(scope: ID, turn: number | "all") {
  set((s) => ({ turnByScope: { ...s.turnByScope, [scope]: turn } }))
}
export function markSeen(cacheKey: string) {
  if (get().seen[cacheKey]) return
  set((s) => ({ seen: { ...s.seen, [cacheKey]: true } }))
}

export function setActive(scope: ID, key: string) {
  if (get().activeByScope[scope] === key) return
  set((s) => ({ activeByScope: { ...s.activeByScope, [scope]: key } }))
}

// ---------- comments ----------
let seq = 0
const newId = () => `rc_${Date.now().toString(36)}${(seq++).toString(36)}`

export function openDraft(
  scope: ID,
  fileKey: string,
  label: string,
  range: SelectedLineRange
) {
  const side: Side = range.side ?? range.endSide ?? "additions"
  const start = Math.min(range.start, range.end)
  const end = Math.max(range.start, range.end)
  const cur = get().draft
  if (
    cur &&
    cur.fileKey === fileKey &&
    cur.scope === scope &&
    cur.start === start &&
    cur.end === end &&
    cur.side === side
  )
    return
  set({
    draft: {
      scope,
      fileKey,
      label,
      range: { start, end, side, endSide: side },
      side,
      start,
      end,
    },
    draftText: "",
  })
}
export function editComment(id: string) {
  const c = get().comments.find((x) => x.id === id)
  if (!c) return
  set({
    draft: {
      scope: c.scope,
      fileKey: c.fileKey,
      label: c.label,
      range: { start: c.start, end: c.end, side: c.side, endSide: c.side },
      side: c.side,
      start: c.start,
      end: c.end,
      editingId: id,
    },
    draftText: c.text,
  })
}
export function setDraftText(draftText: string) {
  set({ draftText })
}
export function cancelDraft() {
  set({ draft: null, draftText: "" })
}
export function saveDraft() {
  const { draft, draftText } = get()
  const text = draftText.trim()
  if (!draft || !text) return
  set((s) => ({
    comments: draft.editingId
      ? s.comments.map((c) => (c.id === draft.editingId ? { ...c, text } : c))
      : [
          ...s.comments,
          {
            id: newId(),
            scope: draft.scope,
            fileKey: draft.fileKey,
            label: draft.label,
            side: draft.side,
            start: draft.start,
            end: draft.end,
            text,
            createdAt: Date.now(),
          },
        ],
    draft: null,
    draftText: "",
  }))
}
export function removeComment(id: string) {
  set((s) => ({
    comments: s.comments.filter((c) => c.id !== id),
    draft: s.draft?.editingId === id ? null : s.draft,
  }))
}
export function clearComments(scope: ID) {
  set((s) => ({
    comments: s.comments.filter((c) => c.scope !== scope),
    draft: s.draft?.scope === scope ? null : s.draft,
  }))
}

/** Jean's formatComments, as one message the agent can act on. */
export function formatComments(comments: ReviewComment[]) {
  const lines = comments.map((c, i) => {
    const where =
      c.start === c.end
        ? `${c.label}:${c.start}`
        : `${c.label}:${c.start}-${c.end}`
    const side = c.side === "deletions" ? " (old code)" : ""
    return `${i + 1}. ${where}${side}\n   ${c.text.replace(/\n/g, "\n   ")}`
  })
  return `Review comments on your changes (${comments.length}):\n\n${lines.join("\n\n")}`
}

/** "Sent N comments" confirmation, cleared after a few seconds. */
export function markSent(scope: ID, count: number) {
  const at = Date.now()
  set((s) => ({ sent: { ...s.sent, [scope]: { count, at } } }))
  setTimeout(() => {
    if (get().sent[scope]?.at !== at) return
    set((s) => {
      const sent = { ...s.sent }
      delete sent[scope]
      return { sent }
    })
  }, 5000)
}

// ---------- per-file selectors with stable references ----------
const EMPTY_ANNOTATIONS: DiffLineAnnotation<AnnotationMeta>[] = []
const annCache = new Map<
  string,
  {
    comments: ReviewComment[]
    draft: Draft | null
    value: DiffLineAnnotation<AnnotationMeta>[]
  }
>()

/** Annotations of one file: its comments (at the last line of their range) plus the open draft. */
export function selectAnnotations(s: ReviewState, scope: ID, fileKey: string) {
  const ck = `${scope}|${fileKey}`
  const hit = annCache.get(ck)
  if (hit && hit.comments === s.comments && hit.draft === s.draft)
    return hit.value
  const out: DiffLineAnnotation<AnnotationMeta>[] = []
  for (const c of s.comments) {
    if (
      c.scope !== scope ||
      c.fileKey !== fileKey ||
      c.id === s.draft?.editingId
    )
      continue
    out.push({
      side: c.side,
      lineNumber: c.end,
      metadata: { kind: "comment", comment: c },
    })
  }
  const d = s.draft
  if (d && d.scope === scope && d.fileKey === fileKey)
    out.push({
      side: d.side,
      lineNumber: d.end,
      metadata: { kind: "draft", draft: d },
    })
  // keep the previous array when nothing for this file changed
  let value = out.length ? out : EMPTY_ANNOTATIONS
  if (
    hit &&
    hit.value.length === value.length &&
    hit.value.every(
      (a, i) =>
        a.metadata === value[i].metadata ||
        sameMeta(a.metadata, value[i].metadata)
    )
  )
    value = hit.value
  annCache.set(ck, { comments: s.comments, draft: s.draft, value })
  return value
}
function sameMeta(a: AnnotationMeta, b: AnnotationMeta) {
  if (a.kind === "comment" && b.kind === "comment")
    return a.comment === b.comment
  if (a.kind === "draft" && b.kind === "draft") return a.draft === b.draft
  return false
}

export function selectScopeComments(s: ReviewState, scope: ID) {
  return s.comments.filter((c) => c.scope === scope)
}
