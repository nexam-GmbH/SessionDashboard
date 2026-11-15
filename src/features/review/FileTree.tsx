// Adapted from coollabsio/jean@1d53d3c:src/components/chat/GitDiffFileTree.tsx (Apache-2.0). Modified for session-dashboard.
// Adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/views/chat/changes-panel.tsx (Apache-2.0). Modified for session-dashboard.
// Left column of the Review screen: changed files (for the main agent grouped by repo
// first) as Cline's dense change rows with a filter on top. Calm rules (§2.5, Zed's
// edits list): file name first, folder muted, ± only; the kept/rejected glyph and the
// comment count appear only when set. Rows are a flat list virtualized with TanStack
// Virtual (fixed 24px rows, UI_PLAN §8.4).
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  ArrowUpRight,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  FolderGit2,
  MessageSquare,
  Search,
  X,
} from "lucide-react"
import type { ID } from "@/lib/model"
import { useSession } from "@/store/selectors"
import { openSession } from "@/store/actions"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { DiffStat } from "@/components/common/bits"
import { cn } from "@/lib/utils"
import type { ReviewFile, ReviewGroup, ReviewModel } from "./reviewModel"
import { useReviewStore, type ReviewMark } from "./reviewStore"

const ROW = 24

type Row =
  | {
      kind: "group"
      id: string
      group: ReviewGroup
      open: boolean
    }
  | { kind: "file"; id: string; file: ReviewFile; indent: boolean }

/** Files in the model's order (the diff list's order, so j/k and the tree agree), grouped by repo for the main agent. */
function flatten(model: ReviewModel, closed: Set<string>, q: string): Row[] {
  const rows: Row[] = []
  const match = (f: ReviewFile) => !q || f.path.toLowerCase().includes(q)
  for (const g of model.groups) {
    const files = model.files.filter((f) => f.groupId === g.id && match(f))
    if (q && !files.length) continue
    if (model.cross) {
      const open = !!q || !closed.has(g.id)
      rows.push({ kind: "group", id: g.id, group: g, open })
      if (!open) continue
    }
    for (const f of files)
      rows.push({ kind: "file", id: f.key, file: f, indent: model.cross })
  }
  return rows
}

export const FileTree = memo(function FileTree({
  scope,
  model,
  activeKey,
  onSelect,
}: {
  scope: ID
  model: ReviewModel
  activeKey: string | undefined
  onSelect: (key: string) => void
}) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const rows = useMemo(() => flatten(model, closed, q), [model, closed, q])
  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 12,
  })

  // Reveal the active file when it changes: open its repo group once, then
  // scroll its row into view after the rows have updated.
  const pendingReveal = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!activeKey) return
    const file = model.files.find((f) => f.key === activeKey)
    if (!file) return
    pendingReveal.current = activeKey
    if (!model.cross) return
    setClosed((prev) => {
      if (!prev.has(file.groupId)) return prev
      const next = new Set(prev)
      next.delete(file.groupId)
      return next
    })
  }, [activeKey, model])
  useEffect(() => {
    const key = pendingReveal.current
    if (!key) return
    const idx = rows.findIndex((r) => r.kind === "file" && r.id === key)
    if (idx < 0) return
    pendingReveal.current = undefined
    virt.scrollToIndex(idx, { align: "auto" })
  }, [rows, activeKey, virt])

  const toggle = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center px-2">
        <label className="flex h-6 w-full items-center gap-1.5 rounded-md border border-border bg-background px-1.5 focus-within:border-input">
          <Search size={12} className="shrink-0 text-muted-foreground/70" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("")
                e.currentTarget.blur()
              }
            }}
            placeholder="Filter files"
            title="j / k: next / previous file"
            aria-label="Filter files"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear filter"
              className="text-muted-foreground/70 hover:text-foreground"
              onClick={() => setQuery("")}
            >
              <X size={12} />
            </button>
          )}
        </label>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto [contain:strict]"
        role="tree"
        aria-label="Changed files"
      >
        {rows.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground/70">
            No matches
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{ height: virt.getTotalSize() }}
          >
            {virt.getVirtualItems().map((vi) => {
              const r = rows[vi.index]
              return (
                <div
                  key={r.id}
                  className="absolute inset-x-0 top-0 px-1"
                  style={{
                    height: ROW,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {r.kind === "group" ? (
                    <GroupRow
                      group={r.group}
                      open={r.open}
                      onToggle={() => toggle(r.id)}
                    />
                  ) : (
                    <FileRow
                      scope={scope}
                      file={r.file}
                      indent={r.indent}
                      active={r.id === activeKey}
                      onSelect={onSelect}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
})

const GroupRow = memo(function GroupRow({
  group,
  open,
  onToggle,
}: {
  group: ReviewGroup
  open: boolean
  onToggle: () => void
}) {
  const session = useSession(group.sessionId)
  return (
    <div className="group/g flex h-full w-full min-w-0 items-center rounded-sm hover:bg-accent">
      <button
        type="button"
        role="treeitem"
        aria-expanded={open}
        onClick={onToggle}
        title={session ? `${session.title}\n${group.sublabel}` : group.label}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1 text-left"
      >
        <ChevronRight
          size={12}
          className={cn(
            "shrink-0 text-muted-foreground/70 transition-transform duration-150",
            open && "rotate-90"
          )}
        />
        <FolderGit2 size={13} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
          {group.label}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1.5 pr-1.5 pl-1">
        <button
          type="button"
          title={session ? `Open “${session.title}”` : "Open session"}
          aria-label="Open session"
          onClick={() => openSession(group.sessionId)}
          className="flex size-4 items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 group-hover/g:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground"
        >
          <ArrowUpRight size={12} />
        </button>
        {session && <StatusGlyph status={session.status} size="xs" />}
        <span className="text-xs text-muted-foreground/70 tabular">
          {group.files.length}
        </span>
      </span>
    </div>
  )
})

export function MarkGlyph({
  mark,
  size = 13,
}: {
  mark: ReviewMark | undefined
  size?: number
}) {
  if (mark === "kept")
    return (
      <CircleCheck
        size={size}
        strokeWidth={2}
        className="shrink-0 text-muted-foreground"
        aria-label="Kept"
      />
    )
  if (mark === "rejected")
    return (
      <CircleX
        size={size}
        strokeWidth={2}
        className="shrink-0 text-muted-foreground/70"
        aria-label="Rejected"
      />
    )
  return (
    <Circle
      size={size - 3}
      strokeWidth={2.25}
      className="mx-[1.5px] shrink-0 text-muted-foreground/70"
      aria-label="Not reviewed"
    />
  )
}

const OP_TITLE: Record<ReviewFile["op"], string> = {
  add: "Added",
  modify: "Modified",
  delete: "Deleted",
  move: "Moved",
}

const FileRow = memo(function FileRow({
  scope,
  file,
  indent,
  active,
  onSelect,
}: {
  scope: ID
  file: ReviewFile
  indent: boolean
  active: boolean
  onSelect: (key: string) => void
}) {
  const mark = useReviewStore((s) => s.marks[file.key])
  const comments = useReviewStore((s) => {
    let n = 0
    for (const c of s.comments)
      if (c.scope === scope && c.fileKey === file.key) n++
    return n
  })
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={active}
      data-active={active || undefined}
      onClick={() => onSelect(file.key)}
      title={`${file.path} · ${OP_TITLE[file.op]}${mark ? ` · ${mark}` : ""}`}
      className={cn(
        "flex h-full w-full min-w-0 items-center gap-1.5 rounded-sm pr-1.5 text-left",
        indent ? "pl-6" : "pl-2",
        active ? "bg-accent" : "hover:bg-accent"
      )}
    >
      {mark && <MarkGlyph mark={mark} size={12} />}
      <span
        className={cn(
          "max-w-[75%] shrink-0 truncate text-xs",
          mark === "rejected"
            ? "text-muted-foreground/70 line-through decoration-muted-foreground/40"
            : mark === "kept"
              ? "text-muted-foreground"
              : "text-foreground"
        )}
      >
        {file.name}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
        {file.dir}
      </span>
      {comments > 0 && (
        <span
          className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
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
    </button>
  )
})
