// Sessions view — UI_PLAN §5.2: inbox / active / recent / history / archive.
// Table mechanics adapted from langfuse/langfuse@48a3181:web/src/components/table/data-table.tsx
// (MIT, outside ee/): TanStack Table, column widths as CSS variables (cheap resizing), sort cycle
// desc → asc → off, sticky header. Modified: virtualized rows (TanStack Virtual), attention-tier
// default sort (Agent of Empires, MIT), archive/restore bulk actions, live cells per row.
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type RowSelectionState,
  type VisibilityState,
  type Row as TableRow,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  FolderGit2,
  ListFilter,
  Check,
  GitFork,
  Network,
  Pin,
  Play,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react"
import { getApp, useApp } from "@/store/app"
import { useStatusCounts, selectAttention } from "@/store/selectors"
import type { AppState } from "@/store/app"
import { archiveSessions, openSession, pinSession, restoreSessions, resumeSession, select, patchSettings } from "@/store/actions"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { ControlTag, EmptyState, Kbd, MOD } from "@/components/common/bits"
import { useRelTime } from "@/components/common/RelativeTime"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { modelShort, STATUS_LABEL, STATUS_TIER } from "@/lib/status"
import { usd } from "@/lib/format"
import type { ControlMode, ID, Session, SessionStatus } from "@/lib/model"
import { cn } from "@/lib/utils"
import { setSessionsFilter, useSessionsUi, type SessionsViewName } from "./sessionsUi"
import { prepareQuery, scoreSession } from "./search"
import { cmpIso, compareAttentionFast } from "@/features/sessions/search"

const DAY = 86_400_000

const VIEWS: { id: SessionsViewName; label: string; hint: string }[] = [
  { id: "attention", label: "Needs you", hint: "Waiting for you, failed, or finished and not yet seen" },
  { id: "active", label: "Active", hint: "Running and idle sessions" },
  { id: "recent", label: "Recent", hint: "Updated in the last 7 days" },
  { id: "history", label: "History", hint: "Ended sessions you can resume or fork" },
  { id: "archived", label: "Archive", hint: "Hidden from the map, sidebar and lists. Nothing is deleted; restore any time." },
]

function inView(s: Session, view: SessionsViewName, now: number) {
  switch (view) {
    case "attention":
      return !s.archived && s.control !== "history" && STATUS_TIER[s.status] <= 2
    case "active":
      return !s.archived && s.control !== "history"
    case "recent":
      return !s.archived && now - Date.parse(s.updatedAt) < 7 * DAY
    case "history":
      return !s.archived && s.control === "history"
    case "archived":
      return s.archived
  }
}

type Row = { kind: "session"; s: Session; repo: string } | { kind: "group"; repoId: ID; repo: string; count: number }

/** Archive / history counts only change on structural updates; don't rescan 5k sessions per tick. */
let countsCache: { v: number; archived: number; history: number } | null = null
function selectViewCounts(s: AppState) {
  if (countsCache?.v === s.structVersion) return countsCache
  let archived = 0
  let history = 0
  for (const id in s.sessions) {
    const x = s.sessions[id]
    if (x.archived) archived++
    else if (x.control === "history") history++
  }
  countsCache = { v: s.structVersion, archived, history }
  return countsCache
}

/** Columns dropped first when the table is narrower than the sum of column widths. */
const DROP_ORDER = ["unpushed", "control", "model", "cost", "ctx", "branch", "diff", "repo"]
const OPTIONAL_COLUMNS: { id: string; label: string }[] = [
  { id: "repo", label: "Repo" },
  { id: "activity", label: "Activity" },
  { id: "updated", label: "Last" },
  { id: "branch", label: "Branch" },
  { id: "diff", label: "Changes" },
  { id: "unpushed", label: "Unpushed" },
  { id: "ctx", label: "Context" },
  { id: "cost", label: "Cost" },
  { id: "model", label: "Model" },
  { id: "control", label: "Mode" },
]

export default function SessionsView() {
  const ui = useSessionsUi()
  const structVersion = useApp((s) => s.structVersion)
  const statusVersion = useApp((s) => s.statusVersion)
  const density = useApp((s) => s.settings.density)
  const counts = useStatusCounts()
  const archivedCount = useApp((s) => selectViewCounts(s).archived)
  const historyCount = useApp((s) => selectViewCounts(s).history)
  const attentionCount = useApp((s) => selectAttention(s).filter((e) => e.kind === "session").length)
  const [sorting, setSorting] = useState<SortingState>([])
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const searchRef = useRef<HTMLInputElement>(null)

  // reset selection when the view changes
  useEffect(() => setRowSelection({}), [ui.view])

  // Search runs on a deferred copy so typing stays responsive over 5k rows; status ticks only
  // matter for views whose membership depends on status (history/archive rows never change).
  const query = useDeferredValue(ui.query)
  const statusDep = ui.view === "history" || ui.view === "archived" ? 0 : statusVersion
  const data = useMemo(() => {
    const st = getApp()
    const now = Date.now()
    const pq = prepareQuery(query)
    const q = pq.tokens.length > 0
    const out: { s: Session; repo: string; score: number }[] = []
    for (const s of Object.values(st.sessions)) {
      if (!inView(s, ui.view, now)) continue
      if (ui.status.length && !ui.status.includes(s.status)) continue
      if (ui.repos.length && !(s.repoId && ui.repos.includes(s.repoId))) continue
      if (ui.control.length && !ui.control.includes(s.control)) continue
      if (ui.model.length && !ui.model.includes(modelShort(s.model))) continue
      const repo = s.repoId ? st.repos[s.repoId].name : "main"
      let score = 1
      if (q) {
        score = scoreSession(pq, s, repo)
        if (!score) continue
      }
      out.push({ s, repo, score })
    }
    if (q) out.sort((a, b) => b.score - a.score)
    else if (ui.view === "history" || ui.view === "archived" || ui.view === "recent")
      out.sort((a, b) => cmpIso(b.s.archivedAt ?? b.s.updatedAt, a.s.archivedAt ?? a.s.updatedAt))
    else out.sort((a, b) => compareAttentionFast(a.s, b.s, STATUS_TIER))
    return out.map(({ s, repo }) => ({ s, repo }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.view, query, ui.status, ui.repos, ui.control, ui.model, structVersion, statusDep])

  const columns = useMemo<ColumnDef<{ s: Session; repo: string }>[]>(
    () => [
      {
        id: "select",
        size: 30,
        enableSorting: false,
        enableResizing: false,
        header: ({ table }) => (
          <Checkbox
            checked={table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? "indeterminate" : false}
            onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
            aria-label="Select all"
            className="size-3.5"
          />
        ),
        cell: ({ row, table }) => (
          <RowCheck checked={row.getIsSelected()} onToggle={() => row.toggleSelected()} hidden={!row.getIsSelected() && !table.getIsSomeRowsSelected()} />
        ),
      },
      {
        id: "status",
        size: 28,
        enableResizing: false,
        accessorFn: (r) => STATUS_TIER[r.s.status],
        sortingFn: "basic",
        header: () => <span className="sr-only">Status</span>,
        cell: ({ row }) => <LiveStatus id={row.original.s.id} />,
      },
      {
        id: "title",
        size: 260,
        accessorFn: (r) => r.s.title,
        sortingFn: "text",
        header: "Title",
        cell: ({ row }) => <TitleCell s={row.original.s} />,
      },
      { id: "repo", size: 124, accessorFn: (r) => r.repo, sortingFn: "text", header: "Repo", cell: ({ row }) => <span className="truncate text-fg-muted">{row.original.repo}</span> },
      {
        id: "activity",
        size: 230,
        enableSorting: false,
        header: "Activity",
        cell: ({ row }) => <LiveActivity id={row.original.s.id} />,
      },
      {
        id: "updated",
        size: 64,
        accessorFn: (r) => r.s.updatedAt,
        sortingFn: "basic",
        sortDescFirst: true,
        header: "Last",
        cell: ({ row }) => <LiveAge id={row.original.s.id} />,
      },
      {
        id: "branch",
        size: 140,
        accessorFn: (r) => r.s.cwd,
        sortingFn: "text",
        header: "Branch",
        cell: ({ row }) => <BranchCell s={row.original.s} />,
      },
      {
        id: "diff",
        size: 92,
        accessorFn: (r) => r.s.diff.linesAdded + r.s.diff.linesRemoved,
        sortingFn: "basic",
        sortDescFirst: true,
        header: "Changes",
        cell: ({ row }) => <LiveDiff id={row.original.s.id} />,
      },
      {
        id: "unpushed",
        size: 40,
        accessorFn: (r) => r.s.diff.unpushed,
        sortingFn: "basic",
        sortDescFirst: true,
        header: "↑",
        cell: ({ row }) =>
          row.original.s.diff.unpushed ? <span className="tabular text-[11px] text-fg-faint">{row.original.s.diff.unpushed}</span> : null,
      },
      {
        id: "ctx",
        size: 52,
        accessorFn: (r) => r.s.usage.contextPct,
        sortingFn: "basic",
        sortDescFirst: true,
        header: "Ctx",
        cell: ({ row }) => <LiveCtx id={row.original.s.id} />,
      },
      {
        id: "cost",
        size: 62,
        accessorFn: (r) => r.s.usage.costUsd,
        sortingFn: "basic",
        sortDescFirst: true,
        header: "Cost",
        cell: ({ row }) => <LiveCost id={row.original.s.id} />,
      },
      { id: "model", size: 64, accessorFn: (r) => modelShort(r.s.model), sortingFn: "text", header: "Model", cell: ({ getValue }) => <span className="text-fg-muted">{getValue() as string}</span> },
      { id: "control", size: 52, accessorFn: (r) => r.s.control, sortingFn: "text", header: "Mode", cell: ({ row }) => <ControlTag mode={row.original.s.control} /> },
    ],
    [],
  )

  // Responsive columns: measure the table viewport and drop low-priority columns until the
  // fixed widths fit (Linear / Trigger.dev tables show fewer columns rather than scrolling).
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewportW, setViewportW] = useState(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setViewportW(Math.round(e.contentRect.width / 8) * 8))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})
  const hasActivity = useMemo(() => data.some((r) => r.s.status === "error" || r.s.status === "working" || !!r.s.waitingFor), [data])
  const columnVisibility = useMemo<VisibilityState>(() => {
    const vis: VisibilityState = {}
    for (const id of ui.hiddenColumns) vis[id] = false
    if (ui.groupByRepo) vis.repo = false
    // an Activity column with nothing in it is noise (e.g. History): hide it until a row has signal
    if (!hasActivity) vis.activity = false
    if (!viewportW) return vis
    const width = (c: ColumnDef<{ s: Session; repo: string }>) => columnSizing[c.id!] ?? c.size ?? 100
    let total = columns.reduce((n, c) => n + (vis[c.id!] === false ? 0 : width(c)), 0)
    for (const id of DROP_ORDER) {
      if (total <= viewportW) break
      if (vis[id] === false) continue
      vis[id] = false
      total -= width(columns.find((c) => c.id === id)!)
    }
    return vis
  }, [ui.hiddenColumns, ui.groupByRepo, viewportW, columns, columnSizing, hasActivity])

  const table = useReactTable({
    data,
    columns,
    state: { sorting, rowSelection, columnVisibility, columnSizing },
    onColumnSizingChange: setColumnSizing,
    getRowId: (r) => r.s.id,
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  // column widths as CSS variables, recomputed only while sizing changes (Langfuse pattern)
  const colVars = useMemo(() => {
    const vars: Record<string, string> = {}
    for (const h of table.getFlatHeaders()) vars[`--col-${h.column.id}`] = `${h.getSize()}px`
    return vars
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnSizing, columns, columnVisibility])
  const headers = table.getHeaderGroups()[0]?.headers ?? []
  const colKey = headers.map((h) => h.id).join(",")

  const sortedRows = table.getRowModel().rows
  const rows: Row[] = useMemo(() => {
    if (!ui.groupByRepo) return sortedRows.map((r) => ({ kind: "session" as const, s: r.original.s, repo: r.original.repo }))
    const groups = new Map<string, { repoId: ID; repo: string; items: Row[] }>()
    for (const r of sortedRows) {
      const key = r.original.s.repoId ?? "main"
      const g = groups.get(key) ?? { repoId: key, repo: r.original.repo, items: [] }
      g.items.push({ kind: "session", s: r.original.s, repo: r.original.repo })
      groups.set(key, g)
    }
    const out: Row[] = []
    for (const g of [...groups.values()].sort((a, b) => a.repo.localeCompare(b.repo))) {
      out.push({ kind: "group", repoId: g.repoId, repo: g.repo, count: g.items.length })
      out.push(...g.items)
    }
    return out
  }, [sortedRows, ui.groupByRepo])

  const rowH = density === "comfortable" ? 32 : 28
  // Stable callbacks: the virtualizer re-measures every item whenever these change identity,
  // which with inline lambdas meant a 4.7k-item measurement pass on every scroll frame.
  const estimateSize = useCallback((i: number) => (rows[i].kind === "group" ? 28 : rowH), [rows, rowH])
  const getItemKey = useCallback(
    (i: number) => {
      const r = rows[i]
      return r.kind === "group" ? `g:${r.repoId}` : r.s.id
    },
    [rows],
  )
  const getScrollElement = useCallback(() => scrollRef.current, [])
  // useFlushSync: false — react-virtual otherwise re-renders synchronously inside every scroll
  // event (flushSync); batching to the next frame halved scroll frame time on 4.7k rows.
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement, estimateSize, overscan: 12, getItemKey, useFlushSync: false })
  useEffect(() => {
    virtualizer.measure()
  }, [rowH, virtualizer])

  const [focus, setFocus] = useState(-1)
  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k])
  const totalWidth = table.getTotalSize()

  const filtered = !!ui.query.trim() || ui.repos.length > 0 || ui.status.length > 0 || ui.control.length > 0
  const viewCount: Record<SessionsViewName, number | undefined> = {
    attention: attentionCount,
    active: counts.working + counts.waiting_input + counts.waiting_permission + counts.idle + counts.done_unseen + counts.error + counts.starting,
    recent: undefined,
    history: historyCount,
    archived: archivedCount,
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      let i = Math.max(0, Math.min(rows.length - 1, focus + (e.key === "ArrowDown" ? 1 : -1)))
      if (rows[i]?.kind === "group") i = Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))
      setFocus(i)
      virtualizer.scrollToIndex(i)
      const r = rows[i]
      if (r?.kind === "session") select({ kind: "session", id: r.s.id })
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault()
      const i = e.key === "Home" ? rows.findIndex((r) => r.kind === "session") : rows.length - 1
      if (i < 0) return
      setFocus(i)
      virtualizer.scrollToIndex(i)
    } else if (e.key === "Enter") {
      const r = rows[focus]
      if (r?.kind !== "session") return
      // Cmd/Ctrl+Enter on a history row resumes it (UI_PLAN §5.2)
      if ((e.metaKey || e.ctrlKey) && r.s.control === "history" && !r.s.archived) resumeSession(r.s.id)
      else openSession(r.s.id)
    } else if (e.key === "x" || e.key === " ") {
      const r = rows[focus]
      if (r?.kind !== "session") return
      e.preventDefault()
      setRowSelection((sel) => ({ ...sel, [r.s.id]: !sel[r.s.id] }))
    } else if (e.key === "Escape" && selectedIds.length) {
      setRowSelection({})
    } else if (e.key === "e" || e.key === "E") {
      const r = rows[focus]
      const ids = selectedIds.length ? selectedIds : r?.kind === "session" ? [r.s.id] : []
      if (!ids.length) return
      if (ui.view === "archived") restoreSessions(ids)
      else archiveSessions(ids)
      setRowSelection({})
    } else if (e.key === "/" ) {
      e.preventDefault()
      searchRef.current?.focus()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas" onKeyDown={onKeyDown}>
      {/* toolbar (one row): views · search · filter … view options */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
        <div className="flex shrink-0 items-center rounded-md border border-line-subtle bg-chrome p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setSessionsFilter({ view: v.id })}
              title={`${v.hint}${viewCount[v.id] !== undefined ? ` (${viewCount[v.id]})` : ""}`}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs whitespace-nowrap transition-colors",
                ui.view === v.id ? "bg-selected text-fg" : "text-fg-faint hover:text-fg-muted",
              )}
            >
              {v.label}
              {v.id === "attention" && attentionCount > 0 && <span className="tabular text-[11px] text-fg-muted">{attentionCount}</span>}
            </button>
          ))}
        </div>
        <div className="relative flex h-7 max-w-[240px] min-w-[120px] flex-1 items-center">
          <Search size={13} className="absolute left-2 text-fg-faint" />
          <input
            ref={searchRef}
            data-qa="sessions-search"
            value={ui.query}
            onChange={(e) => setSessionsFilter({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (ui.query) setSessionsFilter({ query: "" })
                else e.currentTarget.blur()
              } else if (e.key === "ArrowDown") {
                e.preventDefault()
                scrollRef.current?.focus()
                const i = rows.findIndex((r) => r.kind === "session")
                if (i >= 0) {
                  setFocus(i)
                  const r = rows[i]
                  if (r.kind === "session") select({ kind: "session", id: r.s.id })
                }
              }
            }}
            placeholder="Search"
            title="Title, prompt, branch or repo"
            className="h-full w-full rounded-md border border-line-subtle bg-chrome pr-6 pl-7 text-xs text-fg outline-none placeholder:text-fg-faint focus:border-line-strong"
          />
          {ui.query ? (
            <button className="absolute right-1.5 text-fg-faint hover:text-fg" onClick={() => setSessionsFilter({ query: "" })} aria-label="Clear search">
              <X size={12} />
            </button>
          ) : (
            <Kbd className="pointer-events-none absolute right-1.5 h-4 min-w-4 text-[10px]">/</Kbd>
          )}
        </div>
        <FilterMenu />
        <div className="ml-auto flex items-center gap-1">
          {filtered && (
            <span data-qa="sessions-count" className="tabular mr-1 text-[11px] whitespace-nowrap text-fg-faint">
              {data.length.toLocaleString()}
            </span>
          )}
          <ViewMenu hiddenByWidth={DROP_ORDER.filter((id) => columnVisibility[id] === false && !ui.hiddenColumns.includes(id) && !(id === "repo" && ui.groupByRepo))} />
        </div>
      </div>

      {/* bulk bar */}
      {selectedIds.length > 0 && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-subtle bg-chrome px-3 text-xs">
          <span className="tabular text-fg-muted">{selectedIds.length} selected</span>
          {ui.view === "archived" ? (
            <Button size="sm" title="Restore (E)" onClick={() => { restoreSessions(selectedIds); setRowSelection({}) }}>
              <ArchiveRestore /> Restore
            </Button>
          ) : (
            <Button size="sm" title="Archive (E)" onClick={() => { archiveSessions(selectedIds); setRowSelection({}) }}>
              <Archive /> Archive
            </Button>
          )}
          {ui.view !== "archived" && (
            <Button size="sm" variant="ghost" onClick={() => selectedIds.forEach((id) => pinSession(id, true))}>
              <Pin /> Pin
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setRowSelection({})}>
            Clear
          </Button>
        </div>
      )}

      {/* table */}
      <div ref={scrollRef} data-qa="sessions-table" className="relative min-h-0 flex-1 overflow-auto outline-none contain-strict" tabIndex={0} style={colVars as React.CSSProperties}>
        {data.length === 0 ? (
          <EmptyState>
            {ui.query
              ? `No matches for “${ui.query}”.`
              : ui.view === "attention"
                ? "Nothing needs you."
                : ui.view === "archived"
                  ? "Archive is empty."
                  : "No sessions."}
          </EmptyState>
        ) : (
          <div style={{ width: Math.max(totalWidth, 0), minWidth: "100%" }}>
            <div className="sticky top-0 z-10 flex h-7 items-stretch border-b border-line-subtle bg-chrome text-[11px] text-fg-faint">
              {headers.map((h) => {
                const sorted = h.column.getIsSorted()
                return (
                  <div
                    key={h.id}
                    className={cn(
                      "group/th relative flex shrink-0 items-center gap-1 px-2 select-none first:pl-3",
                      h.column.getCanSort() && "cursor-pointer hover:text-fg-muted",
                      h.id === "title" && "grow",
                    )}
                    style={{ width: `var(--col-${h.id})`, minWidth: `var(--col-${h.id})` }}
                    onClick={h.column.getToggleSortingHandler()}
                  >
                    <span className="truncate">{flexRender(h.column.columnDef.header, h.getContext())}</span>
                    {sorted === "desc" ? <ArrowDown size={11} /> : sorted === "asc" ? <ArrowUp size={11} /> : null}
                    {h.column.getCanResize() && (
                      <div
                        onMouseDown={h.getResizeHandler()}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-1 right-0 bottom-1 w-1 cursor-col-resize rounded-sm opacity-0 group-hover/th:bg-line-strong group-hover/th:opacity-100"
                      />
                    )}
                  </div>
                )
              })}
            </div>
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const r = rows[vi.index]
                if (r.kind === "group") {
                  return (
                    <div
                      key={vi.key}
                      className="absolute inset-x-0 flex items-center gap-2 border-b border-line-subtle bg-chrome/60 px-3 text-xs"
                      style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}
                    >
                      {r.repoId === "main" ? <Network size={12} className="text-fg-faint" /> : <FolderGit2 size={12} className="text-fg-faint" />}
                      <span className="font-medium text-fg">{r.repo}</span>
                      <span className="tabular text-[11px] text-fg-faint">{r.count}</span>
                    </div>
                  )
                }
                return (
                  <SessionRow
                    key={vi.key}
                    row={table.getRow(r.s.id)}
                    index={vi.index}
                    top={vi.start}
                    height={vi.size}
                    focused={vi.index === focus}
                    selected={!!rowSelection[r.s.id]}
                    someSelected={selectedIds.length > 0}
                    colKey={colKey}
                    onFocusRow={setFocus}
                  />
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

type TRow = TableRow<{ s: Session; repo: string }>

/**
 * Row checkbox with the same look as ui/checkbox but without Radix (Provider, Presence,
 * bubble input): mounting ~40 of those per scroll/view switch was the biggest row cost.
 */
function RowCheck({ checked, onToggle, hidden }: { checked: boolean; onToggle: () => void; hidden: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label="Select row"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border outline-none focus-visible:ring-1 focus-visible:ring-ring",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-input bg-input/30",
        hidden && "opacity-0 group-hover/tr:opacity-100 focus-visible:opacity-100",
      )}
    >
      {checked && <Check size={10} strokeWidth={3} />}
    </button>
  )
}

/**
 * One table row. Memoized on primitive props + the TanStack row object (stable until the data
 * or sort changes), so scrolling only renders rows entering the viewport.
 */
const SessionRow = memo(function SessionRow({
  row,
  index,
  top,
  height,
  focused,
  selected,
  onFocusRow,
}: {
  row: TRow
  index: number
  top: number
  height: number
  focused: boolean
  selected: boolean
  /** any row selected: checkboxes stay visible (keeps memo honest when selection changes) */
  someSelected: boolean
  /** visible column ids; changes re-render the row */
  colKey: string
  onFocusRow: (index: number) => void
}) {
  const id = row.id
  const inspected = useApp((s) => s.selection?.kind === "session" && s.selection.id === id)
  return (
    <div
      className={cn(
        "group/tr absolute inset-x-0 flex cursor-default items-stretch border-b border-line-subtle/70 text-xs hover:bg-hover",
        (inspected || selected) && "bg-selected/70",
        focused && "ring-1 ring-ring/60 ring-inset",
      )}
      style={{ height, transform: `translateY(${top}px)` }}
      onClick={() => {
        onFocusRow(index)
        select({ kind: "session", id })
      }}
      onDoubleClick={() => openSession(id)}
    >
      {row.getVisibleCells().map((cell) => (
        <div
          key={cell.id}
          className={cn("flex min-w-0 shrink-0 items-center px-2 first:pl-3", cell.column.id === "title" && "grow")}
          style={{ width: `var(--col-${cell.column.id})`, minWidth: `var(--col-${cell.column.id})` }}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </div>
      ))}
      <RowActions id={id} />
    </div>
  )
})

function TitleCell({ s }: { s: Session }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {s.role === "main" && <Network size={12} className="shrink-0 text-fg-faint" aria-label="Main agent" />}
      {s.parent?.kind === "forked" && <GitFork size={11} className="shrink-0 text-fg-faint" aria-label="Forked" />}
      <span
        className={cn("truncate", s.status === "stopped" || s.archived ? "text-fg-muted" : "text-fg")}
        title={s.parent?.kind === "delegated" ? `${s.title} · delegated by the main agent` : s.title}
      >
        {s.title}
      </span>
      {s.pinned && <Pin size={10} className="shrink-0 text-fg-faint" aria-label="Pinned" />}
    </span>
  )
}

function BranchCell({ s }: { s: Session }) {
  const branch = useApp((st) => {
    const repo = s.repoId ? st.repos[s.repoId] : undefined
    return repo?.worktrees.find((w) => w.id === s.worktreeId)?.branch ?? repo?.defaultBranch ?? ""
  })
  return <span className="truncate font-mono text-[11px] text-fg-faint" title={branch}>{branch}</span>
}

function LiveStatus({ id }: { id: ID }) {
  const status = useApp((s) => s.sessions[id]?.status)
  return status ? <StatusGlyph status={status} size="sm" /> : null
}
function LiveAge({ id }: { id: ID }) {
  const iso = useApp((s) => s.sessions[id]?.updatedAt)
  const t = useRelTime(iso)
  return <span className="tabular text-[11px] text-fg-faint">{t}</span>
}
function LiveActivity({ id }: { id: ID }) {
  const s = useApp((st) => st.sessions[id])
  if (!s) return null
  // Calm UI (§2.5): text only when it carries signal: waiting, error, or what it does right now.
  const text = s.status === "error" ? s.errorMessage : s.waitingFor ? s.waitingFor.summary : s.status === "working" ? s.activity : undefined
  const tone =
    s.status === "waiting_permission"
      ? "text-st-perm-fg"
      : s.status === "waiting_input"
        ? "text-st-input-fg"
        : s.status === "error"
          ? "text-st-error-fg"
          : "text-fg-faint"
  return (
    <span className={cn("truncate", tone, s.waitingFor?.kind === "permission" && "font-mono text-[11px]")} title={text}>
      {text}
    </span>
  )
}
// Neutral +/− here: green/red diff colors are reserved for diff views (§2.5 color budget).
function LiveDiff({ id }: { id: ID }) {
  const d = useApp((s) => s.sessions[id]?.diff)
  if (!d || !d.filesChanged) return null
  return (
    <span className="tabular text-[11px] text-fg-faint" title={`${d.filesChanged} files`}>
      +{d.linesAdded} −{d.linesRemoved}
    </span>
  )
}
function LiveCtx({ id }: { id: ID }) {
  const v = useApp((s) => s.sessions[id]?.usage.contextPct ?? 0)
  return <span className={cn("tabular text-[11px]", v > 80 ? "text-fg-muted" : "text-fg-faint")}>{v}%</span>
}
function LiveCost({ id }: { id: ID }) {
  const v = useApp((s) => s.sessions[id]?.usage.costUsd ?? 0)
  return <span className="tabular text-[11px] text-fg-faint">{usd(v)}</span>
}

/**
 * Hover actions float over the row's right edge (Linear / Trigger.dev pattern) instead of
 * taking a column, so narrow windows keep their data columns.
 */
function RowActions({ id }: { id: ID }) {
  const s = useApp((st) => st.sessions[id])
  if (!s) return null
  const btn = "flex h-5 items-center gap-1 rounded-sm px-1.5 text-[11px] text-fg-muted hover:bg-selected hover:text-fg"
  return (
    <span className="absolute inset-y-0 right-0 hidden items-center gap-0.5 bg-hover pr-2 pl-3 group-hover/tr:flex">
      {s.control === "history" && !s.archived && (
        <button
          className={btn}
          onClick={(e) => {
            e.stopPropagation()
            resumeSession(s.id)
          }}
          title={`Resume this session (claude --resume) · ${MOD}+Enter`}
        >
          <Play size={11} /> Resume
        </button>
      )}
      {s.archived ? (
        <button
          className={btn}
          onClick={(e) => {
            e.stopPropagation()
            restoreSessions([s.id])
          }}
          title="Restore to the map and lists (E)"
        >
          <ArchiveRestore size={11} /> Restore
        </button>
      ) : s.role !== "main" ? (
        <button
          className="flex size-5 items-center justify-center rounded-sm text-fg-faint hover:bg-selected hover:text-fg"
          onClick={(e) => {
            e.stopPropagation()
            archiveSessions([s.id])
          }}
          title="Archive (E)"
          aria-label="Archive"
        >
          <Archive size={12} />
        </button>
      ) : null}
    </span>
  )
}

/** One menu for view options (§2.5: toolbars show 3–5 controls, the rest go into one menu). */
function ViewMenu({ hiddenByWidth }: { hiddenByWidth: string[] }) {
  const hidden = useSessionsUi((s) => s.hiddenColumns)
  const groupByRepo = useSessionsUi((s) => s.groupByRepo)
  const density = useApp((s) => s.settings.density)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" title="View options" aria-label="View options">
          <SlidersHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuCheckboxItem checked={groupByRepo} onSelect={(e) => e.preventDefault()} onCheckedChange={(v) => setSessionsFilter({ groupByRepo: !!v })} className="text-xs">
          Group by repo
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={density === "comfortable"}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => patchSettings({ density: v ? "comfortable" : "compact" })}
          className="text-xs"
        >
          Taller rows
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] text-fg-faint">Columns</DropdownMenuLabel>
        {OPTIONAL_COLUMNS.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.id}
            checked={!hidden.includes(c.id)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => setSessionsFilter({ hiddenColumns: toggle(hidden, c.id) })}
            className="text-xs"
            title={hiddenByWidth.includes(c.id) ? "Not enough room at this width" : undefined}
          >
            <span className={cn(hiddenByWidth.includes(c.id) && "text-fg-faint")}>{c.label}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------- filter ----------
function toggle<T>(list: T[], v: T) {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

const STATUS_OPTIONS: SessionStatus[] = ["waiting_permission", "waiting_input", "error", "done_unseen", "working", "starting", "idle", "stopped"]
const CONTROL_OPTIONS: { id: ControlMode; label: string }[] = [
  { id: "owned", label: "Started here" },
  { id: "pty", label: "Interactive" },
  { id: "observed", label: "Observed" },
  { id: "history", label: "History" },
]

/** Linear-style single Filter button: Repo / Status / Mode in submenus. */
function FilterMenu() {
  const repos = useSessionsUi((s) => s.repos)
  const status = useSessionsUi((s) => s.status)
  const control = useSessionsUi((s) => s.control)
  const all = useApp((s) => s.repoOrder)
  const names = useApp((s) => s.repos)
  const count = repos.length + status.length + control.length
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
          count ? "border-line bg-elevated text-fg" : "border-line-subtle text-fg-faint hover:text-fg-muted",
        )}
      >
        <ListFilter size={13} />
        Filter
        {count > 0 && <span className="tabular rounded-sm bg-selected px-1 text-[10.5px]">{count}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">
            Repo {repos.length > 0 && <span className="tabular ml-auto pl-3 text-[11px] text-fg-faint">{repos.length}</span>}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 min-w-48 overflow-y-auto">
            {all.map((id) => (
              <DropdownMenuCheckboxItem key={id} checked={repos.includes(id)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => setSessionsFilter({ repos: toggle(repos, id) })} className="text-xs">
                {names[id].name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">
            Status {status.length > 0 && <span className="tabular ml-auto pl-3 text-[11px] text-fg-faint">{status.length}</span>}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-48">
            {STATUS_OPTIONS.map((st) => (
              <DropdownMenuCheckboxItem key={st} checked={status.includes(st)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => setSessionsFilter({ status: toggle(status, st) })} className="text-xs">
                <StatusGlyph status={st} size="xs" animate={false} title={null} />
                {STATUS_LABEL[st]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">
            Mode {control.length > 0 && <span className="tabular ml-auto pl-3 text-[11px] text-fg-faint">{control.length}</span>}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-44">
            {CONTROL_OPTIONS.map((c) => (
              <DropdownMenuCheckboxItem key={c.id} checked={control.includes(c.id)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => setSessionsFilter({ control: toggle(control, c.id) })} className="text-xs">
                <ControlTag mode={c.id} />
                {c.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {count > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs" onSelect={() => setSessionsFilter({ repos: [], status: [], control: [], model: [] })}>
              Clear filters
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
