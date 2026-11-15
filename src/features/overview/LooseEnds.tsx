// Loose ends under the tree: work that is not committed or not pushed and that no running session
// is on — worktrees a session left behind, branches never pushed, projects with changes and nobody
// working there. One quiet row each; picking one starts a session in that folder.
import { useMemo, useState } from "react"
import { FolderGit2, GitBranch, Server } from "lucide-react"
import { getApp, useApp } from "@/store/app"
import { repoInView } from "@/store/selectors"
import { addRepoFromPath, openNewSession } from "@/store/actions"
import { homePath, plural } from "@/lib/format"
import { cn } from "@/lib/utils"

interface Row {
  key: string
  repo: string
  machine?: string
  kind: "worktree" | "branch" | "folder"
  name: string
  path?: string
  changed: number
  unpushed: number
  lastMs: number
}

const DAY = 24 * 3600_000

function age(ms: number) {
  if (!ms) return ""
  const d = Math.floor((Date.now() - ms) / DAY)
  if (d < 1) return "today"
  if (d === 1) return "yesterday"
  if (d < 60) return `${d} days`
  return `${Math.floor(d / 30)} months`
}

export function useLooseEnds(): Row[] {
  const repos = useApp((s) => s.repos)
  const sessions = useApp((s) => s.sessions)
  const ws = useApp((s) => s.settings.workspace)
  return useMemo(() => {
    void ws
    const st = getApp()
    // folders someone is working in right now are not loose
    const busy = new Set(Object.values(sessions).filter((s) => s.control === "owned" || s.control === "observed").map((s) => `${s.machine ?? ""}|${s.cwd}`))
    const rows = new Map<string, Row>()
    for (const r of Object.values(repos)) {
      const g = r.git
      if (!g?.isRepo || r.machine === "cloud" || !repoInView(st, r.id)) continue
      const m = r.machine ?? ""
      const root = g.root ?? r.rootPath
      const repoName = root.split("/").filter(Boolean).pop() ?? r.name
      for (const l of g.looseEnds) {
        const key = l.kind === "worktree" ? `${m}|wt|${l.path}` : `${m}|br|${root}|${l.name}`
        if (l.path && busy.has(`${m}|${l.path}`)) continue
        rows.set(key, { key, repo: repoName, machine: r.machine, kind: l.kind, name: l.name, path: l.kind === "worktree" ? l.path : root, changed: l.changed, unpushed: l.unpushed, lastMs: l.lastCommitMs })
      }
      // the folder itself: changes or unpushed commits and no session there
      if ((g.changed > 0 || g.unpushed > 0) && !busy.has(`${m}|${r.rootPath}`)) {
        const key = `${m}|wt|${r.rootPath}`
        if (!rows.has(key)) rows.set(key, { key, repo: repoName, machine: r.machine, kind: "folder", name: g.branch ?? r.name, path: r.rootPath, changed: g.changed, unpushed: g.unpushed, lastMs: 0 })
      }
    }
    // most work first, then the oldest
    return [...rows.values()].sort((a, b) => b.changed + b.unpushed * 5 - (a.changed + a.unpushed * 5) || a.lastMs - b.lastMs)
  }, [repos, sessions, ws])
}

export function LooseEnds({ className }: { className?: string }) {
  const rows = useLooseEnds()
  const [all, setAll] = useState(false)
  if (!rows.length) return null
  const shown = all ? rows : rows.slice(0, 6)
  return (
    <section className={cn("mx-auto w-full max-w-[760px] px-8", className)} aria-labelledby="loose-ends">
      <h2 id="loose-ends" className="mb-1.5 flex items-baseline gap-2 text-xs font-medium text-muted-foreground">
        Not committed or not pushed
        <span className="tabular text-xs font-normal text-muted-foreground/70">{rows.length}</span>
      </h2>
      <ul className="border-t border-border">
        {shown.map((r) => (
          <li key={r.key}>
            <button
              onClick={() => r.path && openNewSession(addRepoFromPath(r.path, r.machine))}
              title={r.path ? `Start a session in ${homePath(r.path)}` : undefined}
              className="group flex h-8 w-full min-w-0 items-center gap-2.5 border-b border-border px-1 text-left text-xs outline-none hover:bg-accent/60 focus-visible:bg-accent"
            >
              {r.machine ? <Server size={13} className="shrink-0 text-muted-foreground/70" /> : r.kind === "branch" ? <GitBranch size={13} className="shrink-0 text-muted-foreground/70" /> : <FolderGit2 size={13} className="shrink-0 text-muted-foreground/70" />}
              <span className="shrink-0 text-muted-foreground">
                {r.machine && <span className="text-muted-foreground/70">{r.machine}: </span>}
                {r.repo}
              </span>
              <span className="min-w-0 truncate font-mono text-xs text-foreground">{r.kind === "worktree" ? `worktree ${r.name}` : r.kind === "branch" ? `branch ${r.name}` : r.name}</span>
              <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground/70">
                {r.changed > 0 && <span>{plural(r.changed, "file")} changed</span>}
                {r.unpushed > 0 && <span className="text-muted-foreground">{plural(r.unpushed, "commit")} not pushed</span>}
                <span className="tabular w-[72px] text-right">{r.lastMs > 0 ? age(r.lastMs) : ""}</span>
                <span className="w-[86px] text-right text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">New session</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <button onClick={() => setAll(true)} className="mt-1.5 text-xs text-muted-foreground/70 hover:text-muted-foreground">
          Show all {rows.length}
        </button>
      )}
    </section>
  )
}
