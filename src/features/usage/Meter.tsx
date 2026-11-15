import { cn } from "@/lib/utils"

/** A limit meter: neutral until 75 %, amber above, red from 90 %; the number is always shown. */
export function Meter({ label, percent, sub }: { label: string; percent: number; sub?: string }) {
  const p = Math.max(0, Math.min(100, percent))
  const fill = p >= 90 ? "bg-st-error" : p >= 75 ? "bg-st-input" : "bg-foreground/80"
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="tabular font-medium">{Math.round(p)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)} aria-label={label}>
        <div className={cn("h-full rounded-full", fill)} style={{ width: `${p}%` }} />
      </div>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}

/** "resets in 2h 53m" */
export function until(iso: string | null | undefined, now: number) {
  if (!iso) return ""
  const ms = Date.parse(iso) - now
  if (ms <= 0) return "resets now"
  const h = Math.floor(ms / 3600e3)
  const m = Math.round((ms % 3600e3) / 60e3)
  return h >= 24 ? `resets in ${Math.floor(h / 24)}d ${h % 24}h` : h ? `resets in ${h}h ${m}m` : `resets in ${m}m`
}
