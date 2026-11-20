// History: every session you ran, newest first, grouped by day, the place to pick an old chat back
// up without remembering where it was. One search field finds sessions by their title, folder and
// branch and by what was said in them (the backend's index of every transcript); a hit opens the
// chat at that message. Project filter, Archived tab, ↑ ↓ Enter. (Claude Code desktop has no
// content search for past sessions: users' most asked-for fix, GH #5768 and others.)
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { Archive, ArchiveRestore, MessageSquareText, Pin, Search, X } from "lucide-react"
import type { ID, Session } from "@/lib/model"
import { useApp } from "@/store/app"
import { openSession, openSettings, pinSession } from "@/store/actions"
import { REAL } from "@/backend/mode"
import { archiveWithUndo, restoreWithUndo } from "@/features/notifications/undo"
import { openSessionAt } from "@/features/session-view/find/find"
import { useShownStatus } from "@/store/selectors"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { Button } from "@/components/ui/button"
import { prepareQuery, scoreSession } from "@/lib/sessionSearch"
import { relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { SearchHit } from "@/backend/real"
import { useUiValue, setUiValue } from "@/features/session-view/sessionStore"
import { useContentSearch } from "./contentSearch"

type Tab = "all" | "archived"
interface Row {
  x: Session
  repo: string
  hit?: SearchHit
}

/** Set by the session list's "All N" link: the project to show. */
export const setHistoryRepo = (repoId: ID | null) => setUiValue("history:repo", repoId)

const DAY = 86_400_000
function dayGroup(iso: string, now: number): string {
  const t = Date.parse(iso)
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  if (t >= today) return "Today"
  if (t >= today - DAY) return "Yesterday"
  if (t >= today - 7 * DAY) return "Previous 7 days"
  if (t >= today - 30 * DAY) return "Previous 30 days"
  return new Date(t).toLocaleDateString("en", { month: "long", year: "numeric" })
}

const PAGE = 150

/** Rows with "Today" / "Yesterday" / … before the first row of each day. */
function withHeads(rows: Row[], grouped: boolean): (Row & { head: string })[] {
  const now = Date.now()
  const out: (Row & { head: string })[] = []
  let last = ""
  for (const r of rows) {
    const g = grouped ? dayGroup(r.x.updatedAt, now) : ""
    out.push({ ...r, head: g && g !== last ? g : "" })
    if (g) last = g
  }
  return out
}

export default function HistoryView() {
  const structVersion = useApp((s) => s.structVersion)
  const repoOrder = useApp((s) => s.repoOrder)
  const repos = useApp((s) => s.repos)
  const repo = useUiValue<ID | null>("history:repo", null)
  const [tab, setTab] = useState<Tab>("all")
  const [q, setQ] = useState("")
  const query = useDeferredValue(q.trim())
  const [limit, setLimit] = useState(PAGE)
  const content = useContentSearch(query, 200)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const rows = useMemo(() => {
    void structVersion
    const s = useApp.getState()
    const name = (x: Session) => (x.repoId ? (s.repos[x.repoId]?.name ?? "") : "main agent")
    const pq = prepareQuery(query)
    const pool = Object.values(s.sessions).filter((x) => (tab === "archived" ? x.archived : !x.archived) && (!repo || x.repoId === repo))
    if (!query) return pool.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((x) => ({ x, repo: name(x) }))
    // by title / folder / branch, and by what was said (the hit is shown under the title)
    const hits = new Map(content.hits.map((h) => [h.sessionId, h]))
    const out: Row[] = []
    for (const x of pool) {
      const hit = hits.get(x.id)
      if (hit || scoreSession(pq, x, name(x)) > 0) out.push({ x, repo: name(x), hit })
    }
    return out.sort((a, b) => (b.hit?.at ?? b.x.updatedAt).localeCompare(a.hit?.at ?? a.x.updatedAt))
  }, [query, tab, repo, content.hits, structVersion])

  // each shown row with the day heading that starts before it (none while searching)
  const shown = useMemo(() => withHeads(rows.slice(0, limit), !query), [rows, limit, query])
  const [sel, setSel] = useState(0)
  const [lastKey, setLastKey] = useState("")
  const key = `${query}|${tab}|${repo}`
  if (key !== lastKey) {
    setLastKey(key)
    setSel(0)
    setLimit(PAGE)
  }
  const open = (r: Row | undefined) => {
    if (!r) return
    if (r.hit?.uuid) openSessionAt(r.x.id, r.hit.uuid, query)
    else openSession(r.x.id)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[820px] px-6 pt-8 pb-16">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-medium text-foreground">History</h1>
          <span className="text-sm text-muted-foreground">Every session, newest first. Search finds what was said in them too.</span>
        </div>
        <div className="mt-5 flex items-center gap-2">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-card px-3 ring-1 ring-foreground/10 focus-within:ring-foreground/25">
            <Search size={14} className="shrink-0 text-muted-foreground/70" />
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault()
                  setSel((i) => Math.min(shown.length - 1, i + 1))
                } else if (e.key === "ArrowUp") {
                  e.preventDefault()
                  setSel((i) => Math.max(0, i - 1))
                } else if (e.key === "Enter") {
                  e.preventDefault()
                  open(shown[sel])
                } else if (e.key === "Escape" && q) {
                  e.preventDefault()
                  setQ("")
                }
              }}
              placeholder="Search titles, folders, branches and messages"
              aria-label="Search sessions"
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            {content.busy && <span className="shrink-0 text-xs text-muted-foreground/70">searching…</span>}
            {q && (
              <button type="button" aria-label="Clear search" onClick={() => setQ("")} className="shrink-0 rounded-sm text-muted-foreground/70 hover:text-foreground">
                <X size={14} />
              </button>
            )}
          </label>
          <select
            value={repo ?? ""}
            onChange={(e) => setHistoryRepo(e.target.value || null)}
            aria-label="Project"
            className="h-9 max-w-48 rounded-lg bg-card px-2 text-sm text-foreground ring-1 ring-foreground/10 outline-none focus-visible:ring-foreground/25"
          >
            <option value="">All projects</option>
            {repoOrder.map((id) => (
              <option key={id} value={id}>
                {repos[id]?.name ?? id}
              </option>
            ))}
          </select>
          <div role="tablist" aria-label="Which sessions" className="flex h-9 shrink-0 items-center rounded-lg bg-card p-0.5 ring-1 ring-foreground/10">
            {(["all", "archived"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn("h-full rounded-md px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring", tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {t === "all" ? "Sessions" : "Archived"}
              </button>
            ))}
          </div>
        </div>

        <ul className="mt-4 flex flex-col" role="listbox" aria-label="Sessions">
          {shown.map((r, i) => (
            <li key={r.x.id} role="presentation">
              {r.head && <div className="px-2 pt-5 pb-1.5 text-xs font-medium text-muted-foreground/70">{r.head}</div>}
              <HistoryRow row={r} selected={i === sel} onHover={() => setSel(i)} onOpen={() => open(r)} tab={tab} />
            </li>
          ))}
        </ul>
        {rows.length > shown.length && (
          <div className="mt-3 flex justify-center">
            <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown.length)} more of {rows.length - shown.length}
            </Button>
          </div>
        )}
        <KeepNote />
        {rows.length === 0 && !content.busy && (
          <p className="mt-12 text-center text-sm text-muted-foreground/70">
            {query ? "No session matches." : tab === "archived" ? "Nothing archived." : "No sessions yet."}
          </p>
        )}
      </div>
    </div>
  )
}

function HistoryRow({ row, selected, onHover, onOpen, tab }: { row: Row; selected: boolean; onHover: () => void; onOpen: () => void; tab: Tab }) {
  const { x, repo, hit } = row
  const status = useShownStatus(x.id)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" })
  }, [selected])
  const sub = hit ? null : (x.lastPrompt || x.firstPrompt || x.lastText || "").split("\n")[0]
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      onPointerMove={onHover}
      onClick={onOpen}
      className={cn("group/row flex cursor-default items-start gap-3 rounded-lg px-2 py-2", selected && "bg-accent/60")}
    >
      <span className="mt-0.5">
        <StatusGlyph status={status} outcome={x.outcome} unread={!!x.unreadSince} size="sm" title={null} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 truncate text-sm text-foreground", x.unreadSince && "font-medium")}>{x.title}</span>
          {x.pinned && <Pin size={12} className="shrink-0 text-muted-foreground/70" aria-label="Pinned" />}
          <span className="shrink-0 text-xs text-muted-foreground/70">{repo}</span>
        </div>
        {hit ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <MessageSquareText size={12} className="shrink-0 text-muted-foreground/60" />
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground/70">{hit.role === "user" ? "You: " : "Claude: "}</span>
              {hit.before}
              <mark className="rounded-sm bg-st-input/25 px-0.5 text-foreground">{hit.matched}</mark>
              {hit.after}
            </span>
            {hit.count > 1 && <span className="shrink-0 text-muted-foreground/60">· {hit.count} messages</span>}
          </div>
        ) : (
          sub && <div className="mt-0.5 truncate text-xs text-muted-foreground/80">{sub}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <span className="tabular w-14 text-right text-xs text-muted-foreground/70 group-hover/row:hidden">{relTime(hit?.at ?? x.updatedAt)}</span>
        <div className="hidden items-center gap-0.5 group-hover/row:flex" onClick={(e) => e.stopPropagation()}>
          <Button size="xs" variant="ghost" onClick={() => pinSession(x.id)} title={x.pinned ? "Unpin" : "Pin to the top of the list"}>
            <Pin /> {x.pinned ? "Unpin" : "Pin"}
          </Button>
          {tab === "archived" ? (
            <Button size="xs" variant="ghost" onClick={() => restoreWithUndo([x.id])}>
              <ArchiveRestore /> Restore
            </Button>
          ) : (
            x.role !== "main" && (
              <Button size="xs" variant="ghost" onClick={() => archiveWithUndo([x.id])}>
                <Archive /> Archive
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  )
}

/** Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default): say so where you look for old chats. */
function KeepNote() {
  const [days, setDays] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    if (!REAL) return
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke<number | null>("claude_user_setting", { key: "cleanupPeriodDays" }).then((v) => setDays(typeof v === "number" ? v : null)).catch(() => undefined))
  }, [])
  if (days === undefined || (days !== null && days >= 3650)) return null
  return (
    <p className="mt-6 text-center text-xs text-muted-foreground/70">
      Claude Code deletes chats untouched for {days ?? 30} days.{" "}
      <button type="button" className="underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring" onClick={() => openSettings("sessions")}>
        Keep them longer
      </button>
    </p>
  )
}
