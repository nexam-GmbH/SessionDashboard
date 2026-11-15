// The session's details beside the chat (Claude Code desktop's right panel): where it runs, what
// fills its context window, its changes and pull request, and the plan's limits.
import { useEffect, useState, type ReactNode } from "react"
import { CircleCheck, CircleDashed, CircleX, Cloud, ExternalLink, FileDiff, Folder, GitBranch, GitPullRequest, Monitor, Server, SquareTerminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useApp } from "@/store/app"
import { openReview, sendMessage } from "@/store/actions"
import { capabilities } from "@/lib/status"
import { homePath, plural } from "@/lib/format"
import { cn } from "@/lib/utils"
import { IN_TAURI } from "@/lib/platform"
import { REAL } from "@/backend/mode"
import type { ID, Session } from "@/lib/model"
import { useChangedFiles } from "../sessionStore"
import { Meter } from "@/features/usage/UsageView"
import { useUsage } from "@/features/usage/usageData"

// validated categorical steps for the dark surface, in a fixed order (dataviz reference palette)
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"]

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

export function DetailsPanel({ sessionId }: { sessionId: ID }) {
  const s = useApp((st) => st.sessions[sessionId])
  if (!s) return null
  return (
    <aside aria-label="Session details" className="flex w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l px-4 py-4 text-sm">
      <Environment s={s} />
      <Context s={s} />
      <Changes s={s} />
      <Limits cost={s.usage.costUsd} />
    </aside>
  )
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex h-6 items-center gap-2">
        <h3 className="flex-1 text-xs font-medium text-muted-foreground">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  )
}

function Row({ icon, children, title }: { icon: ReactNode; children: ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2" title={title}>
      <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

function Environment({ s }: { s: Session }) {
  const branch = useApp((st) => {
    const repo = s.repoId ? st.repos[s.repoId] : undefined
    return repo?.worktrees.find((w) => w.id === s.worktreeId)?.branch || repo?.git?.branch
  })
  const where =
    s.machine === "cloud"
      ? { icon: <Cloud />, text: "claude.ai (cloud)" }
      : s.machine
        ? { icon: <Server />, text: s.machine }
        : s.control === "observed"
          ? { icon: <SquareTerminal />, text: "This computer · in your terminal" }
          : { icon: <Monitor />, text: "This computer" }
  return (
    <Section title="Environment">
      <Row icon={where.icon}>{where.text}</Row>
      <Row icon={<Folder />} title={s.cwd}>
        <span className="font-mono text-xs">{homePath(s.cwd)}</span>
      </Row>
      {branch && (
        <Row icon={<GitBranch />}>
          <span className="font-mono text-xs">{branch}</span>
        </Row>
      )}
    </Section>
  )
}

function Context({ s }: { s: Session }) {
  const c = s.usage.context
  const caps = capabilities(s.control)
  // a session the app runs answers how full its context is; ask when the panel shows it
  useEffect(() => {
    if (REAL && s.control === "owned") void import("@/backend/real").then((r) => r.realAskContext(s.id))
  }, [s.id, s.control])
  if (!c) {
    return (
      <Section title="Context">
        {s.usage.contextPct > 0 ? <Meter label="Used" percent={s.usage.contextPct} /> : <p className="text-xs text-muted-foreground">Shown for sessions this app runs, after their first reply.</p>}
      </Section>
    )
  }
  const pct = Math.round((c.used / c.max) * 100)
  const used = c.categories.filter((x) => x.kind === "used" && !x.deferred && x.tokens > 0)
  const rest = c.categories.filter((x) => x.kind !== "used" && !x.deferred && x.tokens > 0)
  const buffer = rest.find((x) => /buffer/i.test(x.name))
  const free = rest.find((x) => /free/i.test(x.name))
  return (
    <Section
      title="Context"
      action={
        caps.changeSettings && (
          <Button size="xs" variant="outline" onClick={() => sendMessage(s.id, "/compact", "now")}>
            Compact
          </Button>
        )
      }
    >
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums">{pct}% used</span>
        <span className="tabular text-xs text-muted-foreground">
          {k(c.used)} / {k(c.max)}
        </span>
      </div>
      {/* one stacked bar, 2px gaps between parts; the rows below are its legend */}
      <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-muted" role="img" aria-label={`${pct}% of the context window used`}>
        {used.map((x, i) => (
          <span key={x.name} className="h-full first:rounded-l-full" style={{ width: `${(x.tokens / c.max) * 100}%`, background: SERIES[i % SERIES.length] }} />
        ))}
      </div>
      <ul className="flex flex-col gap-1 text-xs">
        {used.map((x, i) => (
          <li key={x.name} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-sm" style={{ background: SERIES[i % SERIES.length] }} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{x.name}</span>
            <span className="tabular text-muted-foreground">{k(x.tokens)}</span>
            <span className="tabular w-11 text-right text-muted-foreground">{((x.tokens / c.max) * 100).toFixed(1)}%</span>
          </li>
        ))}
        {rest.map((x) => (
          <li key={x.name} className="flex items-center gap-2 text-muted-foreground">
            <span className="size-2 shrink-0 rounded-sm bg-muted ring-1 ring-foreground/15" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{x.name}</span>
            <span className="tabular">{k(x.tokens)}</span>
            <span className="tabular w-11 text-right">{((x.tokens / c.max) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
      {free && buffer && <p className="text-xs text-muted-foreground">{k(Math.max(0, free.tokens))} until auto-compact</p>}
    </Section>
  )
}

interface Pr {
  number: number
  url: string
  title: string
  state: string
  isDraft?: boolean
  reviewDecision?: string
  mergeable?: string
  statusCheckRollup?: { conclusion?: string; state?: string; status?: string }[]
}

function checks(pr: Pr) {
  let ok = 0
  let bad = 0
  let wait = 0
  for (const c of pr.statusCheckRollup ?? []) {
    const r = (c.conclusion || c.state || c.status || "").toUpperCase()
    if (/SUCCESS|NEUTRAL|SKIPPED/.test(r)) ok++
    else if (/FAIL|ERROR|CANCEL|TIMED_OUT|ACTION_REQUIRED/.test(r)) bad++
    else wait++
  }
  return { ok, bad, wait }
}

function usePr(cwd: string, machine?: string) {
  const [pr, setPr] = useState<Pr | null | undefined>(undefined)
  useEffect(() => {
    if (!(IN_TAURI && REAL) || machine) return
    let alive = true
    const load = () =>
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke<Pr | null>("pr_status", { cwd }))
        .then((p) => alive && setPr(p))
        .catch(() => alive && setPr(null))
    load()
    const t = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [cwd, machine])
  return pr
}

function Changes({ s }: { s: Session }) {
  const files = useChangedFiles(s.id)
  const pr = usePr(s.cwd, s.machine)
  const n = files.length || s.diff.filesChanged
  const added = files.length ? files.reduce((a, f) => a + f.added, 0) : s.diff.linesAdded
  const removed = files.length ? files.reduce((a, f) => a + f.removed, 0) : s.diff.linesRemoved
  const c = pr ? checks(pr) : null
  return (
    <Section title="Changes">
      {n > 0 ? (
        <div className="flex items-center gap-2">
          <FileDiff className="size-4 shrink-0 text-muted-foreground" />
          <span className="tabular font-mono text-xs">
            <span className="text-diff-add">+{added}</span> <span className="text-diff-del">−{removed}</span>
          </span>
          <span className="text-xs text-muted-foreground">{plural(n, "file")}</span>
          <span className="flex-1" />
          <Button size="xs" variant="outline" onClick={() => openReview(s.id)}>
            Review
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No changes yet.</p>
      )}
      {pr ? (
        <a href={pr.url} className="flex flex-col gap-1 rounded-lg p-2 ring-1 ring-foreground/10 hover:bg-accent" title="Open on GitHub">
          <span className="flex min-w-0 items-center gap-2">
            <GitPullRequest className={cn("size-4 shrink-0", pr.state === "MERGED" ? "text-[#9085e9]" : pr.state === "CLOSED" ? "text-st-error-fg" : "text-st-done-fg")} />
            <span className="min-w-0 flex-1 truncate">
              #{pr.number} {pr.title}
            </span>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-muted-foreground">
            <span>{pr.isDraft ? "Draft" : pr.state === "OPEN" ? "Open" : pr.state === "MERGED" ? "Merged" : "Closed"}</span>
            {pr.reviewDecision && <span>{pr.reviewDecision === "APPROVED" ? "Approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : "Review required"}</span>}
            {c && c.ok + c.bad + c.wait > 0 && (
              <span className="flex items-center gap-2">
                {c.bad > 0 && (
                  <span className="flex items-center gap-0.5 text-st-error-fg">
                    <CircleX className="size-3" /> {c.bad} failing
                  </span>
                )}
                {c.wait > 0 && (
                  <span className="flex items-center gap-0.5">
                    <CircleDashed className="size-3" /> {c.wait} running
                  </span>
                )}
                {c.ok > 0 && !c.bad && !c.wait && (
                  <span className="flex items-center gap-0.5 text-st-done-fg">
                    <CircleCheck className="size-3" /> checks pass
                  </span>
                )}
              </span>
            )}
          </span>
        </a>
      ) : (
        pr === null &&
        n > 0 && (
          <Button size="sm" variant="outline" className="self-start" onClick={() => void import("@/features/terminal/terminals").then((t) => t.runInTerminal("gh pr create --fill"))}>
            <GitPullRequest /> Create PR
          </Button>
        )
      )}
    </Section>
  )
}

function Limits({ cost }: { cost: number }) {
  const limits = useUsage((st) => st.limits?.limits)
  const session = limits?.find((l) => l.group === "session")
  const week = limits?.find((l) => l.kind === "weekly_all") ?? limits?.find((l) => l.group === "weekly")
  return (
    <Section title="Usage">
      {session && <Meter label="Current session (5 h)" percent={session.percent} />}
      {week && <Meter label="This week" percent={week.percent} />}
      {cost > 0 && <p className="text-xs text-muted-foreground">This session so far: ${cost.toFixed(2)} at API prices</p>}
    </Section>
  )
}
