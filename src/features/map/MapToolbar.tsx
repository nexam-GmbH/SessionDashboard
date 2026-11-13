// Map toolbar — UI_PLAN §5.1 toolbar, reshaped by the Calm UI rules (§2.5 rule 7: 3–5 controls,
// the rest in one menu): node search, one "View" menu (status filter, repositories, history
// range, repo links, minimap), a clear-filters chip while a filter hides something, and the
// "Needs you N ›" jump on the right. The per-status counters live in the status bar.
import { memo, useCallback } from "react"
import { ChevronDown, ChevronRight, FolderGit2, SlidersHorizontal, X } from "lucide-react"
import { useApp, getApp, type HistoryRange } from "@/store/app"
import { patchMap, setHistoryRange } from "@/store/actions"
import { selectStatusCounts, selectWaitingCount, isVisibleLive, type StatusCounts } from "@/store/selectors"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { NodeSearch } from "@/components/flow/node-search"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { ID, SessionStatus } from "@/lib/model"
import { STATUS_TIER } from "@/lib/status"
import { setMapLocal, useMapLocal } from "./mapStore"

const CHIPS: { id: string; label: string; glyph: SessionStatus; statuses: SessionStatus[] }[] = [
  { id: "needs", label: "Needs you", glyph: "waiting_permission", statuses: ["waiting_permission", "waiting_input"] },
  { id: "error", label: "Errors", glyph: "error", statuses: ["error"] },
  { id: "unseen", label: "Unseen", glyph: "done_unseen", statuses: ["done_unseen"] },
  { id: "working", label: "Working", glyph: "working", statuses: ["working", "starting"] },
  { id: "idle", label: "Idle", glyph: "idle", statuses: ["idle", "stopped"] },
]

const RANGES: { id: HistoryRange; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "1d", label: "1 day" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
]

export type SearchItem = {
  id: ID
  kind: "repo" | "session" | "subagent"
  label: string
  meta: string
  status?: SessionStatus
}

export const MapToolbar = memo(function MapToolbar({
  onSearchSelect,
  onNextWaiting,
}: {
  onSearchSelect: (item: SearchItem) => void
  onNextWaiting: () => void
}) {
  const statusFilter = useApp((s) => s.map.statusFilter)
  const repoFilter = useApp((s) => s.map.repoFilter)
  const waiting = useApp(selectWaitingCount)
  const onSearch = useCallback((q: string) => searchMap(q), [])
  const filtered = statusFilter.length > 0 || repoFilter.length > 0

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle bg-canvas px-3">
      <NodeSearch<SearchItem>
        onSearch={onSearch}
        onSelectNode={onSearchSelect}
        placeholder="Find on map…"
        className="w-auto max-w-64 min-w-32 flex-1"
        renderItem={(it) => (
          <>
            {it.kind === "repo" ? <FolderGit2 size={12} className="shrink-0 text-fg-faint" /> : <StatusGlyph status={it.status ?? "idle"} size="xs" animate={false} />}
            <span className="min-w-0 flex-1 truncate text-fg">{it.label}</span>
            <span className="max-w-[45%] shrink-0 truncate pl-2 text-[11px] text-fg-faint">{it.meta}</span>
          </>
        )}
      />
      <ViewMenu />
      {filtered && (
        <button
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg"
          onClick={() => patchMap({ statusFilter: [], repoFilter: [] })}
          title="Show everything again"
        >
          <X size={12} /> Filtered
        </button>
      )}
      <button
        onClick={onNextWaiting}
        disabled={!waiting}
        className={cn(
          "ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
          waiting ? "border-st-perm/40 bg-st-perm-tint text-st-perm-fg hover:border-st-perm/70" : "border-transparent text-fg-faint",
        )}
        title={waiting ? "Jump to the next item that needs you (N)" : "Nothing needs you"}
      >
        <StatusGlyph status={waiting ? "waiting_permission" : "idle"} size="xs" title={null} />
        <span className="whitespace-nowrap">Needs you</span>
        <span className="tabular font-medium">{waiting}</span>
        {waiting > 0 && <ChevronRight size={12} className="-mr-0.5" />}
      </button>
    </div>
  )
})

/** Everything that changes what the map shows, in one menu. */
function ViewMenu() {
  const statusFilter = useApp((s) => s.map.statusFilter)
  const repoFilter = useApp((s) => s.map.repoFilter)
  const range = useApp((s) => s.map.historyRange)
  const active = CHIPS.filter((c) => c.statuses.every((st) => statusFilter.includes(st))).length + (repoFilter.length ? 1 : 0) + (range !== "off" ? 1 : 0)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-active={active > 0}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-subtle bg-chrome px-2 text-xs text-fg-muted hover:text-fg data-[active=true]:border-line data-[active=true]:text-fg aria-expanded:bg-hover"
          title="Filters, history, links, minimap"
        >
          <SlidersHorizontal size={12} />
          View
          {active > 0 && <span className="tabular text-fg-faint">{active}</span>}
          <ChevronDown size={12} className="text-fg-faint" />
        </button>
      </DropdownMenuTrigger>
      <ViewMenuContent />
    </DropdownMenu>
  )
}

/** Mounted only while the menu is open, so the counts don't subscribe at rest. */
function ViewMenuContent() {
  const statusFilter = useApp((s) => s.map.statusFilter)
  const range = useApp((s) => s.map.historyRange)
  const showLinks = useApp((s) => s.map.showLinks)
  const minimap = useMapLocal((s) => s.minimap)
  const counts = useApp(selectStatusCounts)
  return (
    <DropdownMenuContent align="start" className="w-56">
      <DropdownMenuLabel>Only show</DropdownMenuLabel>
      {CHIPS.map((c) => (
        <StatusItem key={c.id} chip={c} filter={statusFilter} counts={counts} />
      ))}
      <DropdownMenuSeparator />
      <RepoSub />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          History
          <span className="ml-auto pl-3 text-xs text-fg-faint">{RANGES.find((r) => r.id === range)?.label}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-40">
          <DropdownMenuRadioGroup value={range} onValueChange={(v) => setHistoryRange(v as HistoryRange)}>
            {RANGES.map((r) => (
              <DropdownMenuRadioItem key={r.id} value={r.id} onSelect={(e) => e.preventDefault()}>
                {r.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem checked={showLinks} onSelect={(e) => e.preventDefault()} onCheckedChange={(on) => patchMap({ showLinks: on })}>
        Repo links
        <DropdownMenuShortcut>L</DropdownMenuShortcut>
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem checked={minimap} onSelect={(e) => e.preventDefault()} onCheckedChange={(on) => setMapLocal({ minimap: on })}>
        Minimap
      </DropdownMenuCheckboxItem>
    </DropdownMenuContent>
  )
}

function StatusItem({ chip, filter, counts }: { chip: (typeof CHIPS)[number]; filter: SessionStatus[]; counts: StatusCounts }) {
  const active = chip.statuses.every((st) => filter.includes(st))
  const n = chip.statuses.reduce((a, st) => a + (st === "stopped" ? 0 : counts[st]), 0)
  return (
    <DropdownMenuCheckboxItem
      checked={active}
      onSelect={(e) => e.preventDefault()}
      onCheckedChange={() =>
        patchMap({
          statusFilter: active ? filter.filter((st) => !chip.statuses.includes(st)) : [...new Set([...filter, ...chip.statuses])],
        })
      }
    >
      <StatusGlyph status={chip.glyph} size="xs" animate={false} title={null} />
      {chip.label}
      <span className="tabular ml-auto text-xs text-fg-faint">{n}</span>
    </DropdownMenuCheckboxItem>
  )
}

function RepoSub() {
  const repoFilter = useApp((s) => s.map.repoFilter)
  const repos = useApp((s) => s.repoOrder)
  const names = useApp((s) => s.repos)
  const sorted = repos.slice().sort((a, b) => names[a].name.localeCompare(names[b].name))
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        Repositories
        <span className="tabular ml-auto pl-3 text-xs text-fg-faint">{repoFilter.length ? `${repoFilter.length} of ${repos.length}` : "All"}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-96 w-56 overflow-y-auto">
        {repoFilter.length > 0 && (
          <>
            <DropdownMenuItem onSelect={() => patchMap({ repoFilter: [] })}>Show all</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {sorted.map((id) => (
          <DropdownMenuCheckboxItem
            key={id}
            checked={repoFilter.includes(id)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => patchMap({ repoFilter: on ? [...repoFilter, id] : repoFilter.filter((r) => r !== id) })}
          >
            <span className="truncate">{names[id].name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Store-side search: repos, live sessions, history in range, subagents. */
function searchMap(q: string): SearchItem[] {
  const s = getApp()
  const needle = q.toLowerCase()
  const out: SearchItem[] = []
  for (const id of s.repoOrder) {
    const r = s.repos[id]
    if (r.name.toLowerCase().includes(needle)) out.push({ id, kind: "repo", label: r.name, meta: "repository" })
  }
  const sessions: SearchItem[] = []
  const histOk = s.map.historyRange !== "off"
  for (const sess of Object.values(s.sessions)) {
    if (sess.archived) continue
    const live = isVisibleLive(sess)
    if (!live && !histOk) continue
    if (!sess.title.toLowerCase().includes(needle) && !sess.handle.toLowerCase().includes(needle)) continue
    sessions.push({
      id: sess.id,
      kind: "session",
      label: sess.role === "main" ? "Main agent" : sess.title,
      meta: sess.repoId ? `${s.repos[sess.repoId]?.name}${live ? "" : " · history"}` : "main",
      status: sess.status,
    })
    if (sessions.length > 200) break
  }
  sessions.sort((a, b) => STATUS_TIER[a.status!] - STATUS_TIER[b.status!])
  out.push(...sessions)
  for (const a of Object.values(s.subagents)) {
    if (out.length > 60) break
    if (!a.description.toLowerCase().includes(needle) && !a.agentType.toLowerCase().includes(needle)) continue
    const parent = s.sessions[a.sessionId]
    if (!parent || !isVisibleLive(parent)) continue
    out.push({ id: a.id, kind: "subagent", label: a.description, meta: `${a.agentType} · ${parent.title}`, status: a.status === "running" ? "working" : a.status === "waiting_permission" ? "waiting_permission" : "idle" })
  }
  return out.slice(0, 40)
}
