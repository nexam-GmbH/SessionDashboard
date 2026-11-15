// Archive: archived sessions, hidden from the overview and the session list, never deleted (user
// requirement). One searchable column, newest first; Restore puts a session back where it was.
import { useDeferredValue, useMemo, useState } from "react"
import { ArchiveRestore, Search } from "lucide-react"
import { useApp } from "@/store/app"
import { openSession, restoreSessions } from "@/store/actions"
import { relTime } from "@/lib/format"
import { prepareQuery, scoreSession } from "@/lib/sessionSearch"
import { Button } from "@/components/ui/button"

export default function ArchiveView() {
  const structVersion = useApp((s) => s.structVersion)
  const [q, setQ] = useState("")
  const query = useDeferredValue(q.trim())
  const rows = useMemo(() => {
    void structVersion
    const s = useApp.getState()
    const pq = prepareQuery(query)
    return Object.values(s.sessions)
      .filter((x) => x.archived)
      .map((x) => ({ x, repo: x.repoId ? (s.repos[x.repoId]?.name ?? "") : "main agent" }))
      .filter(({ x, repo }) => !query || scoreSession(pq, x, repo) > 0)
      .sort((a, b) => (b.x.archivedAt ?? "").localeCompare(a.x.archivedAt ?? ""))
  }, [query, structVersion])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-6 pt-10 pb-16">
        <h1 className="text-lg font-medium text-foreground">Archive</h1>
        <p className="mt-1 text-sm text-muted-foreground">Archived sessions are hidden everywhere else. Nothing here is deleted.</p>
        <label className="mt-6 flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 focus-within:border-border">
          <Search size={14} className="shrink-0 text-muted-foreground/70" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search archived sessions"
            className="h-full flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          />
        </label>
        <ul className="mt-4 flex flex-col">
          {rows.map(({ x, repo }) => (
            <li key={x.id} className="group/row flex h-11 items-center gap-3 border-b border-border px-1">
              <button onClick={() => openSession(x.id)} className="min-w-0 flex-1 truncate text-left text-sm text-muted-foreground hover:text-foreground">
                {x.title}
              </button>
              <span className="shrink-0 text-xs text-muted-foreground/70">{repo}</span>
              <span className="tabular w-16 shrink-0 text-right text-xs text-muted-foreground/70">{relTime(x.archivedAt)}</span>
              <Button
                size="sm"
                variant="ghost"
                className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                onClick={() => restoreSessions([x.id])}
              >
                <ArchiveRestore /> Restore
              </Button>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p className="mt-10 text-center text-sm text-muted-foreground/70">{query ? "No archived session matches." : "Nothing archived."}</p>}
      </div>
    </div>
  )
}
