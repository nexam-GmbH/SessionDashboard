// The session rail beside the chat (Claude Code desktop's "Session details"): flat sections with
// inset hairlines, a header per section (title, caret, a muted summary while collapsed) and 32 px
// rows. Environment · Context · Changes (with the linked PR) · Checks · Servers · Background tasks.
// Each section subscribes to its own slice and renders nothing when it has nothing to say; plan
// limits and the session's cost live in the composer's context ring, as in desktop.
import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react"
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Cloud,
  Ellipsis,
  ExternalLink,
  FileDiff,
  Folder,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  Monitor,
  Server,
  ServerCog,
  UserRound,
  Users,
} from "lucide-react"
import { useApp } from "@/store/app"
import { openReview, openSession, sendMessage } from "@/store/actions"
import { useOverlaps } from "@/store/selectors"
import { capabilities } from "@/lib/status"
import { homePath, plural } from "@/lib/format"
import { accountName, activeAccountOf } from "@/lib/accounts"
import { useHasAccounts } from "@/features/accounts/AccountItems"
import { cn } from "@/lib/utils"
import { IN_TAURI } from "@/lib/platform"
import { REAL } from "@/backend/mode"
import type { ID } from "@/lib/model"
import { usePorts, openPort } from "@/backend/ports"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { RelativeTime } from "@/components/common/RelativeTime"
import { setExpanded, useChangedFiles, useExpanded } from "../sessionStore"
import { useVerification } from "../signals"
import { StartFreshButton } from "./StartFresh"
import { breakdown, compactHint, severity } from "./contextMath"
import { lastItem, summarize, useSummaries, type SummaryKind } from "../summary/chatSummary"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { useShownStatus } from "@/store/selectors"
import type { Outcome } from "@/lib/outcome"

// ---------------------------------------------------------------- shell

const RAIL = 280
/** the chat keeps at least this much beside a docked rail; narrower, the rail floats over it */
const MIN_CHAT = 640

export function DetailsPanel({ sessionId }: { sessionId: ID }) {
  const exists = useApp((st) => !!st.sessions[sessionId])
  const ref = useRef<HTMLElement>(null)
  const floating = useFloating(ref)
  if (!exists) return null
  return (
    <aside
      ref={ref}
      aria-label="Session details"
      tabIndex={-1}
      className={cn(
        "flex w-[280px] shrink-0 flex-col overflow-y-auto overscroll-contain pb-2 outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        floating
          ? "absolute top-3 right-2 z-20 max-h-[calc(100%-20px)] rounded-xl border border-[var(--cc-ring)] bg-[var(--cc-surface)] shadow-[var(--cc-shadow-medium)] animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none"
          : "mr-1.5",
      )}
    >
      <InThisChat sessionId={sessionId} />
      <Environment sessionId={sessionId} />
      <Context sessionId={sessionId} />
      <Changes sessionId={sessionId} />
      <Checks sessionId={sessionId} />
      <Servers sessionId={sessionId} />
      <BackgroundTasks sessionId={sessionId} />
    </aside>
  )
}

const closeRail = () => useApp.setState((s) => ({ settings: { ...s.settings, detailsOpen: false } }))

/**
 * Docked while the chat keeps 640 px beside it; narrower, a floating card that Escape or a click
 * outside closes (desktop's overlay mode). Measured on resize only, never per frame.
 */
function useFloating(ref: React.RefObject<HTMLElement | null>) {
  const [floating, setFloating] = useState(false)
  useLayoutEffect(() => {
    const host = ref.current?.parentElement
    if (!host || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(([e]) => setFloating(e.contentRect.width - RAIL < MIN_CHAT))
    ro.observe(host)
    return () => ro.disconnect()
  }, [ref])
  useEffect(() => {
    if (!floating) return
    ref.current?.focus({ preventScroll: true })
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      // only from the card itself: Escape in the prompt box stops Claude and must not also close it
      const t = e.target as Element | null
      if (t !== document.body && !(t && ref.current?.contains(t))) return
      if (t?.closest?.("[role=menu],[role=dialog]")) return
      closeRail()
    }
    const down = (e: PointerEvent) => {
      if (e.pointerType === "touch") return
      const t = e.target as Element | null
      if (!t?.closest || ref.current?.contains(t) || t.closest('[aria-label="Session details"],[data-radix-popper-content-wrapper]')) return
      closeRail()
    }
    document.addEventListener("keydown", key)
    document.addEventListener("pointerdown", down, true)
    return () => {
      document.removeEventListener("keydown", key)
      document.removeEventListener("pointerdown", down, true)
    }
  }, [floating, ref])
  return floating
}

// ---------------------------------------------------------------- sections

type SectionId = "summary" | "environment" | "context" | "changes" | "checks" | "servers" | "tasks"
const DEFAULT_OPEN: Record<SectionId, boolean> = { summary: true, environment: true, context: false, changes: true, checks: true, servers: true, tasks: true }
const SECTIONS = Object.keys(DEFAULT_OPEN) as SectionId[]
const STICKY = "sd.rail.open"

// a manual open or close is remembered for this session and becomes the section's default elsewhere
let sticky: Partial<Record<SectionId, boolean>> = (() => {
  try {
    return JSON.parse(localStorage.getItem(STICKY) ?? "{}") as Partial<Record<SectionId, boolean>>
  } catch {
    return {}
  }
})()
const openKey = (sessionId: ID, id: SectionId) => `rail:${sessionId}:${id}`
const defaultOpen = (id: SectionId) => sticky[id] ?? DEFAULT_OPEN[id]

function setSection(sessionId: ID, id: SectionId, open: boolean) {
  setExpanded(openKey(sessionId, id), open)
  sticky = { ...sticky, [id]: open }
  try {
    localStorage.setItem(STICKY, JSON.stringify(sticky))
  } catch {
    /* private window: per-session state still works */
  }
}

const useSectionOpen = (sessionId: ID, id: SectionId) => useExpanded(openKey(sessionId, id), defaultOpen(id))[0]

const FOCUS = "outline-none focus-visible:shadow-[0_0_0_1px_var(--cc-accent),0_0_0_6px_var(--cc-focus-glow)]"

function Section({ sessionId, id, title, summary, onPrefetch, children }: { sessionId: ID; id: SectionId; title: string; summary?: ReactNode; onPrefetch?: () => void; children: ReactNode }) {
  const open = useSectionOpen(sessionId, id)
  const toggle = (e: MouseEvent) => {
    // Alt+click opens or closes every section at once
    if (e.altKey) SECTIONS.forEach((x) => setSection(sessionId, x, !open))
    else setSection(sessionId, id, !open)
  }
  const head = `rail-${id}-${sessionId}`
  return (
    <section
      aria-labelledby={head}
      className={cn("relative px-2 pt-3 not-first:before:absolute not-first:before:inset-x-4 not-first:before:top-0 not-first:before:h-px not-first:before:bg-cc-wash", open ? "pb-2" : "pb-3")}
    >
      <button
        id={head}
        type="button"
        aria-expanded={open}
        onClick={toggle}
        onPointerEnter={onPrefetch}
        onFocus={onPrefetch}
        className={cn("group flex min-h-8 w-full min-w-0 items-center rounded-lg px-2 text-left", FOCUS)}
      >
        <span className="shrink-0 text-[13px] leading-4 font-medium text-cc-fg dark:font-[460]">{title}</span>
        <ChevronDown
          aria-hidden
          className={cn("ml-1 size-3.5 shrink-0 text-cc-fg2", open ? "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : "-rotate-90")}
        />
        {summary != null && summary !== "" && (
          <span className={cn("tabular ml-auto flex min-w-0 items-center gap-1.5 pl-2 text-[13px] leading-4 text-cc-fg2", open && "invisible")}>{summary}</span>
        )}
      </button>
      {open && <div className="flex flex-col pt-1">{children}</div>}
    </section>
  )
}

/** A rail row: 32 px, 20 px glyph in the secondary ink, 14 px label, footnote meta at the end. */
function Row({ icon, children, meta, title, className }: { icon: ReactNode; children: ReactNode; meta?: ReactNode; title?: string; className?: string }) {
  return (
    <div className={cn("group/row flex min-h-8 min-w-0 items-center gap-2.5 rounded-lg px-2 text-sm leading-5", className)} title={title}>
      <span className="grid size-5 shrink-0 place-items-center text-cc-fg2 [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-cc-fg">{children}</span>
      {meta != null && meta !== false && <span className="tabular flex shrink-0 items-center gap-1 text-[13px] leading-4 text-cc-fg2">{meta}</span>}
    </div>
  )
}

const ROW_BUTTON = cn("hover:bg-cc-ghost active:bg-cc-wash-2", FOCUS)
/** desktop's xs secondary button (24 px) */
const XS = cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-cc-secondary px-2 text-[13px] leading-4 text-cc-fg hover:bg-cc-secondary-hover disabled:pointer-events-none aria-disabled:opacity-50", FOCUS)
/** desktop's xs ghost button */
const XS_GHOST = cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] leading-4 text-cc-fg2 hover:bg-cc-ghost hover:text-cc-fg data-[state=open]:bg-cc-ghost-sel", FOCUS)

function Tip({ label, children, side = "left" }: { label: ReactNode; children: ReactNode; side?: "left" | "top" | "bottom" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-[260px]">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

const k = (n: number) => {
  const t = (x: number) => x.toFixed(1).replace(/\.0$/, "")
  return n >= 1e6 ? `${t(n / 1e6)}M` : n >= 1e5 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${t(n / 1e3)}k` : String(n)
}
const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p
const parent = (p: string) => homePath(p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, ""))

function useBranch(sessionId: ID) {
  return useApp((st) => {
    const s = st.sessions[sessionId]
    const repo = s?.repoId ? st.repos[s.repoId] : undefined
    return repo?.worktrees.find((w) => w.id === s?.worktreeId)?.branch || repo?.git?.branch || ""
  })
}

// ---------------------------------------------------------------- In this chat

const DONE: Outcome = { tone: "green", kind: "done", label: "Done" }
const KIND_NOTE: Record<SummaryKind, string | undefined> = { features: undefined, question: "Question", task: "Task" }

/**
 * What the chat is about: the features it builds or debugs (one sentence each), the question it
 * answers, or the task it runs. The one still being worked on carries the session's own status
 * glyph; finished ones a done mark. Written by a small model after a turn (chatSummary.ts).
 */
const InThisChat = memo(function InThisChat({ sessionId }: { sessionId: ID }) {
  const on = useApp((st) => st.settings.chatSummary)
  const summary = useSummaries((s) => s.map[sessionId])
  const busy = useSummaries((s) => !!s.busy[sessionId])
  const failed = useSummaries((s) => s.failed[sessionId])
  const status = useShownStatus(sessionId)
  const outcome = useApp((st) => st.sessions[sessionId]?.outcome)
  const upto = useApp((st) => lastItem(st.transcripts[sessionId]))
  const working = status === "working" || status === "starting"
  const stale = !!upto && summary?.upto !== upto && failed !== upto
  // after a turn: bring it up to date (a moment later: a quick follow-up costs no second call); a
  // chat with none yet gets one at once, even while Claude works
  const has = !!summary
  useEffect(() => {
    if (!on || !stale || (working && has)) return
    const t = setTimeout(() => void summarize(sessionId), has ? 2500 : 600)
    return () => clearTimeout(t)
  }, [on, working, stale, has, upto, sessionId])
  if (!on || (!summary && !busy && !stale)) return null
  const items = summary?.items ?? []
  // the one in the works: the newest open item (while Claude works on something not labelled yet,
  // the newest item)
  let cur = items.map((x) => x.state).lastIndexOf("open")
  if (cur < 0 && working && items.length) cur = items.length - 1
  const note = summary ? KIND_NOTE[summary.kind] : undefined
  return (
    <Section sessionId={sessionId} id="summary" title="In this chat" summary={cur >= 0 ? items[cur].text : note}>
      {!summary && (
        <div className="flex min-h-8 items-center gap-2.5 px-2 text-[13px] text-cc-fg3" aria-busy>
          <span className="h-2.5 w-40 rounded-full bg-cc-wash-2" /> <span className="sr-only">Summarizing</span>
        </div>
      )}
      <ul aria-label={summary ? (summary.kind === "features" ? "Features" : summary.kind === "question" ? "Question" : "Tasks") : undefined} className="flex flex-col">
        {items.map((x, i) => (
          <li key={i} className="flex min-h-8 min-w-0 items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm leading-5">
            <span className="grid size-5 shrink-0 place-items-center pt-px">
              {i === cur ? (
                <StatusGlyph status={status} outcome={outcome} size="sm" />
              ) : x.state === "done" ? (
                <StatusGlyph status="idle" outcome={DONE} size="sm" />
              ) : (
                <StatusGlyph status="stopped" size="sm" title={x.state === "dropped" ? "Dropped" : "Not finished"} />
              )}
            </span>
            <span className={cn("min-w-0 flex-1", i === cur ? "text-cc-fg" : "text-cc-fg2", x.state === "dropped" && "line-through decoration-cc-fg3")}>{x.text}</span>
            {note && i === items.length - 1 && <span className="shrink-0 pt-px text-[13px] text-cc-fg3">{note}</span>}
          </li>
        ))}
      </ul>
      {summary && busy && <span className="px-2 pb-1 text-xs text-cc-fg3">Updating…</span>}
    </Section>
  )
})

// ---------------------------------------------------------------- Environment

const Environment = memo(function Environment({ sessionId }: { sessionId: ID }) {
  const cwd = useApp((st) => st.sessions[sessionId]?.cwd ?? "")
  const machine = useApp((st) => st.sessions[sessionId]?.machine)
  const control = useApp((st) => st.sessions[sessionId]?.control)
  const branch = useBranch(sessionId)
  // a session in a worktree of its repo (not the main checkout): its path
  const worktree = useApp((st) => {
    const s = st.sessions[sessionId]
    const w = s?.repoId ? st.repos[s.repoId]?.worktrees.find((x) => x.id === s.worktreeId) : undefined
    return w && !w.isMain ? w.path : ""
  })
  const where =
    machine === "cloud"
      ? { icon: <Cloud />, text: "Cloud" }
      : machine
        ? { icon: <Server />, text: `SSH · ${machine}` }
        : { icon: <Monitor />, text: "Local", meta: control === "observed" ? "In your terminal" : undefined }
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined)
  return (
    <Section sessionId={sessionId} id="environment" title="Environment" summary={base(cwd) || branch}>
      <Row icon={where.icon} meta={where.meta} title={where.meta ? "This computer, in a terminal of yours" : undefined}>
        {where.text}
      </Row>
      <div className="group/row flex min-h-8 min-w-0 items-center gap-2.5 rounded-lg px-2 text-sm leading-5" title={`Working folder\n${cwd}`}>
        <span className="grid size-5 shrink-0 place-items-center text-cc-fg2 [&_svg]:size-4" aria-hidden>
          <Folder />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 truncate text-cc-fg">{base(cwd)}</span>
          <span className="min-w-0 shrink truncate text-cc-fg2">{parent(cwd)}</span>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`${base(cwd)} options`}
            className={cn(XS_GHOST, "w-6 justify-center px-0 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100")}
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => copy(cwd)}>Copy path</DropdownMenuItem>
            {branch && <DropdownMenuItem onSelect={() => copy(branch)}>Copy branch name</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {branch && (
        <Row
          icon={<GitBranch />}
          title="Branch"
          meta={
            worktree ? (
              <span className="text-cc-fg2" title={worktree}>
                Worktree
              </span>
            ) : undefined
          }
        >
          <span className="font-mono text-[13px]">{branch}</span>
        </Row>
      )}
      <AccountRow sessionId={sessionId} />
    </Section>
  )
})

/**
 * The account the session last ran on (shown with another account set up), by e-mail. When the
 * active account is another one: the session continues there with your next message.
 */
function AccountRow({ sessionId }: { sessionId: ID }) {
  const ran = useApp((st) => st.sessions[sessionId]?.accountId)
  const local = useApp((st) => !st.sessions[sessionId]?.machine && st.sessions[sessionId]?.control !== "observed")
  const name = useApp((st) => (ran === undefined ? undefined : accountName(st, ran)))
  const next = useApp((st) => activeAccountOf(st))
  const nextName = useApp((st) => accountName(st, activeAccountOf(st)))
  const has = useHasAccounts()
  if (!has || !local) return null
  const moves = ran !== undefined && ran !== next
  return (
    <Row icon={<UserRound />} meta="Account" title={moves ? `Ran on ${name}. Your next message runs it on ${nextName}, the active account (same session, same history).` : "The Claude account this session runs on"}>
      {name ?? nextName}
      {moves && <span className="block truncate text-xs text-st-input-fg">Runs on {nextName} with your next message</span>}
    </Row>
  )
}

// ---------------------------------------------------------------- Context

// categorical chart colours, light / one step lighter in dark (desktop's meter series order)
const SERIES = [
  "bg-[#257de0] dark:bg-[#4a95ea]",
  "bg-[#f47230] dark:bg-[#f68a52]",
  "bg-[#00b894] dark:bg-[#2fcaa8]",
  "bg-[#f2a600] dark:bg-[#f6b92e]",
  "bg-[#ee7fac] dark:bg-[#f298bd]",
  "bg-[#008a17] dark:bg-[#2aa53a]",
]
/** the chart's reference tint: mid grey at 15 % */
const REF = "bg-[rgb(128_128_128/0.15)]"
const seriesOf = (i: number | null) => (i === null ? "bg-[rgb(128_128_128/0.45)]" : SERIES[i])

/** The collapsed header's pill: 24 × 10, the fill at least 6 px, in the severity colour. */
function MiniMeter({ pct }: { pct: number }) {
  return (
    <span className="inline-flex h-2.5 w-6 shrink-0 rounded-full bg-cc-wash-2 p-[2px]" aria-hidden>
      <span className="h-full min-w-1.5 rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: severity(pct) }} />
    </span>
  )
}

const Context = memo(function Context({ sessionId }: { sessionId: ID }) {
  const c = useApp((st) => st.sessions[sessionId]?.usage.context)
  const contextPct = useApp((st) => st.sessions[sessionId]?.usage.contextPct ?? 0)
  const control = useApp((st) => st.sessions[sessionId]?.control)
  const machine = useApp((st) => st.sessions[sessionId]?.machine)
  const working = useApp((st) => st.sessions[sessionId]?.status === "working" || st.sessions[sessionId]?.status === "starting")
  // the newest call's size stands in where no breakdown can be had (a session in your terminal)
  const lastTokens = useApp((st) => st.transcripts[sessionId]?.lastCall?.tokens ?? 0)
  const owned = control === "owned"
  // a session the app runs answers how full its context is: ask when shown and after each turn
  useEffect(() => {
    if (REAL && owned && !working) void import("@/backend/real").then((r) => r.realAskContext(sessionId))
  }, [sessionId, owned, working])
  const caps = capabilities(control ?? "history")

  const win = c?.max || (lastTokens > 200_000 ? 1_000_000 : 200_000)
  const used = c?.used ?? (lastTokens || Math.round((contextPct / 100) * win))
  const known = !!c || lastTokens > 0 || contextPct > 0
  const pct = c ? Math.round((c.used / Math.max(1, c.max)) * 100) : contextPct || Math.round((used / win) * 100)
  const over = !!c && c.used > c.max
  const summary = known ? (
    <>
      <span className="truncate">{over ? k(used) : `${k(used)} / ${k(win)}`}</span>
      <MiniMeter pct={pct} />
    </>
  ) : undefined

  return (
    <Section sessionId={sessionId} id="context" title="Context" summary={summary}>
      {!known ? (
        <p className="px-1.5 py-1 text-[13px] leading-[17px] text-cc-fg2">Send a message to see context usage.</p>
      ) : (
        <ContextBody sessionId={sessionId} pct={pct} used={used} win={win} over={over} canCompact={caps.changeSettings && machine !== "cloud"} working={working} freshOk={machine !== "cloud"} owned={owned} />
      )}
    </Section>
  )
})

function ContextBody({ sessionId, pct, used, win, over, canCompact, working, freshOk, owned }: { sessionId: ID; pct: number; used: number; win: number; over: boolean; canCompact: boolean; working: boolean; freshOk: boolean; owned: boolean }) {
  const c = useApp((st) => st.sessions[sessionId]?.usage.context)
  const b = c ? breakdown(c) : null
  const max = c?.max ?? win
  const share = (t: number) => (max > 0 ? `${((t / max) * 100).toFixed(1)}%` : "—")
  const left = b ? b.untilCompact : Math.max(0, win - 33_000 - used)
  const hint = compactHint(left)
  const meterLabel = b ? b.segments.map((x) => `${x.name}: ${k(x.tokens)}, ${Number(((x.tokens / max) * 100).toPrecision(2))}%`).join("; ") : `${pct}% used`
  return (
    <div className="flex flex-col px-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm leading-5">
        <span className="tabular text-cc-fg">{over ? k(used) : `${pct}% used`}</span>
        {!over && <span className="tabular text-[13px] text-cc-fg2">{`${k(used)} / ${k(max)}`}</span>}
      </div>
      <Tip
        side="left"
        label={
          b ? (
            <span className="flex flex-col">
              {b.segments.map((x) => (
                <span key={x.name}>{`${x.name}: ${k(x.tokens)}, ${Number(((x.tokens / max) * 100).toPrecision(2))}%`}</span>
              ))}
            </span>
          ) : (
            `${pct}% used`
          )
        }
      >
        <div tabIndex={0} role="img" aria-label={`Context window: ${meterLabel}`} className={cn("mt-1 mb-1.5 rounded-full py-1", FOCUS)}>
          <div className={cn("flex h-1 w-full gap-[2px] overflow-hidden rounded-full", REF)}>
            {b ? (
              b.segments.map((x) => <span key={x.name} className={cn("h-full shrink-0", seriesOf(x.series))} style={{ width: `${(x.tokens / max) * 100}%` }} />)
            ) : (
              <span className="h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: severity(pct) }} />
            )}
          </div>
        </div>
      </Tip>
      {b ? (
        <ul className="flex flex-col text-[13px] leading-[17px]">
          {b.used.map((x) => (
            <Legend key={x.name} swatch={<span className={cn("size-2.5 rounded-[3px]", seriesOf(x.series))} />} name={x.name} tokens={k(x.tokens)} pct={share(x.tokens)} />
          ))}
          {b.buffer && b.buffer.tokens > 0 && <Legend swatch={<span className={cn("size-2.5 rounded-[2px]", REF)} />} name={b.buffer.name} tokens={k(b.buffer.tokens)} pct={share(b.buffer.tokens)} />}
          {b.free && <Legend swatch={<span className={cn("size-2.5 rounded-[2px]", REF)} />} name={b.free.name} tokens={k(Math.max(0, b.free.tokens))} pct={share(Math.max(0, b.free.tokens))} />}
          {b.deferred.map((x) => (
            <Legend key={x.name} muted swatch={<span className="size-2.5 rounded-[2px] bg-[#c2c2c2] dark:bg-[#5e5e5e]" />} name={x.name} tokens={k(x.tokens)} pct="—" />
          ))}
        </ul>
      ) : owned ? (
        <p className="py-1 text-[13px] leading-[17px] text-cc-fg2">Loading context breakdown…</p>
      ) : null}
      {(hint || canCompact || freshOk) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5 py-1 text-[13px] leading-[17px]">
          {hint && <span className="min-w-28 flex-1 truncate text-cc-fg2">{hint}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {freshOk && <StartFreshButton sessionId={sessionId} className={XS} />}
            {canCompact && pct >= 50 && (
              <Tip label={working ? "Available when Claude finishes this turn" : (hint ?? "Summarise the conversation so far")} side="top">
                <button type="button" aria-disabled={working || undefined} onClick={() => !working && sendMessage(sessionId, "/compact", "now")} className={XS}>
                  Compact session
                </button>
              </Tip>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

function Legend({ swatch, name, tokens, pct, muted }: { swatch: ReactNode; name: string; tokens: string; pct: string; muted?: boolean }) {
  return (
    <li className="flex min-h-5 items-center gap-2">
      <span className="grid w-3 shrink-0 place-items-center" aria-hidden>
        {swatch}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", muted ? "text-cc-fg3" : "text-cc-fg2")} title={name}>
        {name}
      </span>
      <span className="tabular text-cc-fg2">{tokens}</span>
      <span className={cn("tabular w-11 shrink-0 text-right", pct === "—" ? "text-cc-fg3" : "text-cc-fg")}>{pct}</span>
    </li>
  )
}

// ---------------------------------------------------------------- Changes

interface Pr {
  number: number
  url: string
  title: string
  state: string
  isDraft?: boolean
  reviewDecision?: string
  mergeable?: string
  statusCheckRollup?: { name?: string; conclusion?: string; state?: string; status?: string; detailsUrl?: string; workflowName?: string }[]
}

const FAILED = /FAIL|ERROR|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE/

function ciCounts(pr: Pr) {
  const n = { failed: 0, pending: 0, passed: 0, skipped: 0, cancelled: 0 }
  for (const c of pr.statusCheckRollup ?? []) {
    const r = (c.conclusion || c.state || c.status || "").toUpperCase()
    if (/SUCCESS/.test(r)) n.passed++
    else if (/SKIPPED|NEUTRAL/.test(r)) n.skipped++
    else if (/CANCEL/.test(r)) n.cancelled++
    else if (FAILED.test(r)) n.failed++
    else n.pending++
  }
  return n
}
type Ci = ReturnType<typeof ciCounts>

// PR state colours, light / dark (desktop's git palette)
const PR_TONE = {
  open: "text-cc-add",
  draft: "text-[#737373] dark:text-[#a6a6a6]",
  merged: "text-[#8e6bd9] dark:text-[#b796ff]",
  closed: "text-[#ff3a30] dark:text-[#ff6159]",
  conflict: "text-[#c5621b] dark:text-[#fa832e]",
  approved: "text-cc-add",
  changes: "text-[#ff3a30] dark:text-[#ff6159]",
}

/** The PR's state as desktop's PR glyph and badge word, first match wins. */
function prState(pr: Pr): { icon: ReactNode; word: string; tone: string } {
  if (pr.state === "MERGED") return { icon: <GitMerge />, word: "Merged", tone: PR_TONE.merged }
  if (pr.state === "CLOSED") return { icon: <GitPullRequestClosed />, word: "Closed", tone: PR_TONE.closed }
  if (pr.isDraft) return { icon: <GitPullRequestDraft />, word: "Draft", tone: PR_TONE.draft }
  if (pr.mergeable === "CONFLICTING") return { icon: <GitPullRequest />, word: "Merge conflicts", tone: PR_TONE.conflict }
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { icon: <CircleX />, word: "Changes requested", tone: PR_TONE.changes }
  if (pr.reviewDecision === "APPROVED") return { icon: <CircleCheck />, word: "Approved", tone: PR_TONE.approved }
  if (pr.reviewDecision === "REVIEW_REQUIRED") return { icon: <GitPullRequest />, word: "Waiting for review", tone: PR_TONE.open }
  return { icon: <GitPullRequest />, word: "Open", tone: PR_TONE.open }
}

function usePr(sessionId: ID, cwd: string, machine?: string) {
  const [pr, setPr] = useState<Pr | null | undefined>(undefined)
  const live = IN_TAURI && REAL
  useEffect(() => {
    if (!live || machine) return
    let alive = true
    const load = () => {
      if (document.hidden) return
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke<Pr | null>("pr_status", { cwd }))
        .then((p) => alive && setPr(p))
        .catch(() => alive && setPr(null))
    }
    load()
    const t = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [cwd, machine, live])
  // the browser preview: the worktree's PR as the mock world knows it
  const preview = useApp((st) => {
    if (live) return undefined
    const s = st.sessions[sessionId]
    const repo = s?.repoId ? st.repos[s.repoId] : undefined
    return repo?.worktrees.find((w) => w.id === s?.worktreeId)?.git.pr ?? null
  })
  const title = useApp((st) => (live ? "" : (st.sessions[sessionId]?.title ?? "")))
  const slug = useApp((st) => {
    const s = st.sessions[sessionId]
    const repo = s?.repoId ? st.repos[s.repoId] : undefined
    return repo ? (repo.slug ?? `acme/${repo.name}`) : ""
  })
  if (live) return pr
  if (!preview) return null
  const rollup = (ok: number, other: string, n: number) => [...Array.from({ length: ok }, () => ({ conclusion: "SUCCESS" })), ...Array.from({ length: n }, () => ({ status: other, conclusion: other === "FAILURE" ? "FAILURE" : "" }))]
  return {
    number: preview.number,
    url: `https://github.com/${slug}/pull/${preview.number}`,
    title,
    state: preview.state === "merged" ? "MERGED" : preview.state === "closed" ? "CLOSED" : "OPEN",
    isDraft: preview.state === "draft",
    reviewDecision: preview.state === "open" ? (preview.checks === "passing" ? "APPROVED" : "REVIEW_REQUIRED") : undefined,
    statusCheckRollup: preview.checks === "passing" ? rollup(6, "", 0) : preview.checks === "failing" ? rollup(5, "FAILURE", 1) : preview.checks === "pending" ? rollup(4, "IN_PROGRESS", 2) : [],
  } satisfies Pr
}

const Changes = memo(function Changes({ sessionId }: { sessionId: ID }) {
  const cwd = useApp((st) => st.sessions[sessionId]?.cwd ?? "")
  const machine = useApp((st) => st.sessions[sessionId]?.machine)
  const diffFiles = useApp((st) => st.sessions[sessionId]?.diff.filesChanged ?? 0)
  const diffAdded = useApp((st) => st.sessions[sessionId]?.diff.linesAdded ?? 0)
  const diffRemoved = useApp((st) => st.sessions[sessionId]?.diff.linesRemoved ?? 0)
  const files = useChangedFiles(sessionId)
  const overlaps = useOverlaps(sessionId)
  const pr = usePr(sessionId, cwd, machine)
  const n = files.length || diffFiles
  // nothing to show: the section leaves no gap (desktop has no "no changes" state)
  if (!pr && !n && !overlaps.length) return null
  const added = files.length ? files.reduce((a, f) => a + f.added, 0) : diffAdded
  const removed = files.length ? files.reduce((a, f) => a + f.removed, 0) : diffRemoved
  return (
    <Section sessionId={sessionId} id="changes" title="Changes" summary={pr ? "1 pull request" : undefined}>
      <nav aria-label="Repository and pull request controls" className="flex flex-col gap-1">
        {pr ? <PrRow sessionId={sessionId} pr={pr} added={added} removed={removed} n={n} /> : n > 0 && <BranchRow sessionId={sessionId} added={added} removed={removed} n={n} canCreate={pr === null} />}
        {overlaps.map((o) => (
          <OverlapRow key={o.other} other={o.other} sameFolder={o.sameFolder} files={o.files} />
        ))}
      </nav>
    </Section>
  )
})

/** "+12 −3": opens the review of this session's changes. */
function DiffCounter({ sessionId, added, removed }: { sessionId: ID; added: number; removed: number }) {
  return (
    <Tip label="Open changes" side="top">
      <button type="button" aria-label={`Open changes, ${added} added, ${removed} removed`} onClick={() => openReview(sessionId)} className={cn(XS_GHOST, "tabular -mx-1 h-5 px-1")}>
        <span className="text-cc-add">+{added}</span>
        <span className="text-cc-del">−{removed}</span>
      </button>
    </Tip>
  )
}

/** Stacked row: 20 px glyph, then the text column (title line, meta line, verbs). */
function StackRow({ glyph, glyphLabel, children }: { glyph: ReactNode; glyphLabel?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3 rounded-lg px-2 py-1">
      <span role={glyphLabel ? "img" : undefined} aria-label={glyphLabel} aria-hidden={glyphLabel ? undefined : true} className="grid h-5 w-5 shrink-0 place-items-center [&_svg]:size-4">
        {glyph}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
    </div>
  )
}

function PrRow({ sessionId, pr, added, removed, n }: { sessionId: ID; pr: Pr; added: number; removed: number; n: number }) {
  const st = prState(pr)
  const ci = ciCounts(pr)
  return (
    <StackRow glyph={<span className={st.tone} title={st.word}>{st.icon}</span>} glyphLabel={st.word}>
      <a href={pr.url} target="_blank" rel="noreferrer" title={`${pr.title}\nOpen on GitHub`} className={cn("block h-5 min-w-0 truncate rounded-sm text-sm leading-5 text-cc-fg hover:underline focus-visible:underline", FOCUS)}>
        {pr.title || `Pull request #${pr.number}`}
      </a>
      <div className="flex min-h-4 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-4 text-cc-fg2">
        <span className="tabular shrink-0">#{pr.number}</span>
        {/* plain open PRs say it with the glyph alone; merged, approved and the rest also in words */}
        {st.word !== "Open" && st.word !== "Waiting for review" && (
          <>
            <span aria-hidden>·</span>
            <span className={cn("shrink-0", st.tone)}>{st.word}</span>
          </>
        )}
        {n > 0 && <DiffCounter sessionId={sessionId} added={added} removed={removed} />}
        {/* a merged or closed PR's checks no longer ask anything of you */}
        {pr.state === "OPEN" && <CiChip pr={pr} ci={ci} />}
      </div>
      {ci.failed > 0 && pr.state === "OPEN" && <SendFailures sessionId={sessionId} pr={pr} />}
    </StackRow>
  )
}

/** Without a PR: the branch, what it merges into, the diff, and Create PR. */
function BranchRow({ sessionId, added, removed, n, canCreate }: { sessionId: ID; added: number; removed: number; n: number; canCreate: boolean }) {
  const branch = useBranch(sessionId)
  const into = useApp((st) => {
    const s = st.sessions[sessionId]
    return s?.repoId ? (st.repos[s.repoId]?.defaultBranch ?? "") : ""
  })
  const working = useApp((st) => st.sessions[sessionId]?.status === "working" || st.sessions[sessionId]?.status === "starting")
  const local = useApp((st) => !st.sessions[sessionId]?.machine)
  // long branch names keep their last 10 characters
  const shown = branch.length >= 16 ? `${branch.slice(0, 5)}…${branch.slice(-10)}` : branch
  return (
    <StackRow glyph={<span className="text-cc-fg2">{branch ? <GitBranch /> : <FileDiff />}</span>}>
      <span className={cn("block h-5 min-w-0 truncate leading-5 text-cc-fg", branch ? "font-mono text-[13px]" : "text-sm")} title={branch || undefined}>
        {branch ? shown : plural(n, "file") + " changed"}
      </span>
      <div className="flex min-h-4 min-w-0 items-center gap-1.5 text-[13px] leading-4 text-cc-fg2">
        {branch && into && branch !== into && <span className="min-w-0 truncate">into {into}</span>}
        <DiffCounter sessionId={sessionId} added={added} removed={removed} />
        <span className="shrink-0">{plural(n, "file")}</span>
      </div>
      {canCreate && local && branch && branch !== into && (
        <div className="flex gap-3 pt-1">
          <Tip label={working ? "Claude is working — wait for the turn to finish" : "Runs gh pr create --fill in the terminal"} side="top">
            <button
              type="button"
              aria-disabled={working || undefined}
              onClick={() => !working && void import("@/features/terminal/terminals").then((t) => t.runInTerminal("gh pr create --fill"))}
              className={XS}
            >
              Create PR
            </button>
          </Tip>
        </div>
      )}
    </StackRow>
  )
}

/** Another live session editing the same files (ours): who, how it collides, which files. */
function OverlapRow({ other, sameFolder, files }: { other: ID; sameFolder: boolean; files: string[] }) {
  const title = useApp((st) => st.sessions[other]?.title ?? "Another session")
  return (
    <StackRow glyph={<span className="text-cc-warn">{<GitMerge />}</span>}>
      <button type="button" onClick={() => openSession(other)} className={cn("block h-5 min-w-0 truncate rounded-sm text-left text-sm leading-5 text-cc-fg hover:underline", FOCUS)}>
        Same files as {title}
      </button>
      <span className="text-[13px] leading-4 text-cc-fg2" title={files.join("\n")}>
        {sameFolder ? "Same folder: edits can overwrite each other" : "Another worktree: expect a merge conflict"} · {files.slice(0, 2).map(base).join(", ")}
        {files.length > 2 && ` +${files.length - 2}`}
      </span>
    </StackRow>
  )
}

/** CI as desktop's chip: "2 failing" in red, "4/6" while running, a check when all passed; counts on click. */
function CiChip({ pr, ci }: { pr: Pr; ci: Ci }) {
  const total = ci.failed + ci.pending + ci.passed + ci.skipped + ci.cancelled
  if (!total) return null
  const done = total - ci.pending
  const status = ci.failed ? "failed" : ci.pending ? "pending" : ci.passed ? "passed" : "skipped"
  const detail =
    status === "failed"
      ? `CI: ${plural(ci.failed, "check")} failing`
      : status === "pending"
        ? "CI: checks in progress"
        : status === "passed"
          ? "CI: all checks passed"
          : ci.cancelled && !ci.skipped
            ? `CI: ${plural(ci.cancelled, "check")} cancelled`
            : "CI: all checks skipped"
  const rows: [string, number, ReactNode][] = [
    ["Failed", ci.failed, <CircleX className="text-cc-danger" />],
    ["In progress", ci.pending, <CircleDashed className="text-cc-fg2" />],
    ["Passed", ci.passed, <CircleCheck className="text-cc-add" />],
    ["Skipped", ci.skipped, <CircleMinus className="text-cc-fg2" />],
    ["Cancelled", ci.cancelled, <CircleMinus className="text-cc-fg2" />],
  ]
  return (
    <Popover>
      <Tip
        side="top"
        label={
          <span className="flex flex-col">
            <span className="font-medium">CI monitoring</span>
            <span>{detail}</span>
          </span>
        }
      >
        <PopoverTrigger aria-label={detail} className={cn(XS_GHOST, "tabular -mr-1.5 ml-auto", status === "failed" && "text-cc-danger hover:text-cc-danger")}>
          {status === "failed" ? (
            `${ci.failed} failing`
          ) : status === "pending" ? (
            <>
              <span className="animate-spin-steps"><LoaderCircle className="size-3.5" /></span>
              {done}/{total}
            </>
          ) : status === "passed" ? (
            <CircleCheck className="size-3.5 text-cc-add" />
          ) : (
            <CircleMinus className="size-3.5" />
          )}
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" sideOffset={8} className="w-auto min-w-[220px] gap-0 px-2 py-1 text-sm">
        <div className="flex min-h-5 items-center justify-between gap-3 px-2 py-[3px]">
          <span className="text-[13px] text-cc-fg2">CI monitoring</span>
          <a href={`${pr.url}/checks`} target="_blank" rel="noreferrer" aria-label="Open checks on GitHub" title="Open checks on GitHub" className={cn(XS_GHOST, "size-6 justify-center px-0")}>
            <ExternalLink className="size-3.5" />
          </a>
        </div>
        {rows
          .filter(([, count]) => count > 0)
          .map(([label, count, icon]) => (
            <div key={label} className="flex h-7 items-center gap-2 px-2">
              <span className="grid w-3.5 place-items-center [&_svg]:size-3.5">{icon}</span>
              <span className="flex-1 text-cc-fg">{label}</span>
              <span className="tabular text-cc-fg2">{count}</span>
            </div>
          ))}
      </PopoverContent>
    </Popover>
  )
}

/**
 * A red check, handed to the session: the failing lines of its GitHub Actions runs as a message, so
 * the fix starts from the actual error instead of a copy-paste round trip.
 */
function SendFailures({ sessionId, pr }: { sessionId: ID; pr: Pr }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | string>("idle")
  const cwd = useApp((st) => st.sessions[sessionId]?.cwd ?? "")
  const canSend = useApp((st) => capabilities(st.sessions[sessionId]?.control ?? "history").send)
  const failing = (pr.statusCheckRollup ?? []).filter((c) => FAILED.test((c.conclusion || c.state || c.status || "").toUpperCase()))
  const runs = [...new Set(failing.map((c) => /\/actions\/runs\/(\d+)/.exec(c.detailsUrl ?? "")?.[1]).filter((x): x is string => !!x).map(Number))]
  if (!runs.length || !canSend || !(IN_TAURI && REAL)) return null
  const send = async () => {
    setState("busy")
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const log = await invoke<string>("ci_failure_log", { cwd, runs })
      const names = failing.map((c) => c.name || c.workflowName).filter(Boolean).slice(0, 5).join(", ")
      sendMessage(sessionId, `CI is failing on PR #${pr.number}${names ? ` (${names})` : ""}. The failing log lines:\n\n\`\`\`\n${log.trim()}\n\`\`\`\n\nFind the cause and fix it. Run the failing check locally first if you can.`, "queue")
      setState("sent")
    } catch (e) {
      setState(String(e).slice(0, 160))
    }
  }
  return (
    <div className="flex min-w-0 items-center gap-2 pt-1">
      <button type="button" disabled={state === "busy" || state === "sent"} onClick={() => void send()} title="Read the failing lines with gh and send them to this session" className={cn(XS, "disabled:opacity-50")}>
        {state === "busy" ? "Reading the log…" : state === "sent" ? "Sent to Claude" : "Send failures to Claude"}
      </button>
      {state !== "idle" && state !== "busy" && state !== "sent" && (
        <span className="min-w-0 truncate text-[13px] text-cc-danger" title={state}>
          {state}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Checks (ours: the last local test/lint run)

/** The command as you would type it: without the `cd <folder> &&` Claude puts in front. */
export function shownCommand(cmd: string) {
  let c = cmd.trim()
  for (let i = 0; i < 4; i++) {
    const m = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/.exec(c)
    if (!m) break
    c = c.slice(m[0].length)
  }
  return c.split("\n")[0] || cmd.split("\n")[0]
}

const Checks = memo(function Checks({ sessionId }: { sessionId: ID }) {
  const v = useVerification(sessionId)
  if (!v || v.state === "none") return null
  const line =
    v.state === "unchecked"
      ? { icon: <CircleAlert />, text: `${plural(v.edits, "edit")}, no tests or checks run yet`, summary: "Not run" }
      : v.state === "stale"
        ? { icon: <CircleAlert />, text: `${plural(v.edits, "edit")} since the last check${v.passed ? "" : ", which failed"}`, summary: "Out of date" }
        : v.state === "running"
          ? { icon: <span className="animate-spin-steps"><LoaderCircle /></span>, text: "Checking now", summary: "Running" }
          : v.state === "passed"
            ? { icon: <CircleCheck className="text-cc-add" />, text: "Passed after the last edit", summary: "Passed" }
            : { icon: <CircleX className="text-cc-danger" />, text: "Failed after the last edit", summary: "Failed" }
  return (
    <Section sessionId={sessionId} id="checks" title="Checks" summary={line.summary}>
      <Row icon={line.icon}>{line.text}</Row>
      {"command" in v && (
        <div className="flex min-h-6 min-w-0 items-baseline gap-2 pr-2 pb-1 pl-[38px] text-[13px] leading-[17px] text-cc-fg2">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={v.command}>
            {shownCommand(v.command)}
          </code>
          <RelativeTime iso={v.at} className="tabular shrink-0" />
        </div>
      )}
    </Section>
  )
})

// ---------------------------------------------------------------- Servers (dev servers the session listens on)

const NO_PORTS: number[] = []

const Servers = memo(function Servers({ sessionId }: { sessionId: ID }) {
  const ports = usePorts((st) => st[sessionId] ?? NO_PORTS)
  const [more, setMore] = useState(false)
  if (!ports.length) return null
  const shown = more ? ports : ports.slice(0, 4)
  return (
    <Section sessionId={sessionId} id="servers" title="Servers" summary={`${ports.length} running`}>
      {shown.map((p) => (
        <button key={p} type="button" aria-label={`Open localhost:${p} in the browser`} onClick={() => openPort(p)} className={cn("w-full text-left", ROW_BUTTON, "rounded-lg")}>
          <Row icon={<ServerCog />}>localhost:{p}</Row>
        </button>
      ))}
      {ports.length > 4 && (
        <button type="button" onClick={() => setMore(!more)} className={cn("flex min-h-8 items-center rounded-lg px-2 text-left text-sm text-cc-fg2 hover:text-cc-fg", FOCUS)}>
          {more ? "Show less" : "Show more"}
        </button>
      )}
    </Section>
  )
})

// ---------------------------------------------------------------- Background tasks (only a count is known)

const BackgroundTasks = memo(function BackgroundTasks({ sessionId }: { sessionId: ID }) {
  const n = useApp((st) => st.sessions[sessionId]?.backgroundTasks ?? 0)
  if (!n) return null
  return (
    <Section sessionId={sessionId} id="tasks" title="Background tasks" summary={`${n} running`}>
      <Row icon={<Users />}>{plural(n, "running task")}</Row>
    </Section>
  )
})
