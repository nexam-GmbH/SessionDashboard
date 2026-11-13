const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Compact relative time: "now", "42s", "3m", "2h", "4d", "Mar 3". */
export function relTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  const d = now - t
  if (d < 15_000) return "now"
  if (d < MIN) return `${Math.floor(d / 1000)}s`
  if (d < HOUR) return `${Math.floor(d / MIN)}m`
  if (d < DAY) return `${Math.floor(d / HOUR)}h`
  if (d < 30 * DAY) return `${Math.floor(d / DAY)}d`
  return new Date(t).toLocaleDateString("en", { month: "short", day: "numeric" })
}

export function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

export function dateTime(iso: string) {
  const d = new Date(iso)
  return `${d.toLocaleDateString("en", { month: "short", day: "numeric" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
}

export function duration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function usd(n: number) {
  if (n < 0.01) return "$0.00"
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n)}`
}

export function compact(n: number) {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/** Last N path segments: "~/code/api-gateway/src/auth/retry.ts" → "auth/retry.ts" */
export function pathTail(p: string, segments = 2) {
  const parts = p.split("/").filter(Boolean)
  return parts.slice(-segments).join("/")
}

export function homePath(p: string) {
  return p.replace(/^\/home\/[^/]+/, "~")
}
