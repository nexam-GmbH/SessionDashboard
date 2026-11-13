// Sidebar — UI_PLAN §4.2. Needs-you queue + main agent + repo tree in one virtualized
// flat list. Row model idea: Agent of Empires sidebar/rowModel.ts (MIT); agent rows after
// Orca SidebarAgentsList.tsx (MIT); tree indentation/guides after Trigger.dev TreeView (Apache-2.0).
import { memo, useMemo, useRef, useState, useCallback } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  ExternalLink,
  GitFork,
  ListFilter,
  Pin,
  Plus,
  SquarePen,
} from "lucide-react"
import { getApp, useApp } from "@/store/app"
import { useRelTime } from "@/components/common/RelativeTime"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  archiveSession,
  forkSession,
  openNewSession,
  openRepo,
  openSession,
  pinSession,
  restoreSession,
  select,
  setSidebarGroupBy,
  toggleSidebarNode,
} from "@/store/actions"
import { useRepoRollup, subagentAsStatus, selectArchivedCount } from "@/store/selectors"
import { navigate } from "@/app/nav"
import { openPopout } from "@/app/popout"
import { setSessionsFilter } from "@/features/sessions/sessionsUi"
import { cn } from "@/lib/utils"
import type { ID, SessionStatus } from "@/lib/model"
import { buildRows, rowHeight, type SidebarRow, type SidebarUi } from "./rows"

export function Sidebar() {
  const [ui, setUi] = useState<SidebarUi>({ needsOpen: true, needsAll: false, doneOpen: false, mainOpen: true, reposOpen: true, closedGroups: {} })
  const structVersion = useApp((s) => s.structVersion)
  const statusVersion = useApp((s) => s.statusVersion)
  const expanded = useApp((s) => s.sidebarExpanded)
  const groupBy = useApp((s) => s.sidebarGroupBy)
  const archivedCount = useApp(selectArchivedCount)
  // rows recompute only on structure/status/expansion changes, not on every engine tick
  const rows = useMemo(
    () => buildRows(getApp(), ui),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structVersion, statusVersion, expanded, groupBy, ui],
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowHeight(rows[i]),
    overscan: 12,
    getItemKey: (i) => rows[i].key,
  })
  const [focusIndex, setFocusIndex] = useState(-1)
  const ctxRef = useRef<SidebarRow | null>(null)
  const [ctxRow, setCtxRow] = useState<SidebarRow | null>(null)

  const toggleSection = useCallback((row: Extract<SidebarRow, { type: "section" }>) => {
    setUi((u) => {
      if (row.key === "needs") return { ...u, needsOpen: !u.needsOpen }
      if (row.key === "done") return { ...u, doneOpen: !u.doneOpen }
      if (row.key === "main") return { ...u, mainOpen: !u.mainOpen }
      if (row.key === "repos") return { ...u, reposOpen: !u.reposOpen }
      const g = { ...u.closedGroups }
      if (g[row.groupKey!]) delete g[row.groupKey!]
      else g[row.groupKey!] = true
      return { ...u, closedGroups: g }
    })
  }, [])

  const activate = useCallback(
    (row: SidebarRow) => {
      switch (row.type) {
        case "section":
          return toggleSection(row)
        case "attention":
          return openSession(row.entry.kind === "session" ? row.entry.id : row.entry.sessionId)
        case "session":
          return openSession(row.id)
        case "subagent": {
          select({ kind: "subagent", id: row.id })
          return
        }
        case "repo":
          select({ kind: "repo", id: row.id })
          return toggleSidebarNode(row.id)
        case "more":
          return setUi((u) => ({ ...u, needsAll: !u.needsAll }))
        case "idle":
          return toggleSidebarNode(`idle:${row.repoId}`)
      }
    },
    [toggleSection],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rows[focusIndex]
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      let i = focusIndex
      do i = Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))
      while (rows[i]?.type === "empty" && i > 0 && i < rows.length - 1)
      setFocusIndex(i)
      virtualizer.scrollToIndex(i)
    } else if (e.key === "Enter" && row) {
      e.preventDefault()
      activate(row)
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === " ") && row) {
      e.preventDefault()
      const want = e.key === "ArrowRight" ? true : e.key === "ArrowLeft" ? false : undefined
      if (row.type === "repo" || (row.type === "session" && row.hasChildren)) toggleSidebarNode(row.id, want)
      else if (row.type === "section") toggleSection(row)
    }
  }

  return (
    <aside className="flex h-full min-w-0 flex-col">
      <ContextMenu onOpenChange={(o) => setCtxRow(o ? ctxRef.current : null)}>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={() => focusIndex < 0 && setFocusIndex(0)}
            className="min-h-0 flex-1 overflow-y-auto outline-none"
            onContextMenu={(e) => {
              if (!ctxRef.current) e.preventDefault()
            }}
          >
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const row = rows[vi.index]
                return (
                  <div
                    key={vi.key}
                    className="absolute inset-x-0"
                    style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}
                    onContextMenuCapture={() => {
                      ctxRef.current = row.type === "session" || row.type === "repo" || row.type === "attention" ? row : null
                    }}
                  >
                    <RowView
                      row={row}
                      focused={vi.index === focusIndex}
                      onActivate={activate}
                      groupBy={groupBy}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </ContextMenuTrigger>
        <SidebarContextMenu row={ctxRow} />
      </ContextMenu>
      <div className="flex h-7 shrink-0 items-center gap-1 border-t border-line-subtle px-1.5 text-[11px] text-fg-faint">
        <button
          className="flex h-5 items-center gap-1 rounded-sm px-1.5 hover:bg-hover hover:text-fg-muted"
          onClick={() => {
            setSessionsFilter({ view: "archived" })
            navigate("/sessions")
          }}
          title="Archived sessions: hidden from the map and lists, still searchable and restorable"
        >
          <Archive size={12} />
          Archive <span className="tabular">{archivedCount}</span>
        </button>
        <button
          className="ml-auto flex h-5 items-center gap-1 rounded-sm px-1.5 hover:bg-hover hover:text-fg-muted"
          onClick={() => navigate("/settings")}
          title="Add a repository"
        >
          <Plus size={12} />
          Add repo
        </button>
      </div>
    </aside>
  )
}

const RowView = memo(function RowView({
  row,
  focused,
  onActivate,
  groupBy,
}: {
  row: SidebarRow
  focused: boolean
  onActivate: (r: SidebarRow) => void
  groupBy: string
}) {
  switch (row.type) {
    case "section":
      return <SectionRow row={row} onActivate={onActivate} groupBy={groupBy} focused={focused} />
    case "attention":
      return <AttentionRow row={row} focused={focused} onActivate={onActivate} />
    case "session":
      return <SessionRow row={row} focused={focused} onActivate={onActivate} />
    case "subagent":
      return <SubagentRow row={row} focused={focused} onActivate={onActivate} />
    case "repo":
      return <RepoRow row={row} focused={focused} onActivate={onActivate} />
    case "empty":
      return <div className="flex h-6 items-center pl-7 text-[11px] text-fg-faint">{row.text}</div>
    case "idle":
      return (
        <button
          className={cn("flex h-full w-full items-center gap-1.5 pl-[26px] text-left text-[11.5px] text-fg-faint hover:bg-hover hover:text-fg-muted", focused && "ring-1 ring-ring/60 ring-inset")}
          onClick={() => onActivate(row)}
        >
          <ChevronRight size={11} className={cn("transition-transform", row.open && "rotate-90")} />
          {row.count} idle
        </button>
      )
    case "more":
      return (
        <button
          className="flex h-full w-full items-center pl-[22px] text-left text-[11px] text-fg-faint hover:text-fg-muted"
          onClick={() => onActivate(row)}
        >
          {row.text}
        </button>
      )
  }
})

const rowBase =
  "group/row flex h-full cursor-default items-center gap-1.5 pr-2 text-[12.5px] transition-colors hover:bg-hover"

function SectionRow({
  row,
  onActivate,
  groupBy,
  focused,
}: {
  row: Extract<SidebarRow, { type: "section" }>
  onActivate: (r: SidebarRow) => void
  groupBy: string
  focused: boolean
}) {
  return (
    <div
      className={cn("group/sec flex h-full cursor-default items-center gap-1 pr-1.5 pl-1.5", focused && "bg-hover")}
      onClick={() => onActivate(row)}
    >
      <ChevronRight size={12} className={cn("shrink-0 text-fg-faint transition-transform", row.open && "rotate-90")} />
      <span className="section-label truncate">{row.label}</span>
      {row.count !== undefined && <span className="tabular text-[11px] text-fg-faint">{row.count}</span>}
      {row.key === "repos" && (
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/sec:opacity-100" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex size-5 items-center justify-center rounded-sm text-fg-faint hover:bg-selected hover:text-fg" title="Group by">
              <ListFilter size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              <DropdownMenuLabel className="text-[11px] text-fg-faint">Group by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={groupBy} onValueChange={(v) => setSidebarGroupBy(v as "repo")}>
                <DropdownMenuRadioItem value="repo">Repository</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="status">Status</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="recent">Recent activity</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            className="flex size-5 items-center justify-center rounded-sm text-fg-faint hover:bg-selected hover:text-fg"
            onClick={() => openNewSession()}
            title="New session"
          >
            <SquarePen size={12} />
          </button>
        </span>
      )}
    </div>
  )
}

function AttentionRow({
  row,
  focused,
  onActivate,
}: {
  row: Extract<SidebarRow, { type: "attention" }>
  focused: boolean
  onActivate: (r: SidebarRow) => void
}) {
  const { entry } = row
  const sessionId = entry.kind === "session" ? entry.id : entry.sessionId
  const session = useApp((s) => s.sessions[sessionId])
  const repoName = useApp((s) => (session?.repoId ? s.repos[session.repoId]?.name : "main"))
  const sub = useApp((s) => (entry.kind === "subagent" ? s.subagents[entry.id] : undefined))
  const active = useApp((s) => s.activeTab === `/session/${sessionId}`)
  const age = useRelTime(entry.at)
  if (!session) return null
  const summary =
    entry.kind === "subagent"
      ? `${sub?.agentType}: needs permission`
      : session.status === "done_unseen"
        ? `Done · ${session.title}`
        : session.status === "error"
          ? (session.errorMessage ?? session.title)
          : (session.waitingFor?.summary ?? session.title)
  return (
    <div
      className={cn(rowBase, "pl-[22px]", active && "bg-selected", focused && "ring-1 ring-ring/60 ring-inset")}
      onClick={() => onActivate(row)}
      title={`${repoName} · ${session.title}${row.index < 9 ? `  (Alt+${row.index + 1})` : ""}`}
    >
      <StatusGlyph status={entry.status} size="sm" />
      <span className="shrink-0 text-[11px] text-fg-faint">{repoName}</span>
      <span className={cn("truncate", entry.status === "done_unseen" ? "text-fg-muted" : "text-fg")}>{summary}</span>
      <span className="tabular ml-auto shrink-0 pl-1 text-[11px] text-fg-faint">{age}</span>
    </div>
  )
}

// Thread rows after Zed's Threads Sidebar / Orca / Conductor, simplified per Calm UI rules:
// one line at rest (glyph · title · age), a second line only for waiting / error / current activity.
function SessionRow({
  row,
  focused,
  onActivate,
}: {
  row: Extract<SidebarRow, { type: "session" }>
  focused: boolean
  onActivate: (r: SidebarRow) => void
}) {
  const session = useApp((s) => s.sessions[row.id])
  const active = useApp((s) => s.activeTab === `/session/${row.id}`)
  const selected = useApp((s) => s.selection?.kind === "session" && s.selection.id === row.id)
  const age = useRelTime(session?.updatedAt)
  if (!session) return null
  const isMain = session.role === "main"
  const note = row.twoLine
    ? session.status === "waiting_permission" || session.status === "waiting_input"
      ? session.waitingFor?.summary
      : session.status === "error"
        ? session.errorMessage
        : session.activity
    : undefined
  const noteTone =
    session.status === "waiting_permission"
      ? "text-st-perm-fg"
      : session.status === "waiting_input"
        ? "text-st-input-fg"
        : session.status === "error"
          ? "text-st-error-fg"
          : "text-fg-faint"
  return (
    <div
      className={cn(
        "group/row flex h-full cursor-default items-start gap-1.5 pr-2 transition-colors hover:bg-hover",
        row.twoLine ? "pt-[6px]" : "items-center",
        (active || selected) && "bg-selected",
        focused && "ring-1 ring-ring/60 ring-inset",
      )}
      style={{ paddingLeft: 6 + row.depth * 14 }}
      onClick={() => onActivate(row)}
      title={session.title}
    >
      {row.hasChildren ? (
        <button
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-faint opacity-60 hover:text-fg hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation()
            toggleSidebarNode(row.id)
          }}
          aria-label={row.open ? "Collapse" : "Expand"}
        >
          <ChevronRight size={12} className={cn("transition-transform", row.open && "rotate-90")} />
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <StatusGlyph status={session.status} size="sm" className={row.twoLine ? "mt-px" : undefined} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-[12.5px] leading-[17px]", isMain ? "font-medium text-fg" : session.status === "idle" ? "text-fg-muted" : "text-fg")}>
            {session.title}
          </span>
          {session.pinned && <Pin size={10} className="shrink-0 text-fg-faint" />}
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
            <span className="tabular text-[11px] text-fg-faint group-hover/row:hidden">{age}</span>
            {!isMain && (
              <button
                className="hidden size-4 items-center justify-center rounded-sm text-fg-faint group-hover/row:flex hover:bg-selected hover:text-fg"
                onClick={(e) => {
                  e.stopPropagation()
                  archiveSession(row.id)
                }}
                title="Archive"
                aria-label="Archive session"
              >
                <Archive size={11} />
              </button>
            )}
          </span>
        </div>
        {note && (
          <div className={cn("truncate text-[11.5px] leading-[16px]", noteTone)} title={note}>
            {note}
          </div>
        )}
      </div>
    </div>
  )
}

function SubagentRow({
  row,
  focused,
  onActivate,
}: {
  row: Extract<SidebarRow, { type: "subagent" }>
  focused: boolean
  onActivate: (r: SidebarRow) => void
}) {
  const sub = useApp((s) => s.subagents[row.id])
  const selected = useApp((s) => s.selection?.kind === "subagent" && s.selection.id === row.id)
  if (!sub) return null
  return (
    <div
      className={cn(rowBase, "text-[12px]", selected && "bg-selected", focused && "ring-1 ring-ring/60 ring-inset")}
      style={{ paddingLeft: 6 + row.depth * 14 + 16 }}
      onClick={() => onActivate(row)}
      title={`${sub.agentType}: ${sub.description}`}
    >
      <StatusGlyph status={subagentAsStatus(sub)} size="xs" />
      <span className="shrink-0 font-mono text-[11px] text-fg-faint">{sub.agentType}</span>
      <span className="truncate text-fg-muted">{sub.description}</span>
    </div>
  )
}

function RepoRow({
  row,
  focused,
  onActivate,
}: {
  row: Extract<SidebarRow, { type: "repo" }>
  focused: boolean
  onActivate: (r: SidebarRow) => void
}) {
  const repo = useApp((s) => s.repos[row.id])
  const rollup = useRepoRollup(row.id)
  const selected = useApp((s) => (s.selection?.kind === "repo" && s.selection.id === row.id) || s.activeTab === `/repo/${row.id}`)
  if (!repo) return null
  // Calm UI: one attention badge (most severe status + count of things that need you), plus a spinner if anything runs
  const perm = rollup.waiting_permission ?? 0
  const input = rollup.waiting_input ?? 0
  const err = rollup.error ?? 0
  const attention = perm + input + err
  const worst: SessionStatus | null = perm ? "waiting_permission" : input ? "waiting_input" : err ? "error" : null
  const working = rollup.working ?? 0
  return (
    <div
      className={cn(rowBase, "pl-1.5", selected && "bg-selected", focused && "ring-1 ring-ring/60 ring-inset")}
      onClick={() => onActivate(row)}
      onDoubleClick={() => openRepo(row.id)}
      title={repo.rootPath}
    >
      <ChevronRight size={12} className={cn("shrink-0 text-fg-faint transition-transform", row.open && "rotate-90")} />
      <span className="truncate font-medium text-fg">{repo.name}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-1 group-hover/row:hidden">
        {worst && (
          <span className="flex items-center gap-0.5 text-[11px] text-fg-muted" title={`${attention} need you`}>
            <StatusGlyph status={worst} size="xs" animate={false} title={null} />
            <span className="tabular">{attention}</span>
          </span>
        )}
        {working > 0 && (
          <span className="flex items-center gap-0.5 text-[11px] text-fg-faint" title={`${working} working`}>
            <StatusGlyph status="working" size="xs" animate={false} title={null} />
            <span className="tabular">{working}</span>
          </span>
        )}
      </span>
      <span className="ml-auto hidden shrink-0 items-center group-hover/row:flex">
        <button
          className="flex size-5 items-center justify-center rounded-sm text-fg-faint hover:bg-selected hover:text-fg"
          onClick={(e) => {
            e.stopPropagation()
            openNewSession(row.id)
          }}
          title={`New session in ${repo.name}`}
        >
          <Plus size={12} />
        </button>
      </span>
    </div>
  )
}

function SidebarContextMenu({ row }: { row: SidebarRow | null }) {
  const sessionId: ID | null =
    row?.type === "session" ? row.id : row?.type === "attention" ? (row.entry.kind === "session" ? row.entry.id : row.entry.sessionId) : null
  const session = useApp((s) => (sessionId ? s.sessions[sessionId] : undefined))
  if (row?.type === "repo") {
    return (
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onSelect={() => openRepo(row.id)}>Open repository</ContextMenuItem>
        <ContextMenuItem onSelect={() => openNewSession(row.id)}>
          New session here <ContextMenuShortcut>⌘N</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => navigate(`/graph/${row.id}`)}>Open code graph</ContextMenuItem>
      </ContextMenuContent>
    )
  }
  if (!session) return <ContextMenuContent className="hidden" />
  return (
    <ContextMenuContent className="min-w-52">
      <ContextMenuItem onSelect={() => openSession(session.id)}>Open</ContextMenuItem>
      <ContextMenuItem onSelect={() => openPopout(`/session/${session.id}`)}>
        <ExternalLink /> Open in new window
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => pinSession(session.id)}>
        <Pin /> {session.pinned ? "Unpin" : "Pin"}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => forkSession(session.id)}>
        <GitFork /> Fork session
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(`claude --resume ${session.providerSessionIds.at(-1)}`)}>
        <Copy /> Copy resume command
      </ContextMenuItem>
      {session.role !== "main" && (
        <>
          <ContextMenuSeparator />
          {session.archived ? (
            <ContextMenuItem onSelect={() => restoreSession(session.id)}>
              <ArchiveRestore /> Restore
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => archiveSession(session.id)}>
              <Archive /> Archive <ContextMenuShortcut>E</ContextMenuShortcut>
            </ContextMenuItem>
          )}
        </>
      )}
    </ContextMenuContent>
  )
}
