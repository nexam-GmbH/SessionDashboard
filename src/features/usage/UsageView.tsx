// Usage, laid out like the create-tauri-ui starter dashboard (section cards with trend badges, the
// interactive area chart, a data table): plan limits now and over time (5-hour and weekly, shared
// with claude.ai), tokens by model, value at API prices, prompts, sessions, an activity heatmap and
// a daily table like `ccusage daily`. Data: the permanent ledger (usageData.ts).
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { RefreshCw, TrendingDown, TrendingUp } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useNow } from "@/components/common/RelativeTime"
import { cn } from "@/lib/utils"
import { Meter, until } from "./Meter"
import {
  FAMILIES,
  PARTS,
  RANGES,
  compactTokens,
  dailyRows,
  dayKey,
  familyOf,
  modelName,
  perDay,
  previousRange,
  rangeStart,
  refreshUsage,
  series,
  streaks,
  totals,
  usdFmt,
  useUsage,
  type LimitSample,
  type Range,
} from "./usageData"

// the starter dashboard's monochrome chart palette (stock --chart-1…5), lightest first
const FAMILY_COLOR: Record<string, string> = { Opus: "var(--chart-1)", Sonnet: "var(--chart-2)", Haiku: "var(--chart-3)", Fable: "var(--chart-4)" }
const HEAT = ["oklch(0.34 0 0)", "oklch(0.46 0 0)", "oklch(0.6 0 0)", "oklch(0.76 0 0)", "oklch(0.92 0 0)"]

export default function UsageView() {
  const ledger = useUsage((s) => s.ledger)
  const scanning = useUsage((s) => s.scanning)
  const [range, setRange] = useState<Range>("month")
  useEffect(() => void refreshUsage(), [])
  return (
    <div className="@container/main h-full overflow-y-auto">
      <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Claude Code on this computer since {ledger ? firstDay(ledger) : "…"}, kept even after Claude Code deletes old transcripts (the same numbers as{" "}
            <code className="font-mono text-xs">ccusage</code>). Plan limits count claude.ai too.
          </p>
          <ToggleGroup type="single" variant="outline" value={range} onValueChange={(v) => v && setRange(v as Range)} aria-label="Range">
            {RANGES.map((r) => (
              <ToggleGroupItem key={r.id} value={r.id} className="px-3">
                {r.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button size="sm" variant="outline" disabled={scanning} onClick={() => void refreshUsage()}>
            <RefreshCw className={cn(scanning && "animate-spin")} /> {scanning ? "Reading…" : "Refresh"}
          </Button>
        </div>
        {!ledger ? (
          <div className="grid gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4" aria-busy="true" aria-label="Reading your usage">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
            <Skeleton className="h-80 rounded-xl @xl/main:col-span-2 @5xl/main:col-span-4" />
          </div>
        ) : (
          <Dashboard range={range} />
        )}
      </div>
    </div>
  )
}

function firstDay(l: { hours: Record<string, unknown> }) {
  const k = Object.keys(l.hours).sort()[0]
  return k ? new Date(`${k}:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "today"
}

function Dashboard({ range }: { range: Range }) {
  const ledger = useUsage((s) => s.ledger)!
  const limits = useUsage((s) => s.limits)
  const label = RANGES.find((r) => r.id === range)!
  const t = useMemo(() => totals(ledger, rangeStart(range)), [ledger, range])
  const prev = useMemo(() => {
    const p = previousRange(range)
    return p ? totals(ledger, p[0], p[1]) : null
  }, [ledger, range])
  const days = useMemo(() => perDay(ledger), [ledger])
  const st = useMemo(() => streaks(days), [days])
  const peak = useMemo(() => [...days.entries()].sort((a, b) => b[1].tokens - a[1].tokens)[0], [days])
  const session = limits?.limits.find((l) => l.group === "session")
  const week = limits?.limits.find((l) => l.kind === "weekly_all") ?? limits?.limits.find((l) => l.group === "weekly")
  const now = useNow()
  return (
    <>
      <div className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
        <StatCard title="Tokens" value={compactTokens(t.tokens)} now={t.tokens} before={prev?.tokens} line={`${t.requests.toLocaleString()} requests`} sub={`Claude Code, ${label.long}`} />
        <StatCard title="At API prices" value={usdFmt(t.cost)} now={t.cost} before={prev?.cost} line="What pay-as-you-go would cost" sub="Your plan is a flat fee" />
        <StatCard title="Prompts" value={t.prompts.toLocaleString()} now={t.prompts} before={prev?.prompts} line={`${t.sessions} sessions · ${t.tools.toLocaleString()} tool calls`} sub={`Messages you sent, ${label.long}`} />
        <Card className="@container/card">
          <CardHeader>
            <CardDescription>Plan limits</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">{session ? `${Math.round(session.percent)}%` : "–"}</CardTitle>
            <CardAction>
              <Badge variant="outline">{limits?.plan ?? "plan"}</Badge>
            </CardAction>
          </CardHeader>
          <CardFooter className="flex-col items-stretch gap-2 text-sm">
            {session && <Meter label="Current session (5 h)" percent={session.percent} sub={until(session.resets_at, now)} />}
            {week && <Meter label="This week" percent={week.percent} sub={until(week.resets_at, now)} />}
            {!limits && <span className="text-muted-foreground">Asking Claude Code…</span>}
          </CardFooter>
        </Card>
      </div>

      <TokensChart range={range} />

      <div className="grid gap-4 @3xl/main:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By model</CardTitle>
            <CardDescription>Tokens and value, {label.long}</CardDescription>
          </CardHeader>
          <CardContent>
            <Models rows={t.byModel} total={t.tokens} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Where the value goes</CardTitle>
            <CardDescription>Share of value (bright) against share of tokens (faint), {label.long}</CardDescription>
          </CardHeader>
          <CardContent>
            <Parts t={t} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>Tokens per day, last 12 months</CardDescription>
            <CardAction className="flex gap-5 text-right text-sm">
              <Fact label="Streak" value={`${st.current} d`} />
              <Fact label="Longest" value={`${st.longest} d`} />
              <Fact label="Active days" value={String(st.activeDays)} />
              <Fact label="Peak day" value={peak ? compactTokens(peak[1].tokens) : "–"} />
            </CardAction>
          </CardHeader>
          <CardContent>
            <Heatmap days={days} />
          </CardContent>
        </Card>
      </div>

      <LimitsChart samples={limits?.samples ?? []} />

      <DailyTable range={range} />
    </>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular font-medium">{value}</span>
    </div>
  )
}

/** A section card with the change against the period before, like the starter dashboard. */
function StatCard({ title, value, now, before, line, sub }: { title: string; value: string; now: number; before?: number; line: ReactNode; sub: string }) {
  const pct = before ? ((now - before) / before) * 100 : null
  const up = (pct ?? 0) >= 0
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">{value}</CardTitle>
        {pct != null && Number.isFinite(pct) && (
          <CardAction>
            <Badge variant="outline" title="Compared with the period before">
              {up ? <TrendingUp /> : <TrendingDown />}
              {up ? "+" : ""}
              {pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardFooter className="flex-col items-start gap-1.5 text-sm">
        <div className="line-clamp-1 flex gap-2 font-medium">{line}</div>
        <div className="text-muted-foreground">{sub}</div>
      </CardFooter>
    </Card>
  )
}

// ---------- tokens over the range, stacked by model family ----------
const tokensConfig = {
  Opus: { label: "Opus", color: FAMILY_COLOR.Opus },
  Sonnet: { label: "Sonnet", color: FAMILY_COLOR.Sonnet },
  Haiku: { label: "Haiku", color: FAMILY_COLOR.Haiku },
  Fable: { label: "Fable", color: FAMILY_COLOR.Fable },
} satisfies ChartConfig

function TokensChart({ range }: { range: Range }) {
  const ledger = useUsage((s) => s.ledger)!
  const data = useMemo(() => series(ledger, range), [ledger, range])
  const used = FAMILIES.filter((f) => data.some((d) => (d[f] as number) > 0))
  const label = RANGES.find((r) => r.id === range)!
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Tokens</CardTitle>
        <CardDescription>
          By model, {label.long} · per {range === "today" ? "hour" : range === "year" ? "week" : range === "all" ? "month" : "day"}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer config={tokensConfig} className="aspect-auto h-[300px] w-full">
          <AreaChart data={data} margin={{ left: 4, right: 4 }}>
            <defs>
              {used.map((f) => (
                <linearGradient key={f} id={`fill-${f}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={`var(--color-${f})`} stopOpacity={0.9} />
                  <stop offset="95%" stopColor={`var(--color-${f})`} stopOpacity={0.1} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} />
            <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => compactTokens(v)} />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  indicator="dot"
                  formatter={(value, name) => (
                    <div className="flex w-full items-center gap-2">
                      <span className="size-2 shrink-0 rounded-[2px]" style={{ background: FAMILY_COLOR[String(name)] }} />
                      <span className="text-muted-foreground">{String(name)}</span>
                      <span className="ml-auto font-mono font-medium tabular-nums">{compactTokens(Number(value))}</span>
                    </div>
                  )}
                />
              }
            />
            {used
              .slice()
              .reverse()
              .map((f) => (
                <Area key={f} dataKey={f} type="natural" fill={`url(#fill-${f})`} stroke={`var(--color-${f})`} stackId="a" isAnimationActive={false} />
              ))}
            {used.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

// ---------- plan limits over time (two series, one axis: % used) ----------
const SPANS = [
  { id: "5", label: "5 hours" },
  { id: "24", label: "24 hours" },
  { id: "168", label: "7 days" },
  { id: "720", label: "30 days" },
]
const limitsConfig = {
  s: { label: "Session (5 h)", color: "var(--chart-1)" },
  w: { label: "Weekly", color: "var(--chart-3)" },
} satisfies ChartConfig

function LimitsChart({ samples }: { samples: LimitSample[] }) {
  const [span, setSpan] = useState("24")
  const now = useNow()
  const from = now - Number(span) * 3600e3
  const data = samples.filter((s) => s.t >= from).map((s) => ({ t: s.t, s: s.s ?? null, w: s.w ?? null }))
  const fmt = (t: number) => new Date(t).toLocaleString(undefined, Number(span) > 24 ? { day: "numeric", month: "short" } : { hour: "2-digit", minute: "2-digit" })
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Plan limits over time</CardTitle>
        <CardDescription>Sampled every 5 minutes while the app runs (claude.ai and Claude Code together)</CardDescription>
        <CardAction>
          <ToggleGroup type="single" variant="outline" value={span} onValueChange={(v) => v && setSpan(v)} className="hidden @[640px]/card:flex">
            {SPANS.map((s) => (
              <ToggleGroupItem key={s.id} value={s.id} className="px-3">
                {s.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {data.length < 2 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Not enough samples yet. The app records your limits every 5 minutes while it runs.</p>
        ) : (
          <ChartContainer config={limitsConfig} className="aspect-auto h-[240px] w-full">
            <AreaChart data={data} margin={{ left: 4, right: 4 }}>
              <defs>
                <linearGradient id="fill-s" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-s)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-s)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fill-w" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-w)" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="var(--color-w)" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={[from, now]} tickLine={false} axisLine={false} tickMargin={8} minTickGap={40} tickFormatter={fmt} />
              <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => `${v}%`} />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    labelFormatter={(_, p) => fmt(Number(p?.[0]?.payload?.t))}
                    formatter={(v, n) => (
                      <span className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">{limitsConfig[n as "s" | "w"]?.label}</span>
                        <span className="font-mono tabular-nums">{Number(v)}%</span>
                      </span>
                    )}
                  />
                }
              />
              <Area dataKey="w" type="monotone" fill="url(#fill-w)" stroke="var(--color-w)" connectNulls={false} isAnimationActive={false} />
              <Area dataKey="s" type="monotone" fill="url(#fill-s)" stroke="var(--color-s)" connectNulls={false} isAnimationActive={false} />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- by model ----------
function Models({ rows, total }: { rows: { id: string; tokens: number; cost: number }[]; total: number }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing in this range.</p>
  return (
    <ul className="flex flex-col gap-3">
      {rows.slice(0, 8).map((r) => {
        const color = FAMILY_COLOR[familyOf(r.id)] ?? FAMILY_COLOR.Opus
        const pct = total ? (r.tokens / total) * 100 : 0
        return (
          <li key={r.id} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2 text-sm">
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{modelName(r.id)}</span>
              <span className="tabular text-xs text-muted-foreground">{usdFmt(r.cost)}</span>
              <span className="tabular w-14 text-right font-medium">{compactTokens(r.tokens)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 0.5)}%`, background: color }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Tokens and value by kind. Cache reads are most of the tokens but cheap; cache writes are few tokens
 * at a premium, and they grow when sessions sit idle past their cache and pick up again.
 */
function Parts({ t }: { t: ReturnType<typeof totals> }) {
  if (!t.tokens) return <p className="text-sm text-muted-foreground">Nothing in this range.</p>
  return (
    <ul className="flex flex-col gap-3">
      {PARTS.filter((p) => t.byPart[p.id].tokens > 0).map((p) => {
        const x = t.byPart[p.id]
        const tokPct = (x.tokens / t.tokens) * 100
        const costPct = t.cost ? (x.cost / t.cost) * 100 : 0
        return (
          <li key={p.id} className="flex flex-col gap-1" title={p.note}>
            <div className="flex items-baseline gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{p.label}</span>
              <span className="tabular text-xs text-muted-foreground">{pctFmt(tokPct)} of tokens</span>
              <span className="tabular w-24 text-right font-medium">
                {usdFmt(x.cost)} <span className="text-xs font-normal text-muted-foreground">{pctFmt(costPct)}</span>
              </span>
            </div>
            {/* the value share; the faint track behind it marks the token share */}
            <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="absolute inset-y-0 left-0 rounded-full bg-foreground/25" style={{ width: `${tokPct}%` }} />
              <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${Math.max(costPct, 0.5)}%` }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

const pctFmt = (n: number) => (n >= 10 ? `${Math.round(n)}%` : n >= 1 ? `${n.toFixed(1)}%` : n > 0 ? "<1%" : "0%")

// ---------- activity heatmap (53 weeks, Monday first; fills the card width) ----------
type Day = { key: string; date: Date; tokens: number; future: boolean }

function Heatmap({ days }: { days: Map<string, { tokens: number }> }) {
  const [tip, setTip] = useState("")
  const { cols, thresholds, months } = useMemo(() => {
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    const start = new Date(today)
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 52 * 7)
    const cols: Day[][] = []
    const months: { col: number; label: string }[] = []
    for (let c = 0; c < 53; c++) {
      const col: Day[] = []
      for (let r = 0; r < 7; r++) {
        const d = new Date(start)
        d.setDate(start.getDate() + c * 7 + r)
        const k = dayKey(d)
        col.push({ key: k, date: d, tokens: days.get(k)?.tokens ?? 0, future: d > today })
        if (r === 0 && d.getDate() <= 7) months.push({ col: c, label: d.toLocaleDateString(undefined, { month: "short" }) })
      }
      cols.push(col)
    }
    const vals = cols
      .flat()
      .map((d) => d.tokens)
      .filter((v) => v > 0)
      .sort((a, b) => a - b)
    const q = (f: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * f))] ?? 0
    return { cols, thresholds: [q(0.2), q(0.4), q(0.6), q(0.8)], months }
  }, [days])
  const level = (v: number) => (v <= 0 ? -1 : thresholds.filter((t) => v > t).length)
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: "28px repeat(53, minmax(0, 1fr))" }}>
        <span />
        {Array.from({ length: 53 }, (_, c) => (
          <span key={c} className="h-4 overflow-visible text-[10px] whitespace-nowrap text-muted-foreground">
            {months.find((m) => m.col === c)?.label ?? ""}
          </span>
        ))}
        {Array.from({ length: 7 }, (_, r) => (
          <HeatRow key={r} r={r} cols={cols} level={level} onTip={setTip} />
        ))}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{tip || "Hover a day"}</span>
        Less
        {[-1, 0, 1, 2, 3, 4].map((l) => (
          <span key={l} className="size-2.5 rounded-[2px]" style={{ background: l < 0 ? "var(--muted)" : HEAT[l] }} />
        ))}
        More
      </div>
    </div>
  )
}

function HeatRow({ r, cols, level, onTip }: { r: number; cols: Day[][]; level: (v: number) => number; onTip: (s: string) => void }) {
  return (
    <>
      <span className="text-[10px] leading-none text-muted-foreground">{r === 0 ? "Mon" : r === 2 ? "Wed" : r === 4 ? "Fri" : ""}</span>
      {cols.map((col) => {
        const d = col[r]
        if (d.future) return <span key={d.key} />
        const l = level(d.tokens)
        const text = `${d.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}: ${d.tokens ? `${compactTokens(d.tokens)} tokens` : "no usage"}`
        return <span key={d.key} className="aspect-square rounded-[2px]" style={{ background: l < 0 ? "var(--muted)" : HEAT[l] }} title={text} onPointerEnter={() => onTip(text)} />
      })}
    </>
  )
}

// ---------- daily table (like `ccusage daily`) ----------
function DailyTable({ range }: { range: Range }) {
  const ledger = useUsage((s) => s.ledger)!
  const rows = useMemo(() => dailyRows(ledger, rangeStart(range)), [ledger, range])
  const sum = rows.reduce((a, r) => ({ i: a.i + r.i, o: a.o + r.o, w: a.w + r.w, r: a.r + r.r, cost: a.cost + r.cost }), { i: 0, o: 0, w: 0, r: 0, cost: 0 })
  const n = (v: number) => v.toLocaleString("en-US")
  const num = "text-right font-mono text-xs tabular-nums"
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Daily</CardTitle>
        <CardDescription>Every day of {RANGES.find((r) => r.id === range)!.long}, the same columns as ccusage</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="max-h-[480px] overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="pl-6">Date</TableHead>
                <TableHead>Models</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Cache write</TableHead>
                <TableHead className="text-right">Cache read</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="pr-6 text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.date}>
                  <TableCell className="pl-6 font-mono text-xs">{r.date}</TableCell>
                  <TableCell className="max-w-56 truncate text-xs text-muted-foreground">{[...r.models].join(", ")}</TableCell>
                  <TableCell className={num}>{n(r.i)}</TableCell>
                  <TableCell className={num}>{n(r.o)}</TableCell>
                  <TableCell className={num}>{n(r.w)}</TableCell>
                  <TableCell className={num}>{n(r.r)}</TableCell>
                  <TableCell className={num}>{n(r.i + r.o + r.w + r.r)}</TableCell>
                  <TableCell className={cn(num, "pr-6")}>${r.cost.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter className="sticky bottom-0 bg-card">
              <TableRow>
                <TableCell className="pl-6 font-medium">Total</TableCell>
                <TableCell className="text-xs text-muted-foreground">{rows.length} days</TableCell>
                <TableCell className={num}>{n(sum.i)}</TableCell>
                <TableCell className={num}>{n(sum.o)}</TableCell>
                <TableCell className={num}>{n(sum.w)}</TableCell>
                <TableCell className={num}>{n(sum.r)}</TableCell>
                <TableCell className={num}>{n(sum.i + sum.o + sum.w + sum.r)}</TableCell>
                <TableCell className={cn(num, "pr-6 font-medium")}>${sum.cost.toFixed(2)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
