// Context ring at the right end of the row under the prompt box (Claude Code desktop): blue, amber
// from 75 %, red from 90 %. On click: the context window, what is left until auto-compact and
// Compact session, then the plan's usage limits (5-hour, weekly) and, one muted line, what this
// session cost at API prices (desktop keeps limits here, not in the session rail).
// Beside it, once the prompt cache has expired on a large conversation, "Cold cache": the next message
// pays to write the whole conversation to the cache again.
import { useMemo } from "react"
import { ArrowRight } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useApp } from "@/store/app"
import { sendMessage } from "@/store/actions"
import { navigate } from "@/app/nav"
import { compact, usd } from "@/lib/format"
import type { ID } from "@/lib/model"
import { cn } from "@/lib/utils"
import { familyOf, limitsFor, recentBySession, useUsage, type Limit } from "@/features/usage/usageData"
import { accountKey, accountLabel } from "@/lib/accounts"
import { limitLine, useAccountChoices, useHasAccounts } from "@/features/accounts/AccountItems"
import { compactHint, severity } from "@/features/session-view/details/contextMath"
import { minutes, useCache } from "./cache"
import { GHOST, PANEL } from "./Pickers"

const WINDOW_TOKENS = 200_000
// claude compacts this far before the window ends (room for the reply and its buffer)
const COMPACT_MARGIN = 33_000

const kTokens = (n: number) => {
  const t = (x: number) => x.toFixed(1).replace(/\.0$/, "")
  return n >= 1e6 ? `${t(n / 1e6)}M` : n >= 1e5 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${t(n / 1e3)}k` : String(n)
}

/** The limit windows that apply here: the 5-hour one, weekly for all models, and weekly for this model's family. */
function limitRows(limits: Limit[] | undefined, model: string | undefined) {
  if (!limits) return []
  const fam = model ? familyOf(model) : ""
  const rows: { label: string; short: string; l: Limit }[] = []
  for (const l of limits) {
    if (l.group === "session" || l.kind === "session" || l.kind === "five_hour") rows.push({ label: "5-hour limit", short: "5-hour limit", l })
    else if (l.kind === "weekly_all") rows.push({ label: "Weekly", short: "Weekly", l })
    else if (l.kind === "weekly_scoped") {
      const name = l.scope?.model?.display_name
      // model-scoped windows for other families are left out
      if (name && fam && name.toLowerCase() === fam.toLowerCase()) rows.push({ label: `Weekly · ${name}`, short: `Weekly · ${name}`, l })
    }
  }
  return rows
}

/** A reached limit shows 100, anything short of it at most 99. */
const shownPct = (p: number) => (p >= 100 ? 100 : Math.min(99, Math.max(0, Math.round(p))))

function resetCaption(iso: string | null | undefined) {
  if (!iso) return "Starts with your first message"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  if (d.toDateString() === now.toDateString()) return `Resets at ${time}`
  return `Resets ${d.toLocaleDateString([], { weekday: "short" })} ${time}`
}

const PLAN: Record<string, string> = { free: "Free", pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" }

export function ContextRing({ sessionId, canCompact }: { sessionId: ID; canCompact: boolean }) {
  const usage = useApp((s) => s.sessions[sessionId]?.usage)
  const model = useApp((s) => s.sessions[sessionId]?.model)
  const working = useApp((s) => s.sessions[sessionId]?.status === "working" || s.sessions[sessionId]?.status === "starting")
  const configDir = useApp((s) => s.sessions[sessionId]?.configDir)
  // the plan of the account this session runs on (null: not asked yet)
  const limits = useUsage((s) => limitsFor(s, configDir) ?? (s.limits === null ? null : undefined))
  const hasAccounts = useHasAccounts()
  const others = useAccountChoices([accountKey(configDir)]).filter((a) => a.limits)
  const cache = useCache(sessionId)
  const rows = useMemo(() => limitRows(limits?.limits, model), [limits, model])
  if (!usage) return null
  // a session in your terminal has no context report: its newest call's size stands in
  const ctx = usage.context
  const win = ctx?.max || (cache && cache.tokens > WINDOW_TOKENS ? 1_000_000 : WINDOW_TOKENS)
  const pct = Math.max(0, Math.min(100, ctx ? Math.round((ctx.used / Math.max(1, ctx.max)) * 100) : usage.contextPct || (cache ? Math.round((cache.tokens / win) * 100) : 0)))
  const used = ctx?.used ?? Math.round((pct / 100) * win)
  const cold = !!cache && !cache.warm && !!cache.cost && cache.cost.cold >= 0.25
  const color = severity(pct)
  const buffer = ctx?.categories.find((c) => c.kind === "buffer" || /compact buffer/i.test(c.name))
  const left = ctx ? (buffer ? Math.max(0, ctx.max - buffer.tokens - ctx.used) : null) : Math.max(0, win - COMPACT_MARGIN - used)
  const hint = compactHint(left)
  const r = 6
  const c = 2 * Math.PI * r
  const parts = [`Context ${pct}%`, ...rows.map((x) => (x.l.group === "session" || x.l.kind === "session" ? `${shownPct(x.l.percent)}% of 5-hour limit` : `${x.short}: ${shownPct(x.l.percent)}%`))]
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Context ${pct}% used${rows.length ? `, ${parts.slice(1).join(", ")}` : ""}${cold ? ", prompt cache expired" : ""}`}
          title={parts.join(" · ")}
          className={cn(GHOST, cold ? "px-1.5 text-[13px]" : "w-7")}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
            <circle cx="8" cy="8" r={r} fill="none" stroke="var(--cc-wash-3)" strokeWidth="2" />
            <circle
              cx="8"
              cy="8"
              r={r}
              fill="none"
              stroke={color}
              strokeWidth="2"
              strokeDasharray={`${(pct / 100) * c} ${c}`}
              strokeLinecap="round"
            />
          </svg>
          {cold && <span>Cold cache</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} aria-label="Usage" className={cn(PANEL, "max-h-[min(640px,var(--radix-popover-content-available-height))] w-[min(360px,calc(100vw-32px))] overflow-y-auto px-0 py-2 text-[13px] leading-[17px]")}>
        {/* context window */}
        <div className="flex flex-col gap-1 px-4 py-1">
          <div className="flex min-h-5 items-baseline justify-between gap-3">
            <span className="text-cc-fg2">Context window</span>
            <span className="tabular text-cc-fg2">
              {kTokens(used)} / {kTokens(win)} ({pct}%)
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-[rgb(128_128_128/0.15)]">
            <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
          </div>
          {(hint || (canCompact && pct >= 50)) && (
            <div className="mt-1 flex min-h-6 items-center gap-2">
              {hint && <span className="tabular min-w-0 flex-1 truncate text-cc-fg2">{hint}</span>}
              {canCompact && pct >= 50 && (
                <button
                  type="button"
                  aria-disabled={working || undefined}
                  title={working ? "Available when Claude finishes this turn" : (hint ?? undefined)}
                  onClick={() => !working && sendMessage(sessionId, "/compact", "now")}
                  className={cn(GHOST, "ml-auto h-6 rounded-md bg-cc-secondary px-2 text-[13px] text-[var(--cc-fg)] hover:bg-cc-secondary-hover aria-disabled:opacity-50")}
                >
                  Compact session
                </button>
              )}
            </div>
          )}
          {cache?.cost && (
            <p className="mt-1 text-cc-fg3">
              {cache.warm ? (
                <>
                  Cache warm for {minutes(cache.ms)} more: the next message re-reads {compact(cache.tokens)} tokens for about {usd(cache.cost.warm)}.
                </>
              ) : (
                <>
                  Cache expired {minutes(cache.ms)} ago: the next message writes {compact(cache.tokens)} tokens again, about {usd(cache.cost.cold)} instead of {usd(cache.cost.warm)}{" "}
                  warm. It counts against your plan the same way.
                </>
              )}
            </p>
          )}
          {cache && cache.tokens >= 200_000 && (
            <p className="text-cc-fg3">Every message re-reads all {compact(cache.tokens)} tokens. A fresh session with a short brief (Start fresh, in the session details) is cheaper and often more focused.</p>
          )}
        </div>
        {/* plan usage limits */}
        {limits === null ? (
          <>
            <Divider />
            <div className="flex flex-col gap-1.5 px-4 pt-1 pb-1" aria-label="Loading usage limits" aria-busy>
              <div className="flex justify-between">
                <span className="h-2.5 w-24 rounded-full bg-cc-wash-2" />
                <span className="h-2.5 w-[104px] rounded-full bg-cc-wash-2" />
              </div>
              <span className="h-1 rounded-full bg-cc-wash-2" />
            </div>
          </>
        ) : rows.length > 0 ? (
          <>
            <Divider />
            <div role="group" aria-label="Usage limits" className="flex flex-col">
              <div className="flex min-h-7 items-center justify-between gap-2 pr-2 pl-4">
                <span className="min-w-0 truncate text-cc-fg2">
                  Plan usage limits{limits?.plan ? ` · ${PLAN[limits?.plan.toLowerCase()] ?? limits?.plan}` : ""}
                  {hasAccounts && <span className="font-mono text-[12px]"> · {accountLabel(configDir)}</span>}
                </span>
                <button type="button" aria-label="See all usage" onClick={() => navigate("/usage")} className={cn(GHOST, "h-6 gap-1 rounded-md px-2 text-[13px]")}>
                  See all <ArrowRight className="size-3" />
                </button>
              </div>
              <div className="flex flex-col gap-2 px-4 pb-1">
                {rows.map(({ label, l }) => (
                  <LimitRow key={label} label={label} l={l} />
                ))}
              </div>
              {hasAccounts && others.length > 0 && (
                <div role="group" aria-label="Other accounts" className="mt-1 flex flex-col gap-0.5 px-4 pb-1">
                  {others.map((a) => (
                    <div key={a.key} className="flex min-h-5 items-baseline gap-2">
                      <span className="min-w-0 truncate font-mono text-[12px] text-cc-fg2">{a.label}</span>
                      <span className="tabular ml-auto shrink-0 text-cc-fg3">{limitLine(a)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : null}
        {usage.costUsd > 0 && (
          <>
            <Divider />
            <SessionCost sessionId={sessionId} cost={usage.costUsd} />
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

const Divider = () => <div className="mx-4 my-1 h-px bg-cc-wash-2" />

function LimitRow({ label, l }: { label: string; l: Limit }) {
  const p = shownPct(l.percent)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-cc-fg">{label}</span>
        <span className="tabular ml-auto text-cc-fg2">{resetCaption(l.resets_at)}</span>
        <span className="tabular w-8 text-right text-cc-fg2">{p}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-cc-wash-2" role="img" aria-label={`${p}% used`}>
        <span className="block h-full rounded-full" style={{ width: `${p}%`, background: severity(p) }} />
      </div>
    </div>
  )
}

/** One muted line: what this session cost at API prices, and its part of the last 5 hours. */
function SessionCost({ sessionId, cost }: { sessionId: ID; cost: number }) {
  const ledger = useUsage((st) => st.ledger)
  const share = useMemo(() => (ledger ? recentBySession(ledger).rows.find((r) => r.id === sessionId)?.share : undefined), [ledger, sessionId])
  return (
    <p className="tabular px-4 py-1 text-cc-fg3">
      This session: {usd(cost)} at API prices
      {share && share >= 0.01 ? ` · ${Math.round(share * 100)}% of the last 5 hours` : ""}
    </p>
  )
}
