// How large a model's context window is and where auto-compact starts, as Claude Code itself
// reported them (get_context_usage: maxTokens, autoCompactThreshold). Remembered per model, so a
// session that has not been asked yet (one still working, one in your terminal) shows the real
// window instead of a guess. Only a model never seen falls back to the guess.
import { getApp } from "@/store/app"

const KEY = "sd.contextWindows"
/** what a model with no report yet is assumed to have; a call bigger than it means the 1M window */
const GUESS = 200_000
/** where claude compacts when it did not say: this far before the end of the window */
const GUESS_MARGIN = 33_000

interface Known {
  max: number
  /** tokens at which auto-compact starts (absent: auto-compact off or not reported) */
  compactAt?: number
}

let known: Record<string, Known> = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown
    return v && typeof v === "object" ? (v as Record<string, Known>) : {}
  } catch {
    return {}
  }
})()

/** An alias ("opus", "default") as the model id claude runs it as. */
function idOf(model: string | undefined) {
  if (!model) return ""
  return getApp().caps?.models.find((m) => m.value === model)?.resolvedModel ?? model
}

/** Note what claude reported for a model (from a get_context_usage answer). */
export function noteWindow(model: string | undefined, max: number, compactAt?: number) {
  const id = idOf(model)
  if (!id || !(max > 0)) return
  const next: Known = { max, ...(compactAt && compactAt > 0 && compactAt <= max ? { compactAt } : {}) }
  if (known[id]?.max === next.max && known[id]?.compactAt === next.compactAt) return
  known = { ...known, [id]: next }
  try {
    localStorage.setItem(KEY, JSON.stringify(known))
  } catch {
    // private mode or full storage: it is still known until the app restarts
  }
}

/** The context window of `model`; `tokens` (the newest call's size) tells 1M from 200k for an unknown one. */
export function windowOf(model: string | undefined, tokens = 0) {
  return known[idOf(model)]?.max ?? (tokens > GUESS ? 1_000_000 : GUESS)
}

/** Tokens left before auto-compact starts in a window of `win` with `used` in it. */
export function untilCompact(model: string | undefined, win: number, used: number) {
  const k = known[idOf(model)]
  const at = k && k.max === win ? (k.compactAt ?? win - GUESS_MARGIN) : win - GUESS_MARGIN
  return Math.max(0, at - used)
}
