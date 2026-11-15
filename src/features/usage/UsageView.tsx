// Usage: the plan's limits now and over time (5-hour and weekly, shared with claude.ai), an activity
// heatmap, and totals for today, a week, a month, a year or all time — tokens, API-price value,
// prompts, sessions, tool calls, per model — from the permanent ledger (usageData.ts).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useNow } from "@/components/common/RelativeTime"
import {
  FAMILIES,
  RANGES,
  buckets,
  compactTokens,
  dayKey,
  familyOf,
  modelName,
  perDay,
  rangeStart,
  refreshUsage,
  streaks,
  totals,
  usdFmt,
  useUsage,
  type Limit,
  type LimitSample,
  type Range,
} from "./usageData"

// validated categorical steps for the dark surface (dataviz reference palette): fixed order
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"]
// one hue (blue), brighter = more (dark surface)
const HEAT = ["#104281", "#1c5cab", "#2a78d6", "#5598e7", "#9ec5f4"]

export default function UsageView() {
  const ledger = useUsage((s) => s.ledger)
  const limits = useUsage((s) => s.limits)
  const scanning = useUsage((s) => s.scanning)
  const [range, setRange] = useState<Range>("month")
  useEffect(() => void refreshUsage(), [])
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Everything Claude Code ran on this computer since{" "}
            {ledger ? firstDay(ledger) : "…"}, kept even after Claude Code
            deletes old transcripts. Limits count claude.ai too.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={scanning}
            onClick={() => void refreshUsage()}
          >
            <RefreshCw className={cn(scanning && "animate-spin")} />{" "}
            {scanning ? "Reading…" : "Refresh"}
          </Button>
        </div>

        <LimitsCard limits={limits?.limits} plan={limits?.plan} />

        {!ledger ? (
          <div
            className="flex flex-col gap-3"
            aria-busy="true"
            aria-label="Reading your usage"
          >
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-56 w-full rounded-xl" />
            <p className="text-xs text-muted-foreground">
              Reading every transcript once; after that only new lines are read.
            </p>
          </div>
        ) : (
          <>
            <div
              className="flex items-center gap-1"
              role="tablist"
              aria-label="Range"
            >
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  role="tab"
                  aria-selected={range === r.id}
                  onClick={() => setRange(r.id)}
                  className={cn(
                    "h-8 rounded-lg px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    range === r.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <RangeSection range={range} />
            <Card title="Activity" note="Tokens per day, last 12 months">
              <Heatmap />
            </Card>
            <Card
              title="Limits over time"
              note="Sampled every 5 minutes while the app runs"
            >
              <LimitsOverTime samples={limits?.samples ?? []} />
            </Card>
          </>
        )}
      </div>
    </div>
  )
}

function firstDay(l: { hours: Record<string, unknown> }) {
  const k = Object.keys(l.hours).sort()[0]
  return k
    ? new Date(`${k}:00:00Z`).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "today"
}

function Card({
  title,
  note,
  children,
  className,
}: {
  title: string
  note?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "rounded-xl bg-card p-4 ring-1 ring-foreground/10",
        className
      )}
    >
      <header className="mb-3 flex items-baseline gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </header>
      {children}
    </section>
  )
}

// ---------- limits now ----------
function until(iso?: string | null) {
  if (!iso) return ""
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return "resets now"
  const h = Math.floor(ms / 3600e3)
  const m = Math.round((ms % 3600e3) / 60e3)
  return h >= 24
    ? `resets in ${Math.floor(h / 24)}d ${h % 24}h`
    : h
      ? `resets in ${h}h ${m}m`
      : `resets in ${m}m`
}

function LimitsCard({ limits, plan }: { limits?: Limit[]; plan?: string }) {
  const rows = (limits ?? []).filter(
    (l) => l.group === "session" || l.group === "weekly"
  )
  return (
    <Card
      title="Plan limits"
      note={
        plan
          ? `${plan} plan · claude.ai and Claude Code together`
          : "claude.ai and Claude Code together"
      }
    >
      {!limits ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
        </div>
      ) : !rows.length ? (
        <p className="text-sm text-muted-foreground">
          Your plan reports no limits here.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {rows.map((l, i) => (
            <Meter
              key={i}
              label={
                l.kind === "session"
                  ? "Current session (5 hours)"
                  : l.scope?.model?.display_name
                    ? `This week · ${l.scope.model.display_name}`
                    : "This week"
              }
              percent={l.percent}
              sub={until(l.resets_at)}
            />
          ))}
        </div>
      )}
    </Card>
  )
}

export function Meter({
  label,
  percent,
  sub,
}: {
  label: string
  percent: number
  sub?: string
}) {
  const p = Math.max(0, Math.min(100, percent))
  // status colours only for "close to the limit", with the number always shown
  const fill =
    p >= 90 ? "bg-st-error" : p >= 75 ? "bg-st-input" : "bg-foreground/80"
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="font-medium tabular">{Math.round(p)}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(p)}
        aria-label={label}
      >
        <div
          className={cn("h-full rounded-full", fill)}
          style={{ width: `${p}%` }}
        />
      </div>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}

// ---------- totals for a range ----------
function RangeSection({ range }: { range: Range }) {
  const ledger = useUsage((s) => s.ledger)!
  const t = useMemo(() => totals(ledger, rangeStart(range)), [ledger, range])
  const days = useMemo(() => perDay(ledger), [ledger])
  const st = useMemo(() => streaks(days), [days])
  const peak = useMemo(
    () => [...days.entries()].sort((a, b) => b[1].tokens - a[1].tokens)[0],
    [days]
  )
  const bars = useMemo(() => buckets(ledger, range), [ledger, range])
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Tokens" value={compactTokens(t.tokens)} />
        <Tile label="At API prices" value={usdFmt(t.cost)} />
        <Tile label="Prompts" value={t.prompts.toLocaleString()} />
        <Tile label="Sessions" value={t.sessions.toLocaleString()} />
        <Tile label="Tool calls" value={t.tools.toLocaleString()} />
        <Tile label="Requests" value={t.requests.toLocaleString()} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card
          title={
            range === "today"
              ? "Tokens per hour"
              : range === "year"
                ? "Tokens per week"
                : range === "all"
                  ? "Tokens per month"
                  : "Tokens per day"
          }
        >
          <Bars data={bars} />
        </Card>
        <Card title="By model">
          <Models rows={t.byModel} total={t.tokens} />
        </Card>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label="Current streak"
          value={`${st.current} day${st.current === 1 ? "" : "s"}`}
          small
        />
        <Tile label="Longest streak" value={`${st.longest} days`} small />
        <Tile label="Active days" value={String(st.activeDays)} small />
        <Tile
          label="Peak day"
          value={peak ? compactTokens(peak[1].tokens) : "–"}
          sub={
            peak
              ? new Date(`${peak[0]}T12:00:00`).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })
              : undefined
          }
          small
        />
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  sub,
  small,
}: {
  label: string
  value: string
  sub?: string
  small?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-semibold tracking-tight tabular",
          small ? "text-lg" : "text-2xl"
        )}
      >
        {value}
      </span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}

/** A tooltip that follows the pointer inside a chart box, and the box's width (charts draw at it, so text stays its size). */
function useTip() {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) =>
      setWidth(Math.max(200, Math.round(e.contentRect.width)))
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [tip, setTip] = useState<{
    x: number
    y: number
    left: boolean
    body: ReactNode
  } | null>(null)
  const show = (e: React.PointerEvent, body: ReactNode) => {
    const r = box.current?.getBoundingClientRect()
    // on the right half the tip opens to the left of the pointer
    if (r)
      setTip({
        x: e.clientX - r.left,
        y: e.clientY - r.top,
        left: e.clientX - r.left > r.width / 2,
        body,
      })
  }
  const node = tip && (
    <div
      className="pointer-events-none absolute z-10 rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translate(${tip.left ? "calc(-100% - 10px)" : "10px"}, -110%)`,
      }}
    >
      {tip.body}
    </div>
  )
  return { box, width, show, hide: () => setTip(null), node }
}

function Bars({
  data,
}: {
  data: { key: string; label: string; tokens: number; cost: number }[]
}) {
  const { box, width: W, show, hide, node } = useTip()
  const H = 180
  const max = Math.max(1, ...data.map((d) => d.tokens))
  const bw = W / data.length
  const gap = Math.min(2, bw * 0.25)
  const ticks = [0.5, 1].map((f) => ({
    y: H - (H - 20) * f,
    label: compactTokens(max * f),
  }))
  return (
    <div ref={box} className="relative" onPointerLeave={hide}>
      <svg
        width={W}
        height={H + 18}
        viewBox={`0 0 ${W} ${H + 18}`}
        className="block"
        role="img"
        aria-label="Tokens over the range"
      >
        {ticks.map((t) => (
          <g key={t.label}>
            <line
              x1={0}
              x2={W}
              y1={t.y}
              y2={t.y}
              stroke="currentColor"
              className="text-border"
              strokeDasharray="2 4"
            />
            <text
              x={0}
              y={t.y - 4}
              className="fill-muted-foreground text-[10px]"
            >
              {t.label}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const h = (d.tokens / max) * (H - 20)
          return (
            <g key={d.key} onPointerMove={(e) => show(e, <BarTip d={d} />)}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              {h > 0 && (
                <rect
                  x={i * bw + gap / 2}
                  y={H - h}
                  width={Math.max(1, bw - gap)}
                  height={h}
                  rx={Math.min(4, (bw - gap) / 2)}
                  fill={SERIES[0]}
                />
              )}
            </g>
          )
        })}
        <line
          x1={0}
          x2={W}
          y1={H}
          y2={H}
          stroke="currentColor"
          className="text-border"
        />
        {data.map((d, i) =>
          i % Math.ceil(data.length / 6) === 0 ? (
            <text
              key={d.key}
              x={i === 0 ? 0 : i * bw + bw / 2}
              y={H + 14}
              textAnchor={i === 0 ? "start" : "middle"}
              className="fill-muted-foreground text-[10px]"
            >
              {d.label}
            </text>
          ) : null
        )}
      </svg>
      {node}
    </div>
  )
}

function BarTip({ d }: { d: { label: string; tokens: number; cost: number } }) {
  return (
    <>
      <div className="font-medium">{d.label}</div>
      <div className="tabular">{compactTokens(d.tokens)} tokens</div>
      <div className="text-muted-foreground tabular">
        {usdFmt(d.cost)} at API prices
      </div>
    </>
  )
}

function Models({
  rows,
  total,
}: {
  rows: { id: string; tokens: number; cost: number }[]
  total: number
}) {
  if (!rows.length)
    return (
      <p className="text-sm text-muted-foreground">Nothing in this range.</p>
    )
  return (
    <ul className="flex flex-col gap-3">
      {rows.slice(0, 8).map((r) => {
        const color =
          SERIES[
            FAMILIES.indexOf(familyOf(r.id) as (typeof FAMILIES)[number])
          ] ?? SERIES[0]
        const pct = total ? (r.tokens / total) * 100 : 0
        return (
          <li key={r.id} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2 text-sm">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: color }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{modelName(r.id)}</span>
              <span className="text-xs text-muted-foreground tabular">
                {usdFmt(r.cost)}
              </span>
              <span className="w-14 text-right font-medium tabular">
                {compactTokens(r.tokens)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(pct, 0.5)}%`, background: color }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ---------- activity heatmap (53 weeks, Monday first) ----------
function Heatmap() {
  const ledger = useUsage((s) => s.ledger)!
  const days = useMemo(() => perDay(ledger), [ledger])
  const { box, show, hide, node } = useTip()
  const { cols, thresholds, months } = useMemo(() => {
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    const start = new Date(today)
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 52 * 7)
    const cols: {
      key: string
      date: Date
      tokens: number
      future: boolean
    }[][] = []
    const months: { col: number; label: string }[] = []
    for (let c = 0; c < 53; c++) {
      const col = []
      for (let r = 0; r < 7; r++) {
        const d = new Date(start)
        d.setDate(start.getDate() + c * 7 + r)
        const k = dayKey(d)
        col.push({
          key: k,
          date: d,
          tokens: days.get(k)?.tokens ?? 0,
          future: d > today,
        })
        if (r === 0 && d.getDate() <= 7)
          months.push({
            col: c,
            label: d.toLocaleDateString(undefined, { month: "short" }),
          })
      }
      cols.push(col)
    }
    const vals = cols
      .flat()
      .map((d) => d.tokens)
      .filter((v) => v > 0)
      .sort((a, b) => a - b)
    const q = (f: number) =>
      vals[Math.min(vals.length - 1, Math.floor(vals.length * f))] ?? 0
    return { cols, thresholds: [q(0.2), q(0.4), q(0.6), q(0.8)], months }
  }, [days])
  const level = (v: number) =>
    v <= 0 ? -1 : thresholds.filter((t) => v > t).length
  const C = 11
  const G = 3
  return (
    <div ref={box} className="relative overflow-x-auto" onPointerLeave={hide}>
      <svg
        width={30 + 53 * (C + G)}
        height={18 + 7 * (C + G)}
        role="img"
        aria-label="Tokens per day for the last year"
      >
        {months.map((m) => (
          <text
            key={m.col}
            x={30 + m.col * (C + G)}
            y={10}
            className="fill-muted-foreground text-[10px]"
          >
            {m.label}
          </text>
        ))}
        {["Mon", "Wed", "Fri"].map((d, i) => (
          <text
            key={d}
            x={0}
            y={18 + i * 2 * (C + G) + C - 2}
            className="fill-muted-foreground text-[10px]"
          >
            {d}
          </text>
        ))}
        {cols.map((col, c) =>
          col.map((d, r) =>
            d.future ? null : (
              <rect
                key={d.key}
                x={30 + c * (C + G)}
                y={18 + r * (C + G)}
                width={C}
                height={C}
                rx={2}
                fill={
                  level(d.tokens) < 0 ? "var(--muted)" : HEAT[level(d.tokens)]
                }
                onPointerMove={(e) =>
                  show(
                    e,
                    <>
                      <div className="font-medium">
                        {d.date.toLocaleDateString(undefined, {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </div>
                      <div className="tabular">
                        {d.tokens
                          ? `${compactTokens(d.tokens)} tokens`
                          : "No usage"}
                      </div>
                    </>
                  )
                }
              />
            )
          )
        )}
      </svg>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
        Less
        <span className="size-2.5 rounded-sm bg-muted" />
        {HEAT.map((c) => (
          <span
            key={c}
            className="size-2.5 rounded-sm"
            style={{ background: c }}
          />
        ))}
        More
      </div>
      {node}
    </div>
  )
}

// ---------- limits over time (two series, one axis: % used) ----------
const SPANS = [
  { id: 5, label: "5 hours" },
  { id: 24, label: "24 hours" },
  { id: 24 * 7, label: "7 days" },
  { id: 24 * 30, label: "30 days" },
]

function LimitsOverTime({ samples }: { samples: LimitSample[] }) {
  const [span, setSpan] = useState(24)
  const { box, width: W, show, hide, node } = useTip()
  const now = useNow()
  const from = now - span * 3600e3
  const pts = samples.filter((s) => s.t >= from)
  const H = 160
  const x = (t: number) => ((t - from) / (now - from)) * W
  const y = (v: number) => H - (Math.max(0, Math.min(100, v)) / 100) * H
  const path = (k: "s" | "w") => {
    let d = ""
    let prev = 0
    for (const p of pts) {
      const v = p[k]
      if (v == null) continue
      // a gap in sampling (app closed) breaks the line
      d += `${d && p.t - prev < 20 * 60e3 ? "L" : "M"}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`
      prev = p.t
    }
    return d
  }
  const last = pts.at(-1)
  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-xs">
        <span className="flex items-center gap-1.5">
          <span
            className="h-0.5 w-3 rounded"
            style={{ background: SERIES[0] }}
          />{" "}
          Session (5 h)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-0.5 w-3 rounded"
            style={{ background: SERIES[1] }}
          />{" "}
          Weekly
        </span>
        <span className="flex-1" />
        {SPANS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSpan(s.id)}
            className={cn(
              "h-6 rounded-md px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              span === s.id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div
        ref={box}
        className="relative"
        onPointerLeave={hide}
        onPointerMove={(e) => {
          const r = box.current!.getBoundingClientRect()
          const t = from + ((e.clientX - r.left) / r.width) * (now - from)
          if (pts.length < 2) return
          const p = pts.reduce((a, b) =>
            Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a
          )
          show(
            e,
            <>
              <div className="font-medium">
                {new Date(p.t).toLocaleString(undefined, {
                  weekday: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
              <div className="tabular">Session {p.s ?? "–"}%</div>
              <div className="tabular">Weekly {p.w ?? "–"}%</div>
            </>
          )
        }}
      >
        {pts.length < 2 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Not enough samples yet. The app records your limits every 5 minutes
            while it runs.
          </p>
        ) : (
          <>
            <svg
              width={W}
              height={H + 16}
              viewBox={`0 0 ${W} ${H + 16}`}
              className="block"
              role="img"
              aria-label="Session and weekly limit used over time"
            >
              {[25, 50, 75, 100].map((v) => (
                <g key={v}>
                  <line
                    x1={0}
                    x2={W}
                    y1={y(v)}
                    y2={y(v)}
                    stroke="currentColor"
                    className="text-border"
                    strokeDasharray={v === 100 ? undefined : "2 4"}
                  />
                  <text
                    x={W}
                    y={y(v) - 3}
                    textAnchor="end"
                    className="fill-muted-foreground text-[10px]"
                  >
                    {v}%
                  </text>
                </g>
              ))}
              <line
                x1={0}
                x2={W}
                y1={H}
                y2={H}
                stroke="currentColor"
                className="text-border"
              />
              <path
                d={path("w")}
                fill="none"
                stroke={SERIES[1]}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <path
                d={path("s")}
                fill="none"
                stroke={SERIES[0]}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <text
                x={0}
                y={H + 13}
                className="fill-muted-foreground text-[10px]"
              >
                {new Date(from).toLocaleString(
                  undefined,
                  span > 24
                    ? { day: "numeric", month: "short" }
                    : { hour: "2-digit", minute: "2-digit" }
                )}
              </text>
              <text
                x={W}
                y={H + 13}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                now
                {last
                  ? ` · session ${last.s ?? "–"}% · weekly ${last.w ?? "–"}%`
                  : ""}
              </text>
            </svg>
          </>
        )}
        {node}
      </div>
    </div>
  )
}
