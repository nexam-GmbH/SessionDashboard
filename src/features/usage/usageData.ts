// Usage history: the ledger the desktop app keeps (src-tauri/src/usage.rs: tokens per UTC hour and
// model, prompts, tool calls, sessions) turned into what the Usage screen shows, plus the plan's
// limits (5-hour and weekly, shared with claude.ai) sampled over time.
import { create } from "zustand"
import { IN_TAURI } from "@/lib/platform"
import { REAL } from "@/backend/mode"
import { getApp } from "@/store/app"

export interface Tokens {
  i: number
  o: number
  w5: number
  w1: number
  r: number
  n: number
}
export interface Hour {
  m: Record<string, Tokens>
  p: number
  t: number
  s: number[]
  /** session index → model → tokens (the last days only) */
  sm?: Record<string, Record<string, Tokens>>
}
export interface Ledger {
  hours: Record<string, Hour>
  sessions: string[]
}
export interface LimitSample {
  t: number
  s?: number | null
  w?: number | null
}
export interface Limit {
  kind: string
  group: string
  percent: number
  resets_at?: string | null
  scope?: { model?: { display_name?: string | null } | null } | null
}
export interface Limits {
  limits: Limit[]
  plan?: string
  samples: LimitSample[]
  at: number
}

// ---------- prices (USD per million tokens; platform docs, 2026-11) ----------
// input, output, cache read; cache writes cost 1.25× input (5-minute) and 2× input (1-hour)
const PRICES: [RegExp, number, number, number][] = [
  [/fable-5-2|mythos-5-2/, 8, 40, 0.2],
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/fable-5|mythos-5/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-5|opus-4/, 5, 25, 0.5],
  [/sonnet-5-5/, 2, 10, 0.1],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet-4/, 3, 15, 0.3],
  [/haiku-5-5/, 0.1, 0.5, 0.01],
  [/haiku-4/, 1, 5, 0.1],
]

/** What these tokens would cost at API prices (a subscription pays a flat fee; this is the value). */
export function costOf(model: string, t: Tokens) {
  const p = PRICES.find(([re]) => re.test(model))
  if (!p) return 0
  const [, inp, out, read] = p
  return (t.i * inp + t.o * out + t.w5 * inp * 1.25 + t.w1 * inp * 2 + t.r * read) / 1e6
}

export const totalTokens = (t: Tokens) => t.i + t.o + t.w5 + t.w1 + t.r

/**
 * The next message's cost to re-read the conversation: from the cache while it is warm, or written to
 * the cache again (1.25× input for a 5-minute cache, 2× for a 1-hour one) after it expired.
 */
export function cacheCost(model: string, tokens: number, ttl: number) {
  const p = PRICES.find(([re]) => re.test(model))
  if (!p) return null
  const [, inp, , read] = p
  return { warm: (tokens * read) / 1e6, cold: (tokens * inp * (ttl >= 3600 ? 2 : 1.25)) / 1e6 }
}

export type Part = "r" | "w5" | "w1" | "o" | "i"
export const PARTS: { id: Part; label: string; note: string }[] = [
  { id: "r", label: "Cache reads", note: "The conversation so far, read again on every call" },
  { id: "w1", label: "Cache writes, 1 hour", note: "Kept an hour; written again after an hour idle" },
  { id: "w5", label: "Cache writes, 5 minutes", note: "Written again after 5 minutes idle" },
  { id: "o", label: "Output", note: "What Claude wrote, thinking included" },
  { id: "i", label: "Input, uncached", note: "Read once and not kept" },
]

/** Value of each kind of token at API prices. */
export function costParts(model: string, t: Tokens): Record<Part, number> {
  const p = PRICES.find(([re]) => re.test(model))
  if (!p) return { r: 0, w5: 0, w1: 0, o: 0, i: 0 }
  const [, inp, out, read] = p
  return { i: (t.i * inp) / 1e6, o: (t.o * out) / 1e6, w5: (t.w5 * inp * 1.25) / 1e6, w1: (t.w1 * inp * 2) / 1e6, r: (t.r * read) / 1e6 }
}

/** "claude-opus-5-5" → "Opus 5.5" */
export function modelName(id: string) {
  const m = /(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return id.replace(/^claude-/, "")
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`
}

/** The model family (fixed colour order on the charts). */
export const FAMILIES = ["Opus", "Sonnet", "Haiku", "Fable"] as const
export function familyOf(id: string) {
  return FAMILIES.find((f) => id.toLowerCase().includes(f.toLowerCase())) ?? (id.includes("mythos") ? "Fable" : "Opus")
}

// ---------- time buckets (local time) ----------
const pad = (n: number) => String(n).padStart(2, "0")
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
/** UTC hour key "2026-11-15T13" → its start as a Date */
export const hourDate = (k: string) => new Date(`${k}:00:00Z`)

export type Range = "today" | "week" | "month" | "quarter" | "year" | "all"
export const RANGES: { id: Range; label: string; long: string }[] = [
  { id: "today", label: "Today", long: "today" },
  { id: "week", label: "7 days", long: "the last 7 days" },
  { id: "month", label: "30 days", long: "the last 30 days" },
  { id: "quarter", label: "90 days", long: "the last 3 months" },
  { id: "year", label: "Year", long: "the last 12 months" },
  { id: "all", label: "All time", long: "all time" },
]

export function rangeStart(r: Range, now = new Date()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  if (r === "today") return d.getTime()
  if (r === "week") return d.getTime() - 6 * 864e5
  if (r === "month") return d.getTime() - 29 * 864e5
  if (r === "quarter") return d.getTime() - 89 * 864e5
  if (r === "year") return d.getTime() - 364 * 864e5
  return 0
}

/** The period just before a range, the same length (the trend badges compare with it). */
export function previousRange(r: Range, now = new Date()): [number, number] | null {
  if (r === "all") return null
  const from = rangeStart(r, now)
  const len = r === "today" ? 864e5 : now.getTime() - from
  return [from - len, from]
}

/** Per bucket (hour / day / week / month) the tokens of each model family, for the area chart. */
export function series(l: Ledger, r: Range, now = new Date()) {
  return buckets(l, r, now).map((b) => {
    const row: Record<string, number | string> = { label: b.label, start: b.start, cost: b.cost }
    for (const f of FAMILIES) row[f] = 0
    for (const [k, h] of Object.entries(l.hours)) {
      const t = hourDate(k).getTime()
      if (t < b.start || t >= b.end) continue
      for (const [m, x] of Object.entries(h.m)) row[familyOf(m)] = (row[familyOf(m)] as number) + totalTokens(x)
    }
    return row
  })
}

/** One row per local day, newest first, like `ccusage daily`. */
export function dailyRows(l: Ledger, from: number) {
  const days = new Map<string, { date: string; models: Set<string>; i: number; o: number; w: number; r: number; cost: number }>()
  for (const [k, h] of Object.entries(l.hours)) {
    const d0 = hourDate(k)
    if (d0.getTime() < from) continue
    const key = dayKey(d0)
    const e = days.get(key) ?? { date: key, models: new Set<string>(), i: 0, o: 0, w: 0, r: 0, cost: 0 }
    for (const [m, x] of Object.entries(h.m)) {
      e.models.add(modelName(m))
      e.i += x.i
      e.o += x.o
      e.w += x.w5 + x.w1
      e.r += x.r
      e.cost += costOf(m, x)
    }
    days.set(key, e)
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1))
}

export interface Totals {
  tokens: number
  cost: number
  requests: number
  prompts: number
  tools: number
  sessions: number
  byModel: { id: string; tokens: number; cost: number }[]
  byPart: Record<Part, { tokens: number; cost: number }>
}

export function totals(l: Ledger, from: number, to = Infinity): Totals {
  const byModel = new Map<string, { tokens: number; cost: number }>()
  const sessions = new Set<number>()
  const byPart = Object.fromEntries(PARTS.map((x) => [x.id, { tokens: 0, cost: 0 }])) as Totals["byPart"]
  let tokens = 0
  let cost = 0
  let requests = 0
  let prompts = 0
  let tools = 0
  for (const [k, h] of Object.entries(l.hours)) {
    const t = hourDate(k).getTime()
    if (t < from || t >= to) continue
    prompts += h.p
    tools += h.t
    for (const s of h.s) sessions.add(s)
    for (const [m, x] of Object.entries(h.m)) {
      const tk = totalTokens(x)
      const c = costOf(m, x)
      tokens += tk
      cost += c
      requests += x.n
      const parts = costParts(m, x)
      for (const { id } of PARTS) {
        byPart[id].tokens += x[id]
        byPart[id].cost += parts[id]
      }
      const e = byModel.get(m) ?? { tokens: 0, cost: 0 }
      e.tokens += tk
      e.cost += c
      byModel.set(m, e)
    }
  }
  return {
    tokens,
    cost,
    requests,
    prompts,
    tools,
    sessions: sessions.size,
    byModel: [...byModel.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.tokens - a.tokens),
    byPart,
  }
}

/**
 * Which sessions used the last `hours` (the plan's 5-hour window, by whole UTC hours: the current hour
 * and the ones before it), by value at API prices; subagents count for their session.
 */
export function recentBySession(l: Ledger, hours = 5, now = Date.now()) {
  const from = new Date(now - hours * 3600_000).toISOString().slice(0, 13)
  const by = new Map<string, { cost: number; tokens: number }>()
  let total = 0
  for (const [k, h] of Object.entries(l.hours)) {
    if (k < from || !h.sm) continue
    for (const [six, models] of Object.entries(h.sm)) {
      const id = l.sessions[Number(six)]
      if (!id) continue
      const e = by.get(id) ?? { cost: 0, tokens: 0 }
      for (const [m, t] of Object.entries(models)) {
        const c = costOf(m, t)
        e.cost += c
        e.tokens += totalTokens(t)
        total += c
      }
      by.set(id, e)
    }
  }
  return { total, rows: [...by.entries()].map(([id, v]) => ({ id, ...v, share: total ? v.cost / total : 0 })).sort((a, b) => b.cost - a.cost) }
}

/** Tokens and cost per local day. */
export function perDay(l: Ledger) {
  const days = new Map<string, { tokens: number; cost: number; prompts: number }>()
  for (const [k, h] of Object.entries(l.hours)) {
    const d = dayKey(hourDate(k))
    const e = days.get(d) ?? { tokens: 0, cost: 0, prompts: 0 }
    for (const [m, x] of Object.entries(h.m)) {
      e.tokens += totalTokens(x)
      e.cost += costOf(m, x)
    }
    e.prompts += h.p
    days.set(d, e)
  }
  return days
}

/** Buckets for the range's bar chart: hours today, days for a week or month, weeks for a year, months for all time. */
export function buckets(l: Ledger, r: Range, now = new Date()) {
  const out: { key: string; label: string; start: number; end: number; tokens: number; cost: number }[] = []
  const add = (start: Date, end: Date, label: string) => {
    const t = totals(l, start.getTime(), end.getTime())
    out.push({ key: start.toISOString(), label, start: start.getTime(), end: end.getTime(), tokens: t.tokens, cost: t.cost })
  }
  const day0 = new Date(now)
  day0.setHours(0, 0, 0, 0)
  if (r === "today") {
    for (let h = 0; h < 24; h++) {
      const s = new Date(day0)
      s.setHours(h)
      const e = new Date(s)
      e.setHours(h + 1)
      add(s, e, `${pad(h)}:00`)
    }
  } else if (r === "week" || r === "month" || r === "quarter") {
    const n = r === "week" ? 7 : r === "month" ? 30 : 90
    for (let i = n - 1; i >= 0; i--) {
      const s = new Date(day0)
      s.setDate(s.getDate() - i)
      const e = new Date(s)
      e.setDate(e.getDate() + 1)
      add(s, e, s.toLocaleDateString(undefined, { day: "numeric", month: "short" }))
    }
  } else if (r === "year") {
    const s0 = new Date(day0)
    s0.setDate(s0.getDate() - ((s0.getDay() + 6) % 7) - 51 * 7)
    for (let i = 0; i < 52; i++) {
      const s = new Date(s0)
      s.setDate(s.getDate() + i * 7)
      const e = new Date(s)
      e.setDate(e.getDate() + 7)
      add(s, e, s.toLocaleDateString(undefined, { day: "numeric", month: "short" }))
    }
  } else {
    const keys = Object.keys(l.hours).sort()
    const first = keys.length ? hourDate(keys[0]) : now
    const s = new Date(first.getFullYear(), first.getMonth(), 1)
    while (s <= now) {
      const e = new Date(s.getFullYear(), s.getMonth() + 1, 1)
      add(new Date(s), e, s.toLocaleDateString(undefined, { month: "short", year: "2-digit" }))
      s.setMonth(s.getMonth() + 1)
    }
  }
  return out
}

/** Days in a row with any prompt or token, ending today (current) and the longest run. */
export function streaks(days: Map<string, { tokens: number }>, now = new Date()) {
  const active = new Set([...days.entries()].filter(([, v]) => v.tokens > 0).map(([k]) => k))
  let current = 0
  const d = new Date(now)
  if (!active.has(dayKey(d))) d.setDate(d.getDate() - 1)
  while (active.has(dayKey(d))) {
    current++
    d.setDate(d.getDate() - 1)
  }
  let longest = 0
  for (const k of active) {
    const prev = new Date(`${k}T12:00:00`)
    prev.setDate(prev.getDate() - 1)
    if (active.has(dayKey(prev))) continue
    let run = 0
    const c = new Date(`${k}T12:00:00`)
    while (active.has(dayKey(c))) {
      run++
      c.setDate(c.getDate() + 1)
    }
    longest = Math.max(longest, run)
  }
  return { current, longest, activeDays: active.size }
}

// ---------- formatting ----------
export function compactTokens(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return String(Math.round(n))
}
export const usdFmt = (n: number) => (n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(n >= 100 ? 0 : 2)}`)

// ---------- loading ----------
interface UsageState {
  ledger: Ledger | null
  limits: Limits | null
  scanning: boolean
  error?: string
}
export const useUsage = create<UsageState>(() => ({ ledger: null, limits: null, scanning: false }))

let started = false
export async function refreshUsage(what: { ledger?: boolean; limits?: boolean } = { ledger: true, limits: true }) {
  if (!(IN_TAURI && REAL)) {
    if (!useUsage.getState().ledger) useUsage.setState({ ledger: mockLedger(), limits: mockLimits() })
    return
  }
  const { invoke } = await import("@tauri-apps/api/core")
  if (what.limits)
    invoke<{ usage: Record<string, unknown>; samples: LimitSample[] }>("usage_limits")
      .then((r) => {
        const rl = r.usage?.rate_limits as { limits?: Limit[] } | undefined
        useUsage.setState({ limits: { limits: rl?.limits ?? [], plan: r.usage?.subscription_type as string | undefined, samples: r.samples ?? [], at: Date.now() } })
      })
      .catch((e) => useUsage.setState({ error: String(e) }))
  if (what.ledger && !useUsage.getState().scanning) {
    useUsage.setState({ scanning: true })
    try {
      useUsage.setState({ ledger: await invoke<Ledger>("usage_scan") })
    } catch (e) {
      useUsage.setState({ error: String(e) })
    } finally {
      useUsage.setState({ scanning: false })
    }
  }
}

/** Limits every 5 minutes, history every 10 (only new lines are read after the first time). */
export function startUsage() {
  if (started) return
  started = true
  setTimeout(() => void refreshUsage(), 4000)
  setInterval(() => void refreshUsage({ limits: true }), 5 * 60_000)
  setInterval(() => void refreshUsage({ ledger: true }), 10 * 60_000)
}

// ---------- preview data (browser) ----------
function mockLedger(): Ledger {
  const hours: Record<string, Hour> = {}
  const now = Date.now()
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let h = 0; h < 24 * 120; h++) {
    const t = new Date(now - h * 3600e3)
    const lh = t.getHours()
    if (lh < 9 || lh > 23 || rnd() < 0.35) continue
    const day = Math.floor(h / 24)
    if (day % 7 === 6 && rnd() < 0.7) continue
    const k = t.toISOString().slice(0, 13)
    const scale = rnd() * 4e6 * (day < 60 ? 1.6 : 1)
    hours[k] = {
      m: {
        "claude-opus-5-5": { i: Math.round(scale * 0.0001), o: Math.round(scale * 0.003), w5: 0, w1: Math.round(scale * 0.02), r: Math.round(scale), n: Math.round(20 + rnd() * 60) },
        ...(rnd() < 0.3 ? { "claude-sonnet-5-5": { i: 10, o: Math.round(scale * 0.001), w5: 0, w1: Math.round(scale * 0.005), r: Math.round(scale * 0.2), n: 8 } } : {}),
      },
      p: Math.round(rnd() * 12),
      t: Math.round(rnd() * 60),
      s: [Math.floor(rnd() * 20), Math.floor(rnd() * 20)],
    }
  }
  // the last hours split by session (the demo world's sessions, when the app has them)
  const ids = Object.keys(getApp().sessions).slice(0, 6)
  const sessions = ids.length ? ids : Array.from({ length: 6 }, (_, i) => `s${i}`)
  for (let h = 0; h < 6; h++) {
    const k = new Date(now - h * 3600e3).toISOString().slice(0, 13)
    const hr = (hours[k] ??= { m: {}, p: 3, t: 12, s: [] })
    hr.sm = {}
    sessions.forEach((_, i) => {
      if (rnd() < 0.3) return
      const scale = rnd() * 3e6 * (i === 1 ? 3 : 1)
      hr.sm![String(i)] = { "claude-opus-5-5": { i: 100, o: Math.round(scale * 0.003), w5: 0, w1: Math.round(scale * 0.02), r: Math.round(scale), n: 20 } }
    })
  }
  return { hours, sessions }
}

function mockLimits(): Limits {
  const now = Date.now()
  const samples: LimitSample[] = []
  for (let i = 0; i < 7 * 24 * 12; i++) {
    const t = now - (7 * 24 * 12 - i) * 5 * 60e3
    const inWin = ((t / 3600e3) % 5) / 5
    samples.push({ t, s: Math.round(inWin * 70 * (0.6 + 0.4 * Math.sin(i / 50) ** 2)), w: Math.round(10 + (i / (7 * 24 * 12)) * 30) })
  }
  const reset = (h: number) => new Date(now + h * 3600e3).toISOString()
  return {
    plan: "max",
    at: now,
    samples,
    limits: [
      { kind: "session", group: "session", percent: samples.at(-1)!.s ?? 0, resets_at: reset(2.4) },
      { kind: "weekly_all", group: "weekly", percent: 40, resets_at: reset(80) },
      { kind: "weekly_scoped", group: "weekly", percent: 12, resets_at: reset(80), scope: { model: { display_name: "Fable" } } },
    ],
  }
}
