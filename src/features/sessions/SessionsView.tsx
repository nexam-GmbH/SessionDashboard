// Sessions view — UI_PLAN §5.2: inbox / active / recent / history / archive.
// Table mechanics adapted from langfuse/langfuse@48a3181:web/src/components/table/data-table.tsx
// (MIT, outside ee/): TanStack Table, column widths as CSS variables (cheap resizing), sort cycle
// desc → asc → off, sticky header. Modified: virtualized rows (TanStack Virtual), attention-tier
// default sort (Agent of Empires, MIT), archive/restore bulk actions, live cells per row.
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type RowSelectionState,
  type VisibilityState,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useShallow } from "zustand/react/shallow"
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
import { selectAttention, selectStatusCounts, selectWaitingCount, EMPTY } from "@/store/selectors"
import type { AppState } from "@/store/app"
import { openSession, pinSession, resumeSession, select, patchSettings } from "@/store/actions"
import { archiveWithUndo, restoreWithUndo } from "@/features/notifications/undo"
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
  { id: "attention", label: "Needs you", hint: "Waiting for you or failed (the same count as the title bar and sidebar)" },
  { id: "active", label: "Active", hint: "Running and idle sessions" },
  { id: "recent", label: "Recent", hint: "Updated in the last 7 days" },
  { id: "history", label: "History", hint: "Ended sessions you can resume or fork" },
  { id: "archived", label: "Archive", hint: "Hidden from the map, sidebar and lists. Nothing is deleted; restore any time." },
]

/**
 * Attention tier with subagents folded in: a session whose subagent waits for permission needs
 * you (tier 0), whatever its own status says. Same rule as the sidebar queue and the title bar.
 */
function tierOf(s: Session, subWaiting: Set<ID>) {
  return subWaiting.has(s.id) ? 0 : STATUS_TIER[s.status]
}

const VIEW_IDS: SessionsViewName[] = ["attention", "active", "recent", "history", "archived"]

function inView(s: Session, view: SessionsViewName, now: number, subWaiting: Set<ID>) {
  switch (view) {
    case "attention":
      // "Needs you" means waiting + errors everywhere (selectWaitingCount); finished-unseen
      // sessions sort first in Active and have their own "Done" section in the sidebar
      return !s.archived && s.control !== "history" && tierOf(s, subWaiting) <= 1
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

type Item = { kind: "session"; s: Session; repo: string }
type Row = Item | { kind: "group"; repoId: ID; repo: string; count: number }
/** TanStack only holds column state (sizes, visibility, sort state, resizing); rows are plain arrays */
const NO_ROWS: Item[] = []
/**
 * One row item per session record (records are replaced on every change): a list recomputed on a
 * status tick hands unchanged sessions the same item, so their rows skip re-rendering.
 */
const itemCache = new WeakMap<Session, Item>()
function itemFor(s: Session, repo: string): Item {
  let it = itemCache.get(s)
  if (!it || it.repo !== repo) {
    it = { kind: "session", s, repo }
    itemCache.set(s, it)
  }
  return it
}

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
  // status ticks only matter for views whose membership or order depends on status (history and
  // archive rows never change), so those views don't even re-render on a tick
  const statusDep = useApp((s) => (ui.view === "history" || ui.view === "archived" ? 0 : s.statusVersion))
  const density = useApp((s) => s.settings.density)
  const activeCount = useApp((s) => {
    const c = selectStatusCounts(s)
    return c.working + c.waiting_input + c.waiting_permission + c.idle + c.done_unseen + c.error + c.starting
  })
  const archivedCount = useApp((s) => selectViewCounts(s).archived)
  const historyCount = useApp((s) => selectViewCounts(s).history)
  const attentionCount = useApp(selectWaitingCount)
  const [sorting, setSorting] = useState<SortingState>([])
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const searchRef = useRef<HTMLInputElement>(null)

  // reset selection when the view changes
  useEffect(() => setRowSelection({}), [ui.view])

  // Keyboard: arriving here (G S, palette, tab click) puts focus on the table when nothing else
  // has it, so arrows / x / E work at once, and "/" focuses search from anywhere while this tab is
  // visible (effects are torn down while the tab is hidden under <Activity>).
  useEffect(() => {
    if (document.activeElement === document.body) scrollRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (document.querySelector("[role=dialog],[role=menu]")) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Search runs on a deferred copy so typing stays responsive over 5k rows.
  const query = useDeferredValue(ui.query)
  const { data, matchCounts } = useMemo(() => {
    const st = getApp()
    const now = Date.now()
    const pq = prepareQuery(query)
    const q = pq.tokens.length > 0
    const subWaiting = new Set<ID>()
    for (const e of selectAttention(st)) if (e.kind === "subagent") subWaiting.add(e.sessionId)
    const out: { s: Session; repo: string; score: number }[] = []
    // while searching, every view tab shows how many matches it holds (no dead-end "No matches")
    const counts: Record<SessionsViewName, number> = { attention: 0, active: 0, recent: 0, history: 0, archived: 0 }
    for (const s of Object.values(st.sessions)) {
      const here = inView(s, ui.view, now, subWaiting)
      if (!here && !q) continue
      if (ui.status.length && !ui.status.includes(s.status)) continue
      if (ui.repos.length && !(s.repoId && ui.repos.includes(s.repoId))) continue
      if (ui.control.length && !ui.control.includes(s.control)) continue
      if (ui.model.length && !ui.model.includes(modelShort(s.model))) continue
      const repo = s.repoId ? st.repos[s.repoId].name : "main"
      let score = 1
      if (q) {
        score = scoreSession(pq, s, repo)
        if (!score) continue
        for (const v of VIEW_IDS) if (inView(s, v, now, subWaiting)) counts[v]++
      }
      if (here) out.push({ s, repo, score })
    }
    // best match first; among equally good matches the most recent one (yesterday before last month)
    if (q) out.sort((a, b) => b.score - a.score || cmpIso(b.s.updatedAt, a.s.updatedAt))
    else if (ui.view === "history" || ui.view === "archived" || ui.view === "recent")
      out.sort((a, b) => cmpIso(b.s.archivedAt ?? b.s.updatedAt, a.s.archivedAt ?? a.s.updatedAt))
    else out.sort((a, b) => tierOf(a.s, subWaiting) - tierOf(b.s, subWaiting) || compareAttentionFast(a.s, b.s, STATUS_TIER))
    return { data: out.map(({ s, repo }) => itemFor(s, repo)), matchCounts: q ? counts : null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.view, query, ui.status, ui.repos, ui.control, ui.model, structVersion, statusDep])

  // Column state only (sizes, visibility, sort, resizing): cells render from CELLS, rows from plain
  // arrays. `sortDescFirst` is explicit on every sortable column because TanStack would otherwise
  // pick the first direction from the first row's value type (numbers desc, text asc), and the
  // table holds no rows.
  const columns = useMemo<ColumnDef<Item>[]>(
    () => [
      // the select-all checkbox is rendered by the header row (it needs the view's rows)
      { id: "select", size: 30, enableSorting: false, enableResizing: false, header: () => null },
      {
        id: "status",
        size: 28,
        enableResizing: false,
        accessorFn: (r) => STATUS_TIER[r.s.status],
        sortingFn: "basic",
        sortDescFirst: true,
        header: () => <span className="sr-only">Status</span>,
      },
      { id: "title", size: 260, accessorFn: (r) => r.s.title, sortingFn: "text", sortDescFirst: false, header: "Title" },
      { id: "repo", size: 124, accessorFn: (r) => r.repo, sortingFn: "text", sortDescFirst: false, header: "Repo" },
      { id: "activity", size: 230, enableSorting: false, header: "Activity" },
      { id: "updated", size: 64, accessorFn: (r) => r.s.updatedAt, sortingFn: "basic", sortDescFirst: true, header: "Last" },
      { id: "branch", size: 140, accessorFn: (r) => r.s.cwd, sortingFn: "text", sortDescFirst: false, header: "Branch" },
      { id: "diff", size: 92, accessorFn: (r) => r.s.diff.linesAdded + r.s.diff.linesRemoved, sortingFn: "basic", sortDescFirst: true, header: "Changes" },
      { id: "unpushed", size: 40, accessorFn: (r) => r.s.diff.unpushed, sortingFn: "basic", sortDescFirst: true, header: "↑" },
      { id: "ctx", size: 52, accessorFn: (r) => r.s.usage.contextPct, sortingFn: "basic", sortDescFirst: true, header: "Ctx" },
      { id: "cost", size: 62, accessorFn: (r) => r.s.usage.costUsd, sortingFn: "basic", sortDescFirst: true, header: "Cost" },
      { id: "model", size: 64, accessorFn: (r) => modelShort(r.s.model), sortingFn: "text", sortDescFirst: false, header: "Model" },
      { id: "control", size: 52, accessorFn: (r) => r.s.control, sortingFn: "text", sortDescFirst: false, header: "Mode" },
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
    const width = (c: ColumnDef<Item>) => columnSizing[c.id!] ?? c.size ?? 100
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
    data: NO_ROWS,
    columns,
    state: { sorting, columnVisibility, columnSizing },
    onColumnSizingChange: setColumnSizing,
    onSortingChange: setSorting,
    manualSorting: true,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
  })
  const sorted = useMemo(() => sortItems(data, sorting, columns), [data, sorting, columns])

  // column widths as CSS variables, recomputed only while sizing changes (Langfuse pattern)
  const colVars = useMemo(() => {
    const vars: Record<string, string> = {}
    for (const h of table.getFlatHeaders()) vars[`--col-${h.column.id}`] = `${h.getSize()}px`
    return vars
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnSizing, columns, columnVisibility])
  const headers = table.getHeaderGroups()[0]?.headers ?? []
  const colKey = headers.map((h) => h.id).join(",")
  const colIds = useMemo(() => colKey.split(","), [colKey])

  const rows: Row[] = useMemo(() => {
    if (!ui.groupByRepo) return sorted
    const groups = new Map<string, { repoId: ID; repo: string; items: Row[] }>()
    for (const r of sorted) {
      const key = r.s.repoId ?? "main"
      const g = groups.get(key) ?? { repoId: key, repo: r.repo, items: [] }
      g.items.push(r)
      groups.set(key, g)
    }
    const out: Row[] = []
    for (const g of [...groups.values()].sort((a, b) => a.repo.localeCompare(b.repo))) {
      out.push({ kind: "group", repoId: g.repoId, repo: g.repo, count: g.items.length })
      out.push(...g.items)
    }
    return out
  }, [sorted, ui.groupByRepo])

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
  // row selection on plain ids, same rules as TanStack's row selection (all = every row of the view)
  const toggleRow = useCallback(
    (id: ID) =>
      setRowSelection((sel) => {
        const next = { ...sel }
        if (sel[id]) delete next[id]
        else next[id] = true
        return next
      }),
    [],
  )
  const selectedKeys = Object.keys(rowSelection).length
  const allSelected = selectedKeys > 0 && data.length > 0 && data.every((r) => rowSelection[r.s.id])
  const toggleAll = (on: boolean) =>
    setRowSelection((sel) => {
      const next = { ...sel }
      for (const r of data) {
        if (on) next[r.s.id] = true
        else delete next[r.s.id]
      }
      return next
    })

  const filtered = !!ui.query.trim() || ui.repos.length > 0 || ui.status.length > 0 || ui.control.length > 0
  const viewCount: Record<SessionsViewName, number | undefined> = {
    attention: attentionCount,
    active: activeCount,
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
      if (ui.view === "archived") restoreWithUndo(ids)
      else archiveWithUndo(ids)
      setRowSelection({})
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
              aria-pressed={ui.view === v.id}
              title={`${v.hint}${viewCount[v.id] !== undefined ? ` (${viewCount[v.id]})` : ""}`}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs whitespace-nowrap transition-colors",
                ui.view === v.id ? "bg-selected text-fg" : "text-fg-faint hover:text-fg-muted",
              )}
            >
              {v.label}
              {matchCounts ? (
                matchCounts[v.id] > 0 && <span className="tabular text-[11px] text-fg-muted">{matchCounts[v.id]}</span>
              ) : (
                v.id === "attention" && attentionCount > 0 && <span className="tabular text-[11px] text-fg-muted">{attentionCount}</span>
              )}
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
              const elsewhere = !data.length && matchCounts ? VIEWS.find((v) => matchCounts[v.id] > 0) : undefined
              if (e.key === "Escape") {
                if (ui.query) setSessionsFilter({ query: "" })
                else e.currentTarget.blur()
              } else if ((e.key === "Enter" || e.key === "ArrowDown") && elsewhere) {
                // nothing here but matches in another view: go there (keyboard twin of the empty-state buttons)
                e.preventDefault()
                setSessionsFilter({ view: elsewhere.id })
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
            aria-label="Search sessions"
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
            <Button size="sm" title="Restore (E)" onClick={() => { restoreWithUndo(selectedIds); setRowSelection({}) }}>
              <ArchiveRestore /> Restore
            </Button>
          ) : (
            <Button size="sm" title="Archive (E)" onClick={() => { archiveWithUndo(selectedIds); setRowSelection({}) }}>
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
      <div
        ref={scrollRef}
        data-qa="sessions-table"
        className="relative min-h-0 flex-1 overflow-auto outline-none contain-strict focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-inset"
        tabIndex={0}
        style={colVars as React.CSSProperties}
      >
        {data.length === 0 ? (
          <EmptyState
            action={
              ui.query && matchCounts && VIEWS.some((v) => matchCounts[v.id] > 0) ? (
                <span className="flex items-center gap-1">
                  {VIEWS.filter((v) => matchCounts[v.id] > 0).map((v) => (
                    <Button key={v.id} size="sm" variant="secondary" onClick={() => setSessionsFilter({ view: v.id })}>
                      {v.label} <span className="tabular text-fg-faint">{matchCounts[v.id]}</span>
                    </Button>
                  ))}
                </span>
              ) : undefined
            }
          >
            {ui.query ? "No matches here." : ui.view === "attention" ? "Nothing needs you." : ui.view === "archived" ? "Archive is empty." : "No sessions."}
          </EmptyState>
        ) : (
          <div style={{ width: Math.max(totalWidth, 0), minWidth: "100%" }}>
            <div className="sticky top-0 z-10 flex h-7 items-stretch border-b border-line-subtle bg-chrome text-[11px] text-fg-faint">
              {headers.map((h) => {
                const sorted = h.column.getIsSorted()
                const sortable = h.column.getCanSort()
                const label = h.id === "select" ? (
                  <Checkbox
                    checked={allSelected ? true : selectedKeys > 0 && selectedKeys < data.length ? "indeterminate" : false}
                    onCheckedChange={(v) => toggleAll(!!v)}
                    aria-label="Select all"
                    className="size-3.5"
                  />
                ) : (
                  flexRender(h.column.columnDef.header, h.getContext())
                )
                const arrow = sorted === "desc" ? <ArrowDown size={11} /> : sorted === "asc" ? <ArrowUp size={11} /> : null
                return (
                  <div
                    key={h.id}
                    role="columnheader"
                    aria-sort={sortable ? (sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none") : undefined}
                    className={cn(
                      "group/th relative flex shrink-0 items-center gap-1 px-2 select-none first:pl-3",
                      sortable && "cursor-pointer hover:text-fg-muted",
                      h.id === "title" && "grow",
                    )}
                    style={{ width: `var(--col-${h.id})`, minWidth: `var(--col-${h.id})` }}
                    onClick={h.column.getToggleSortingHandler()}
                  >
                    {sortable ? (
                      // keyboard + screen reader handle on the label; Enter/Space click it and the
                      // click reaches the cell's sort handler, like a mouse click anywhere in the cell
                      <button type="button" className="flex min-w-0 items-center gap-1 rounded-sm text-left [cursor:inherit] outline-none focus-visible:ring-1 focus-visible:ring-ring/60">
                        <span className="truncate">{label}</span>
                        {arrow}
                      </button>
                    ) : (
                      <>
                        <span className="truncate">{label}</span>
                        {arrow}
                      </>
                    )}
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
                    item={r}
                    index={vi.index}
                    top={vi.start}
                    height={vi.size}
                    focused={vi.index === focus}
                    selected={!!rowSelection[r.s.id]}
                    someSelected={selectedIds.length > 0}
                    colIds={colIds}
                    onFocusRow={setFocus}
                    onToggleRow={toggleRow}
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

/**
 * TanStack's sorted row model on plain arrays (react-table v8 `getSortedRowModel` semantics: the
 * `basic` and `text` (lowercased) comparators, desc inversion, multi-sort in order, original order
 * as the tie-break), but each sort key is computed once per row instead of per comparison and no
 * row objects are built or copied. On History (~4.7k rows) building TanStack's row models was most
 * of the cost of a view switch or a sort.
 */
function sortItems(data: Item[], sorting: SortingState, columns: ColumnDef<Item>[]): Item[] {
  if (!data.length || !sorting.length) return data
  const keys: { values: (string | number)[]; desc: boolean }[] = []
  for (const sort of sorting) {
    const col = columns.find((c) => c.id === sort.id)
    if (!col || !("accessorFn" in col) || !col.accessorFn || col.enableSorting === false) continue
    const get = col.accessorFn
    const text = col.sortingFn === "text"
    keys.push({ values: data.map((r, i) => (text ? textKey(get(r, i)) : (get(r, i) as string | number))), desc: !!sort.desc })
  }
  if (!keys.length) return data
  const order = data.map((_, i) => i)
  order.sort((a, b) => {
    for (const k of keys) {
      const x = k.values[a]
      const y = k.values[b]
      if (x !== y) return (x > y ? 1 : -1) * (k.desc ? -1 : 1)
    }
    return a - b
  })
  return order.map((i) => data[i])
}

/** TanStack's `text` sort key: numbers as strings (NaN/±Infinity empty), other non-strings empty. */
function textKey(v: unknown): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(v).toLowerCase() : ""
  return typeof v === "string" ? v.toLowerCase() : ""
}

/** Cell content per column id (the select column is drawn by RowCells from its props). */
const CELLS: Record<string, (s: Session, repo: string) => React.ReactNode> = {
  status: (s) => <LiveStatus id={s.id} />,
  title: (s) => <TitleCell s={s} />,
  repo: (_, repo) => <span className="truncate text-fg-muted">{repo}</span>,
  activity: (s) => <LiveActivity id={s.id} />,
  updated: (s) => <LiveAge id={s.id} />,
  branch: (s) => <BranchCell s={s} />,
  diff: (s) => <LiveDiff id={s.id} />,
  unpushed: (s) => (s.diff.unpushed ? <span className="tabular text-[11px] text-fg-faint">{s.diff.unpushed}</span> : null),
  ctx: (s) => <LiveCtx id={s.id} />,
  cost: (s) => <LiveCost id={s.id} />,
  model: (s) => <span className="text-fg-muted">{modelShort(s.model)}</span>,
  control: (s) => <ControlTag mode={s.control} />,
}

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
 * One table row: the positioned shell. Its cells are a separate memo keyed on the session record,
 * so a re-sort or a status tick elsewhere only moves rows (new `top`/`index`), and scrolling only
 * renders rows entering the viewport.
 */
const SessionRow = memo(function SessionRow({
  item,
  index,
  top,
  height,
  focused,
  selected,
  someSelected,
  colIds,
  onFocusRow,
  onToggleRow,
}: {
  item: Item
  index: number
  top: number
  height: number
  focused: boolean
  selected: boolean
  /** any row selected: checkboxes stay visible */
  someSelected: boolean
  /** visible column ids, in order */
  colIds: string[]
  onFocusRow: (index: number) => void
  onToggleRow: (id: ID) => void
}) {
  const id = item.s.id
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
      <RowCells s={item.s} repo={item.repo} colIds={colIds} selected={selected} someSelected={someSelected} onToggleRow={onToggleRow} />
      <RowActions id={id} />
    </div>
  )
})

const RowCells = memo(function RowCells({
  s,
  repo,
  colIds,
  selected,
  someSelected,
  onToggleRow,
}: {
  s: Session
  repo: string
  colIds: string[]
  selected: boolean
  someSelected: boolean
  onToggleRow: (id: ID) => void
}) {
  return colIds.map((cid) => (
    <div
      key={cid}
      className={cn("flex min-w-0 shrink-0 items-center px-2 first:pl-3", cid === "title" && "grow")}
      style={{ width: `var(--col-${cid})`, minWidth: `var(--col-${cid})` }}
    >
      {cid === "select" ? <RowCheck checked={selected} onToggle={() => onToggleRow(s.id)} hidden={!selected && !someSelected} /> : CELLS[cid]?.(s, repo)}
    </div>
  ))
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

/** Id of a subagent of this session that waits for permission (its row then needs you). */
const useWaitingSubagent = (id: ID) =>
  useApp((s) => (s.subagentIdsBySession[id] ?? EMPTY).find((sid) => s.subagents[sid]?.status === "waiting_permission"))

function LiveStatus({ id }: { id: ID }) {
  const status = useApp((s) => s.sessions[id]?.status)
  const sub = useWaitingSubagent(id)
  return status ? <StatusGlyph status={sub ? "waiting_permission" : status} size="sm" /> : null
}
function LiveAge({ id }: { id: ID }) {
  const iso = useApp((s) => s.sessions[id]?.updatedAt)
  const t = useRelTime(iso)
  return <span className="tabular text-[11px] text-fg-faint">{t}</span>
}
function LiveActivity({ id }: { id: ID }) {
  // only the fields shown: usage, cost and diff ticks don't re-render the cell
  const s = useApp(
    useShallow((st) => {
      const x = st.sessions[id]
      return x ? { status: x.status, errorMessage: x.errorMessage, waitingFor: x.waitingFor, activity: x.activity } : undefined
    }),
  )
  const subId = useWaitingSubagent(id)
  const subType = useApp((st) => (subId ? st.subagents[subId]?.agentType : undefined))
  if (!s) return null
  if (subId)
    return (
      <span className="truncate text-st-perm-fg" title={`${subType}: needs permission`}>
        {subType}: needs permission
      </span>
    )
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
  const s = useApp(
    useShallow((st) => {
      const x = st.sessions[id]
      return x ? { id: x.id, control: x.control, archived: x.archived, role: x.role } : undefined
    }),
  )
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
            restoreWithUndo([s.id])
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
            archiveWithUndo([s.id])
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
