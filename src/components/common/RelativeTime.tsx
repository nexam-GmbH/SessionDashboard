import { useSyncExternalStore } from "react"
import { relTime, dateTime } from "@/lib/format"

/**
 * One shared clock for every relative timestamp (instead of a timer per row).
 * Ticks every 15s; components re-render only when their text changes.
 */
let now = Date.now()
const listeners = new Set<() => void>()
setInterval(() => {
  now = Date.now()
  listeners.forEach((l) => l())
}, 15_000)

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useNow() {
  return useSyncExternalStore(subscribe, () => now)
}

export function useRelTime(iso: string | undefined) {
  return useSyncExternalStore(subscribe, () => relTime(iso, now))
}

export function RelativeTime({ iso, className }: { iso: string | undefined; className?: string }) {
  const text = useRelTime(iso)
  return (
    <time className={className} title={iso ? dateTime(iso) : undefined}>
      {text}
    </time>
  )
}

/** Whole minutes since `iso` once at least `minMs` passed, else null (renders only when it changes). */
export function useQuietMinutes(iso: string | undefined, active: boolean, minMs = 5 * 60_000): number | null {
  return useSyncExternalStore(subscribe, () => {
    if (!active || !iso) return null
    const ms = now - Date.parse(iso)
    return ms >= minMs ? Math.floor(ms / 60_000) : null
  })
}
