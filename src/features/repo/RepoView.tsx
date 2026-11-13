// Repo view — UI_PLAN §5.5. Worktrees table after stravu/crystal@1e18e0b:
// frontend/src/components/ProjectDashboard.tsx (MIT: branch, ahead/behind, uncommitted per
// session worktree); repo header/git actions after BloopAI/vibe-kanban@5f06193:
// packages/ui/src/components/RepoCard.tsx (Apache-2.0). Modified: our tokens, IDE density,
// linked repos + Graphify + shared rules sections.
import { memo, useMemo, useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight, FolderGit2, GitBranch, Plus, Waypoints, Link2, FileText, Network, Play, ArrowUpRight } from "lucide-react"
import { useApp, getApp } from "@/store/app"
import { useRepoRollup } from "@/store/selectors"
import { openGraph, openNewSession, openRepo, openSession, openCrossRepo, resumeSession, select } from "@/store/actions"
import { Button } from "@/components/ui/button"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { AheadBehind, EmptyState, PrChip } from "@/components/common/bits"
import { useRelTime } from "@/components/common/RelativeTime"
import { compact, homePath } from "@/lib/format"
import { STATUS_LABEL, compareAttention } from "@/lib/status"
import type { ID, SessionStatus, Worktree } from "@/lib/model"
import { cn } from "@/lib/utils"
import { cmpIso } from "@/features/sessions/search"

// counts only for things that need you or are running (§2.5: numbers only when actionable)
const ROLLUP: SessionStatus[] = ["waiting_permission", "waiting_input", "error", "done_unseen", "working"]

export default function RepoView({ repoId }: { repoId: string }) {
  const repo = useApp((s) => s.repos[repoId])
  const rollup = useRepoRollup(repoId)
  if (!repo) return <EmptyState>Repository not found.</EmptyState>
  const main = repo.worktrees.find((w) => w.isMain)!
  return (
    <div className="@container h-full overflow-y-auto bg-canvas">
      <header className="border-b border-line-subtle bg-chrome px-5 py-4">
        <div className="flex items-start gap-3">
          <FolderGit2 size={18} className="mt-0.5 shrink-0 text-fg-faint" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-fg">{repo.name}</h1>
              <span className="text-xs text-fg-faint">{repo.language}</span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-3 text-xs text-fg-faint">
              <span className="truncate font-mono text-[11px]" title={repo.rootPath}>{homePath(repo.rootPath)}</span>
              <span className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
                <GitBranch size={11} />
                {main.branch}
              </span>
              {main.git.filesChanged > 0 && <span className="shrink-0 text-[11px]">{main.git.filesChanged} changed</span>}
              {main.git.unpushed > 0 && <span className="tabular shrink-0 text-[11px]" title="Unpushed commits">↑{main.git.unpushed}</span>}
            </div>
          </div>
          <div className="ml-auto flex shrink-0 gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => openCrossRepo()} title="Change across linked repos (main agent)">
              <Network /> Cross-repo
            </Button>
            {repo.graphify?.state !== "none" && (
              <Button size="sm" variant="ghost" onClick={() => openGraph(repoId)} title="Code graph">
                <Waypoints /> Graph
              </Button>
            )}
            <Button size="sm" variant="default" onClick={() => openNewSession(repoId)}>
              <Plus /> New session
            </Button>
          </div>
        </div>
        {ROLLUP.some((st) => rollup[st]) && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 pl-[30px]">
            {ROLLUP.map((st) =>
              rollup[st] ? (
                <span key={st} className="flex items-center gap-1 text-xs text-fg-muted" title={`${rollup[st]} ${STATUS_LABEL[st].toLowerCase()}`}>
                  <StatusGlyph status={st} size="xs" animate={false} title={null} />
                  <span className="tabular">{rollup[st]}</span>
                </span>
              ) : null,
            )}
          </div>
        )}
      </header>
      <div className="grid gap-4 p-5 @min-[1040px]:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Sessions">
            <RepoSessions repoId={repoId} />
          </Card>
          <Card title="Worktrees" count={repo.worktrees.length}>
            <WorktreeTable worktrees={repo.worktrees} />
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <LinksCard repoId={repoId} />
          <GraphifyCard repoId={repoId} />
          <Card title="Rules" count={repo.sharedRuleFiles.length} collapsible>
            <div className="flex flex-col py-1">
              {repo.sharedRuleFiles.map((f) => (
                <div key={f} className="flex h-7 items-center gap-2 px-3 text-xs" title={f.includes("shared-rules") ? `${f} · shared with 6 repos` : f}>
                  <FileText size={12} className="shrink-0 text-fg-faint" />
                  <span className="truncate font-mono text-[11px] text-fg-muted">{f}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

function Card({
  title,
  count,
  children,
  actions,
  summary,
  collapsible,
}: {
  title: string
  count?: number
  children: ReactNode
  actions?: ReactNode
  /** one-line summary shown in the header while collapsed */
  summary?: ReactNode
  /** details collapsed by default (§2.5 details on demand) */
  collapsible?: boolean
}) {
  const [open, setOpen] = useState(!collapsible)
  return (
    <section className="overflow-hidden rounded-md border border-line-subtle">
      <div
        className={cn("flex h-8 items-center gap-1.5 bg-chrome px-3", open && "border-b border-line-subtle", collapsible && "cursor-default hover:bg-hover")}
        onClick={collapsible ? () => setOpen((v) => !v) : undefined}
        role={collapsible ? "button" : undefined}
        aria-expanded={collapsible ? open : undefined}
      >
        {collapsible && (open ? <ChevronDown size={12} className="-ml-1 text-fg-faint" /> : <ChevronRight size={12} className="-ml-1 text-fg-faint" />)}
        <span className="section-label">{title}</span>
        {count !== undefined && <span className="tabular text-[11px] text-fg-faint">{count}</span>}
        {!open && summary && <span className="min-w-0 truncate text-[11px] text-fg-faint">{summary}</span>}
        <span className="ml-auto" onClick={(e) => e.stopPropagation()}>{actions}</span>
      </div>
      {open && children}
    </section>
  )
}

const WorktreeTable = memo(function WorktreeTable({ worktrees }: { worktrees: Worktree[] }) {
  const structVersion = useApp((s) => s.structVersion)
  const repoId = worktrees[0]?.repoId
  const sessionsByCwd = useMemo(() => {
    const m: Record<string, ID> = {}
    const st = getApp()
    for (const id of st.sessionIdsByRepo[repoId] ?? []) {
      const x = st.sessions[id]
      if (x?.worktreeId && !x.archived) m[x.worktreeId] = id
    }
    return m
    // structVersion: sessions added / archived / restored
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, structVersion])
  const rows = worktrees.slice(0, 40)
  // hide columns that would be empty for every row
  const cols = {
    diff: rows.some((w) => w.git.filesChanged > 0),
    ab: rows.some((w) => w.git.unpushed > 0 || w.git.behind > 0),
    pr: rows.some((w) => !!w.git.pr),
  }
  const template = ["minmax(160px,1.3fr)", "minmax(120px,1fr)", cols.diff && "72px", cols.ab && "48px", cols.pr && "88px"].filter(Boolean).join(" ")
  return (
    <div className="overflow-x-auto text-xs">
      <div className="grid h-7 min-w-[420px] items-center gap-3 border-b border-line-subtle px-3 text-[11px] text-fg-faint" style={{ gridTemplateColumns: template }}>
        <span>Branch</span>
        <span>Session</span>
        {cols.diff && <span title="Uncommitted changes">Changes</span>}
        {cols.ab && <span title="Unpushed / behind">↑↓</span>}
        {cols.pr && <span>PR</span>}
      </div>
      {rows.map((w) => (
        <WorktreeRow key={w.id} w={w} sid={sessionsByCwd[w.id]} cols={cols} template={template} />
      ))}
      {worktrees.length > rows.length && (
        <div className="flex h-7 items-center px-3 text-[11px] text-fg-faint">+{worktrees.length - rows.length} more</div>
      )}
    </div>
  )
})

/** One worktree row; subscribes to its own session only (status ticks don't re-render the table). */
const WorktreeRow = memo(function WorktreeRow({ w, sid, cols, template }: { w: Worktree; sid: ID | undefined; cols: { diff: boolean; ab: boolean; pr: boolean }; template: string }) {
  const sess = useApp((s) => (sid ? s.sessions[sid] : undefined))
  return (
    <div
      className="grid h-7 min-w-[420px] cursor-default items-center gap-3 border-b border-line-subtle/70 px-3 last:border-0 hover:bg-hover"
      style={{ gridTemplateColumns: template }}
      onClick={() => sess && select({ kind: "session", id: sess.id })}
      onDoubleClick={() => sess && openSession(sess.id)}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <GitBranch size={12} className="shrink-0 text-fg-faint" />
        <span className="truncate font-mono text-[11px] text-fg" title={w.branch}>{w.branch}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {sess ? (
          <>
            <StatusGlyph status={sess.status} size="xs" />
            <span className="truncate text-fg-muted" title={sess.title}>{sess.title}</span>
          </>
        ) : (
          <span className="text-fg-faint">{w.isMain ? "your checkout" : ""}</span>
        )}
      </span>
      {cols.diff && (
        <span className="tabular text-[11px] text-fg-faint" title={w.git.filesChanged ? `+${w.git.linesAdded} −${w.git.linesRemoved}` : undefined}>
          {w.git.filesChanged ? `${w.git.filesChanged} files` : ""}
        </span>
      )}
      {cols.ab && <span>{w.git.unpushed || w.git.behind ? <AheadBehind ahead={w.git.unpushed} behind={w.git.behind} /> : null}</span>}
      {cols.pr && <span>{w.git.pr ? <PrChip pr={w.git.pr} /> : null}</span>}
    </div>
  )
})

function RepoSessions({ repoId }: { repoId: ID }) {
  const structVersion = useApp((s) => s.structVersion)
  const statusVersion = useApp((s) => s.statusVersion)
  const list = useMemo(() => {
    const st = getApp()
    const ids = st.sessionIdsByRepo[repoId] ?? []
    const all = ids.map((id) => st.sessions[id]).filter((s) => !s.archived)
    const live = all.filter((s) => s.control !== "history").sort(compareAttention)
    const hist = all.filter((s) => s.control === "history").sort((a, b) => cmpIso(b.updatedAt, a.updatedAt)).slice(0, 12)
    return { live, hist, histTotal: all.length - live.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, structVersion, statusVersion])
  const [showHistory, setShowHistory] = useState(false)
  return (
    <div className="text-xs">
      {list.live.length === 0 && <div className="flex h-7 items-center px-3 text-fg-faint">No live sessions</div>}
      {list.live.map((s) => (
        <SessionLine key={s.id} id={s.id} />
      ))}
      {list.histTotal > 0 && (
        <button
          className="flex h-7 w-full items-center gap-1.5 border-t border-line-subtle px-3 text-left text-[11px] text-fg-faint hover:bg-hover hover:text-fg-muted"
          onClick={() => setShowHistory((v) => !v)}
          aria-expanded={showHistory}
        >
          {showHistory ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          History
          <span className="tabular">{list.histTotal}</span>
        </button>
      )}
      {showHistory && list.hist.map((s) => <SessionLine key={s.id} id={s.id} />)}
    </div>
  )
}

function SessionLine({ id }: { id: ID }) {
  const s = useApp((st) => st.sessions[id])
  const age = useRelTime(s?.updatedAt)
  if (!s) return null
  return (
    <div
      className="group flex h-7 cursor-default items-center gap-2 border-b border-line-subtle/70 px-3 last:border-0 hover:bg-hover"
      onClick={() => select({ kind: "session", id })}
      onDoubleClick={() => openSession(id)}
    >
      <StatusGlyph status={s.status} size="sm" />
      <span className={cn("min-w-0 flex-1 truncate", s.control === "history" ? "text-fg-muted" : "text-fg")} title={s.title}>{s.title}</span>
      {s.waitingFor && (
        <span className={cn("max-w-[40%] truncate text-[11px]", s.waitingFor.kind === "permission" ? "font-mono text-st-perm-fg" : "text-st-input-fg")} title={s.waitingFor.summary}>
          {s.waitingFor.summary}
        </span>
      )}
      <span className="tabular w-8 text-right text-[11px] text-fg-faint">{age}</span>
      {s.control === "history" ? (
        <button className="hidden h-5 items-center gap-1 rounded-sm px-1.5 text-[11px] text-fg-muted group-hover:flex hover:bg-selected hover:text-fg" onClick={(e) => { e.stopPropagation(); resumeSession(id) }} title="Resume (claude --resume)">
          <Play size={11} /> Resume
        </button>
      ) : (
        <button className="hidden size-5 items-center justify-center rounded-sm text-fg-faint group-hover:flex hover:bg-selected hover:text-fg" onClick={(e) => { e.stopPropagation(); openSession(id) }} title="Open">
          <ArrowUpRight size={12} />
        </button>
      )}
    </div>
  )
}

function LinksCard({ repoId }: { repoId: ID }) {
  const links = useApp((s) => s.links)
  const repos = useApp((s) => s.repos)
  const mine = links.filter((l) => l.from === repoId || l.to === repoId)
  return (
    <Card title="Linked" count={mine.length || undefined}>
      {mine.length === 0 ? (
        <div className="flex h-8 items-center px-3 text-xs text-fg-faint">None</div>
      ) : (
        <div className="py-1">
          {mine.map((l) => {
            const other = repos[l.from === repoId ? l.to : l.from]
            return (
              <div
                key={l.id}
                className="flex h-7 cursor-default items-center gap-2 px-3 text-xs hover:bg-hover"
                onClick={() => select({ kind: "repo", id: other.id })}
                onDoubleClick={() => openRepo(other.id)}
                title={`${l.kind} · ${l.label}`}
              >
                <Link2 size={12} className="shrink-0 text-fg-faint" />
                <span className="truncate text-fg">{other.name}</span>
                <span className="ml-auto shrink-0 text-[11px] text-fg-faint">{l.kind}</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function GraphifyCard({ repoId }: { repoId: ID }) {
  const g = useApp((s) => s.repos[repoId]?.graphify)
  const has = !!g && g.state !== "none"
  return (
    <Card
      title="Graph"
      collapsible={has}
      summary={has ? `${g.state} · ${compact(g.nodes ?? 0)} nodes` : undefined}
      actions={has ? <Button size="xs" variant="ghost" onClick={() => openGraph(repoId)}>Open</Button> : undefined}
    >
      {!has ? (
        <div className="flex h-8 items-center px-3 text-xs text-fg-faint" title="Docs-only repos are skipped">No graph</div>
      ) : (
        <div className="px-3 py-2.5 text-xs">
          <div className="flex items-center gap-2 text-fg-muted">
            <span>{g.state}</span>
            <span className="font-mono text-[11px] text-fg-faint">@{g.builtAtCommit}</span>
          </div>
          <div className="tabular mt-1 text-fg-faint">
            {compact(g.nodes ?? 0)} nodes · {compact(g.edges ?? 0)} edges · {g.communities} communities
          </div>
          <div className="mt-2.5 section-label">God nodes</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {(getApp().repoSpecs[repoId]?.symbols ?? []).slice(0, 4).map((sym) => (
              <span key={sym} className="rounded-sm border border-line-subtle px-1.5 py-0.5 font-mono text-[10.5px] text-fg-muted">{sym}</span>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}
