// Overview — the owner's sketch: main agent on top, one node per repo on a shared
// rail, each repo's sessions hanging below it, running subagents below their session. Calm at
// rest: a card is status glyph + title + one line saying where the session is; only what needs
// the owner is coloured, and a permission can be answered right on its card (once options only).
import { memo } from "react"
import { Cloud, FolderGit2, Layers, Plus, Server, TriangleAlert } from "lucide-react"
import { EditableTitle, SessionMenu } from "@/features/rename/Rename"
import { useShallow } from "zustand/react/shallow"
import { useApp } from "@/store/app"
import { selectOverviewSessionIds, selectNeedsYou, shownStatus, useHomeRepos, useSession, useVisibleRepos } from "@/store/selectors"
import { openNewSession, openSession, setWorkspace } from "@/store/actions"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { ModeMark } from "@/components/common/ModeMark"
import { riskOf } from "@/features/requests/risk"
import { OverlapLine } from "@/components/common/OverlapNote"
import { PortChips } from "@/components/common/PortChips"
import { RestoreCard } from "./RestoreCard"
import { ParkedCard } from "./ParkedCard"
import { RelativeTime, useQuietMinutes } from "@/components/common/RelativeTime"
import { onceOptions, OnceButtons } from "@/features/requests/OnceAnswers"
import { capabilities } from "@/lib/status"
import { whereItIs, WHERE_TONE_CLASS } from "@/lib/where"
import { cn } from "@/lib/utils"
import { homePath, plural } from "@/lib/format"
import type { ID, RepoGit, Session } from "@/lib/model"
import { LooseEnds } from "./LooseEnds"
import { Skeleton } from "@/components/ui/skeleton"
import { ensureTranscript } from "@/mocks/transcript"
import "./overview.css"

export default function Overview() {
  const repoOrder = useVisibleRepos()
  const homes = useHomeRepos()
  const hasMain = useApp((s) => !!s.sessions[s.mainSessionId]) || homes.length > 0
  const ready = useApp((s) => s.ready)
  if (!ready) return <OverviewSkeleton />
  if (!repoOrder.length && !homes.length) return <NoSessions />
  return (
    <div className="ov h-full w-full overflow-auto" style={{ "--n": repoOrder.length } as React.CSSProperties}>
      <RestoreCard />
      <ParkedCard />
      <div className="ov-tree">
        {hasMain && (
          <div className="ov-main-wrap gap-6">
            <MainCard />
            {homes.map((id) => (
              <HomeTier key={id} repoId={id} />
            ))}
          </div>
        )}
        <div className={cn("ov-repos", (repoOrder.length === 1 || !hasMain) && "ov-single", !hasMain && "ov-no-main")}>
          {repoOrder.map((id) => (
            <RepoColumn key={id} repoId={id} />
          ))}
        </div>
      </div>
      <LooseEnds className="pb-12" />
    </div>
  )
}

/**
 * A working session that has written nothing for 5+ minutes: a long command, or a hang. Said plainly
 * on the card ("no output for 7 min") so a silent stall does not pass for progress.
 */
function QuietFor({ s }: { s: Session }) {
  const min = useQuietMinutes(s.updatedAt, s.status === "working")
  if (min === null) return null
  return <span className="text-muted-foreground/70"> · no output for {min} min</span>
}

/** While the first list of sessions is read: the tree's shape (main card, rail, repo columns). */
function OverviewSkeleton() {
  const cols = [3, 2, 4, 1]
  return (
    <div className="ov h-full w-full overflow-hidden" aria-busy="true" aria-label="Loading sessions" style={{ "--n": cols.length } as React.CSSProperties}>
      <div className="ov-tree">
        <div className="ov-main-wrap">
          <Skeleton className="h-[68px] w-[380px] rounded-xl" />
        </div>
        <div className="ov-repos">
          {cols.map((n, c) => (
            <section key={c} className="ov-col">
              <Skeleton className="h-[52px] w-full rounded-xl" />
              <div className="ov-sessions">
                {Array.from({ length: n }, (_, i) => (
                  <div key={i} className="ov-item">
                    <Skeleton className="h-[76px] w-full rounded-xl" />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

/** No running sessions yet: say how they get here. */
function NoSessions() {
  // a workspace with nothing running while others have sessions: say so, and offer them all
  const ws = useApp((s) => (s.settings.workspace ? s.settings.workspaces.find((w) => w.id === s.settings.workspace)?.name : undefined))
  const elsewhere = useApp((s) => (s.settings.workspace ? Object.values(s.sessions).filter((x) => !x.archived && x.control !== "history").length : 0))
  return (
    <div className="flex h-full w-full flex-col overflow-auto">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <p className="text-base text-foreground">{ws ? `Nothing running in ${ws}` : "No Claude Code sessions running"}</p>
        {ws && elsewhere > 0 && (
          <button onClick={() => setWorkspace("")} className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {elsewhere} running in other workspaces · show all
          </button>
        )}
        <p className="max-w-[440px] text-sm text-muted-foreground">
          Start <code className="font-mono text-xs">claude</code> in any project and it shows up here by itself, or start one from here.
        </p>
        <button onClick={() => openNewSession()} className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80">
          <Plus size={14} /> New session
        </button>
      </div>
      <LooseEnds className="pb-12" />
    </div>
  )
}

/** One quiet line of git under a project: branch, then only what is not zero. */
function gitLine(g?: RepoGit) {
  if (!g?.isRepo) return null
  const parts: string[] = []
  if (g.changed) parts.push(`${plural(g.changed, "file")} changed`)
  if (g.hasRemote && g.unpushed) parts.push(`${g.unpushed} not pushed`)
  if (g.behind) parts.push(`${g.behind} behind`)
  return { branch: g.branch, rest: parts.join(" · ") }
}

/** "from ~ · api, web": where an agent started and the folders it worked in. */
function Origin({ s }: { s: Session }) {
  const start = s.startCwd ?? s.cwd
  const worked = [...new Set((s.cwds ?? [s.cwd]).filter((c) => c !== start).map((c) => c.split("/").filter(Boolean).pop() ?? c))].slice(0, 3)
  return (
    <p className="pointer-events-none relative mt-0.5 truncate pl-[22px] text-xs leading-4 text-muted-foreground/70" title={(s.cwds ?? []).map(homePath).join("\n")}>
      from <span className="font-mono text-xs">{homePath(start)}</span>
      {worked.length > 0 && <> · {worked.join(", ")}</>}
    </p>
  )
}

/**
 * A workspace's main folder on top of its repos (the owner's sketch: one agent above the repos).
 * A session started here works across every repo of the workspace at once.
 */
const HomeTier = memo(function HomeTier({ repoId }: { repoId: ID }) {
  const name = useApp((s) => s.repos[repoId]?.name)
  const path = useApp((s) => s.repos[repoId]?.rootPath)
  const all = useApp(useShallow((s) => selectOverviewSessionIds(s, repoId)))
  // the workspace's lead: first, on its own, marked
  const lead = useApp((s) => {
    const ws = s.repos[repoId]?.workspace
    const l = s.settings.workspaces.find((w) => w.id === ws)?.lead
    return l && all.includes(l) ? l : undefined
  })
  const ids = lead ? all.filter((id) => id !== lead) : all
  return (
    <section className="flex max-w-[calc(100vw-64px)] flex-col items-center gap-2.5" aria-label={`${name}: all repos`}>
        <div className="flex h-9 items-center gap-2 rounded-xl bg-card pr-1 pl-2.5 ring-1 ring-foreground/10 transition-shadow hover:ring-foreground/20">
          <Layers size={14} className="shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium text-foreground">{name}</span>
          <span className="font-mono text-xs text-muted-foreground/70">{path ? homePath(path) : ""}</span>
          <span className="text-xs text-muted-foreground/70">· all repos</span>
          <button
            onClick={() => openNewSession(repoId)}
            aria-label={`New session for all of ${name}`}
            title="A session here works across every repo of the workspace"
            className="ml-1 flex size-7 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Plus size={14} />
          </button>
        </div>
      {lead && (
        <div className="flex flex-col items-center gap-1" aria-label="Lead">
          <span className="text-xs text-muted-foreground/70">lead</span>
          <div className="w-[300px]">
            <SessionCardById id={lead} origin />
          </div>
        </div>
      )}
      {ids.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2.5">
          {ids.map((id) => (
            <div key={id} className="w-[300px]">
              <SessionCardById id={id} origin />
            </div>
          ))}
        </div>
      )}
    </section>
  )
})

function MainCard() {
  const id = useApp((s) => s.mainSessionId)
  const s = useSession(id)
  if (!s) return null
  return <SessionCard s={s} main />
}

const RepoColumn = memo(function RepoColumn({ repoId }: { repoId: ID }) {
  const name = useApp((s) => s.repos[repoId]?.name)
  const machine = useApp((s) => s.repos[repoId]?.machine)
  const git = gitLine(useApp((s) => s.repos[repoId]?.git))
  const main = useApp((s) => s.mainSessionId)
  const ids = useApp(useShallow((s) => selectOverviewSessionIds(s, repoId).filter((id) => id !== main)))
  const Icon = machine === "cloud" ? Cloud : machine ? Server : FolderGit2
  return (
    <section className="ov-col" aria-label={name}>
      {/* the repo's card: the parent of its column (second level of the sketch) */}
      <div className="group/repo w-full min-w-0 rounded-xl bg-card py-2.5 pr-1.5 pl-2.5 ring-1 ring-foreground/10 transition-shadow hover:ring-foreground/20">
        <div className="flex h-5 min-w-0 items-center gap-2">
          <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {name}
            {machine && machine !== "cloud" && <span className="ml-1.5 text-xs font-normal text-muted-foreground/70">on {machine}</span>}
          </h2>
          {machine !== "cloud" && (
            <button
              onClick={() => openNewSession(repoId)}
              aria-label={`New session in ${name}`}
              title={`New session in ${name}`}
              className="-my-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity group-hover/repo:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
        {git && (git.branch || git.rest) && (
          <p className="mt-0.5 truncate pl-[22px] text-xs leading-4 text-muted-foreground/70" title={[git.branch, git.rest].filter(Boolean).join(" · ")}>
            {git.branch && <span className="font-mono text-xs">{git.branch}</span>}
            {git.branch && git.rest && " · "}
            {git.rest}
          </p>
        )}
      </div>
      {ids.length > 0 ? (
        <div className="ov-sessions">
          {ids.map((id) => (
            <div key={id} className="ov-item">
              <SessionCardById id={id} />
            </div>
          ))}
        </div>
      ) : (
        <p className="pt-3 pl-[30px] text-xs text-muted-foreground/70">No sessions</p>
      )}
    </section>
  )
})

const SessionCardById = memo(function SessionCardById({ id, origin }: { id: ID; origin?: boolean }) {
  const s = useSession(id)
  if (!s) return null
  return <SessionCard s={s} origin={origin} />
})

const TONE_CARD: Record<string, string> = {
  perm: "ring-st-perm/60 hover:ring-st-perm/90",
  input: "ring-st-perm/55 hover:ring-st-perm/80",
  error: "ring-st-error/60 hover:ring-st-error/90",
}

/** `origin`: say where it started and which repos it worked in (main-folder agents). */
function SessionCard({ s, main, origin }: { s: Session; main?: boolean; origin?: boolean }) {
  const req = useApp((st) => (s.waitingFor?.requestId ? st.requests[s.waitingFor.requestId] : undefined))
  const needs = useApp((st) => selectNeedsYou(st).includes(s.id))
  const status = useApp((st) => shownStatus(st, s.id))
  const child = useApp(
    useShallow((st) =>
      (st.subagentIdsBySession[s.id] ?? [])
        .map((a) => st.subagents[a])
        .filter((a) => a && (a.status === "running" || a.status === "waiting_permission")),
    ),
  )
  const waitingChild = child.find((a) => a.status === "waiting_permission")
  const where = whereItIs(s, req, waitingChild)
  const once = s.status === "waiting_permission" && capabilities(s.control).approve ? onceOptions(req, s.cwd) : undefined
  const risk = s.status === "waiting_permission" && req?.type === "permission" ? riskOf(req, s.cwd) : null
  const tone = needs ? (where.tone === "error" ? "error" : where.tone === "input" ? "input" : "perm") : null
  const quiet = s.status === "idle" || s.status === "stopped"
  return (
    <>
      <SessionMenu id={s.id} where="overview">
      <div
        className={cn(
          "group/card relative rounded-xl bg-card px-3 py-3 ring-1 transition-shadow",
          tone ? TONE_CARD[tone] : "ring-foreground/10 hover:ring-foreground/20",
          main ? "w-[380px]" : "w-full",
        )}
      >
        {/* the whole card opens the session; the answer buttons sit above this layer */}
        <button
          onClick={() => openSession(s.id)}
          onPointerEnter={() => ensureTranscript(s.id)}
          aria-label={`Open ${s.title}`}
          className="absolute inset-0 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <div className="pointer-events-none relative flex min-w-0 items-start gap-2">
          <StatusGlyph status={status} outcome={s.outcome} size="sm" className="mt-[3px]" title={null} />
          <h3
            className={cn(
              "min-w-0 flex-1 text-sm leading-5 font-medium break-words",
              main ? "text-base leading-[20px]" : "line-clamp-3",
              quiet ? "text-muted-foreground" : "text-foreground",
            )}
          >
            <EditableTitle id={s.id} where="overview" className="h-6 text-sm font-medium">
              {s.title}
            </EditableTitle>
          </h3>
          <ModeMark mode={s.permissionMode} className="mt-[3px]" />
          {/* how long it has been waiting: only where it matters (rename: right-click the card) */}
          {needs && <RelativeTime iso={s.statusObservedAt} className="tabular shrink-0 pt-px text-xs leading-[17px] text-muted-foreground/70" />}
        </div>
        {where.text && (
          <p
            className={cn(
              "pointer-events-none relative mt-1 truncate pl-[22px] text-xs leading-[17px]",
              WHERE_TONE_CLASS[where.tone],
              where.mono && "font-mono text-xs",
            )}
            title={where.text}
          >
            {where.text}
            <QuietFor s={s} />
          </p>
        )}
        {origin && <Origin s={s} />}
        <OverlapLine id={s.id} className="pointer-events-none relative mt-1 pl-[22px]" />
        <PortChips id={s.id} className="relative mt-1.5 pl-[22px]" />
        {once && (
          <div className="relative mt-2 flex items-center gap-1 pl-[22px]">
            <OnceButtons once={once} />
          </div>
        )}
        {risk?.high && (
          <p className="pointer-events-none relative mt-2 flex items-center gap-1.5 pl-[22px] text-xs text-foreground">
            <TriangleAlert size={12} className="shrink-0" />
            <span className="min-w-0 truncate">{risk.effect}: open to answer</span>
          </p>
        )}
      </div>
      </SessionMenu>
      {!main && child.length > 0 && (
        <div className="ov-subs">
          {child.slice(0, 3).map((a) => (
            <div key={a.id} className="ov-sub" title={a.description}>
              <span className={cn("mr-1.5 size-1.5 shrink-0 rounded-full", a.status === "waiting_permission" ? "bg-st-perm" : "bg-st-working")} />
              <span className="shrink-0 text-xs text-muted-foreground">{a.agentType}</span>
              <span className="ml-1.5 truncate text-xs text-muted-foreground/70">{a.description}</span>
            </div>
          ))}
          {child.length > 3 && <div className="ov-sub text-xs text-muted-foreground/70">{child.length - 3} more</div>}
        </div>
      )}
    </>
  )
}
