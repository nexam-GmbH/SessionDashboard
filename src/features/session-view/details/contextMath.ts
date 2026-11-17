// What the session rail's Context card and the composer's context ring both work out from a
// session's usage: the categories of get_context_usage sorted the way Claude Code desktop lists
// them, and how far auto-compact is.
import { compact } from "@/lib/format"
import type { Session } from "@/lib/model"

export type Ctx = NonNullable<Session["usage"]["context"]>
type Cat = Ctx["categories"][number]

/** Rounded down to 2 significant digits ("120k until auto-compact"). */
export const twoDigits = (n: number) => {
  const p = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, n))) - 1)
  return Math.floor(n / p) * p
}

/** "120k until auto-compact", "Auto-compacts soon", or null when it can't be told. */
export const compactHint = (left: number | null) => (left === null ? null : left < 30_000 ? "Auto-compacts soon" : `${compact(twoDigits(left))} until auto-compact`)

export const severity = (pct: number) => (pct >= 90 ? "var(--cc-danger-fill)" : pct >= 75 ? "var(--cc-warn)" : "var(--cc-accent)")

const isFree = (c: Cat) => c.kind === "free" || /^free space$/i.test(c.name)
const isBuffer = (c: Cat) => c.kind === "buffer" || /compact buffer/i.test(c.name)
const isDeferred = (c: Cat) => !!c.deferred || c.kind === "deferred" || /\(deferred\)$/i.test(c.name)

export interface Breakdown {
  /** ordinary categories, largest first; the first 6 get their own meter colour (index), the rest share "Other" */
  used: (Cat & { series: number | null })[]
  /** the meter's segments: up to 6 categories, then "Other" */
  segments: { name: string; tokens: number; series: number | null }[]
  buffer?: Cat
  free?: Cat
  deferred: Cat[]
  /** tokens left before auto-compact starts (null: auto-compact is off or the window is unknown) */
  untilCompact: number | null
}

export function breakdown(c: Ctx): Breakdown {
  const ordinary = c.categories.filter((x) => x.tokens > 0 && !isFree(x) && !isBuffer(x) && !isDeferred(x)).sort((a, b) => b.tokens - a.tokens)
  // six colours; with more categories the sixth slot becomes "Other"
  const own = ordinary.length > 6 ? 5 : 6
  const used = ordinary.map((x, i) => ({ ...x, series: i < own ? i : null }))
  const segments: Breakdown["segments"] = used.filter((x) => x.series !== null).map((x) => ({ name: x.name, tokens: x.tokens, series: x.series }))
  const rest = used.filter((x) => x.series === null).reduce((n, x) => n + x.tokens, 0)
  if (rest > 0) segments.push({ name: "Other", tokens: rest, series: null })
  const buffer = c.categories.find(isBuffer)
  const free = c.categories.find(isFree)
  const deferred = c.categories.filter((x) => isDeferred(x) && x.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const untilCompact = buffer && c.max > 0 ? Math.max(0, c.max - buffer.tokens - c.used) : null
  return { used, segments, buffer, free, deferred, untilCompact }
}
