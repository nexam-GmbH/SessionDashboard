// Context ring at the right end of the row under the prompt box (Claude Code desktop): blue, amber
// from 75 %, red from 90 %; on click the details, what is left until auto-compact and Compact.
// Beside it, once the prompt cache has expired on a large conversation, "Cold cache": the next message
// pays to write the whole conversation to the cache again.
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useApp } from "@/store/app"
import { sendMessage } from "@/store/actions"
import { compact, usd } from "@/lib/format"
import type { ID } from "@/lib/model"
import { cn } from "@/lib/utils"
import { minutes, useCache } from "./cache"
import { GHOST, PANEL } from "./Pickers"

const WINDOW_TOKENS = 200_000
// claude compacts this far before the window ends (room for the reply and its buffer)
const COMPACT_MARGIN = 33_000
/** Rounded down to 2 significant digits (Claude Code desktop's "{tokens} until auto-compact"). */
const twoDigits = (n: number) => {
  const p = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, n))) - 1)
  return Math.floor(n / p) * p
}

export function ContextRing({ sessionId, canCompact }: { sessionId: ID; canCompact: boolean }) {
  const usage = useApp((s) => s.sessions[sessionId]?.usage)
  const working = useApp((s) => s.sessions[sessionId]?.status === "working" || s.sessions[sessionId]?.status === "starting")
  const cache = useCache(sessionId)
  if (!usage) return null
  // a session in your terminal has no context report: its newest call's size stands in
  const win = cache && cache.tokens > WINDOW_TOKENS ? 1_000_000 : WINDOW_TOKENS
  const pct = Math.max(0, Math.min(100, usage.contextPct || (cache ? Math.round((cache.tokens / win) * 100) : 0)))
  const cold = !!cache && !cache.warm && !!cache.cost && cache.cost.cold >= 0.25
  const color = pct >= 90 ? "var(--cc-danger-fill)" : pct >= 75 ? "var(--cc-warn)" : "var(--cc-accent)"
  const left = Math.max(0, win - COMPACT_MARGIN - Math.round((pct / 100) * win))
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Context ${pct}% used${cold ? ", prompt cache expired" : ""}`}
          className={cn(GHOST, cold ? "px-1.5 text-[13px]" : "w-7")}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
            <circle cx="8" cy="8" r={r} fill="none" stroke="var(--cc-wash-2)" strokeWidth="2" />
            <circle cx="8" cy="8" r={r} fill="none" stroke={color} strokeWidth="2" strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round" />
          </svg>
          {cold && <span>Cold cache</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className={cn(PANEL, "w-64 gap-2 p-3 text-[13px]")}>
        <div className="flex items-baseline justify-between">
          <span className="font-medium">Context</span>
          <span className="tabular text-cc-fg2">{pct}%</span>
        </div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-cc-wash-2">
          <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: color }} />
        </div>
        <div className="tabular flex justify-between text-xs text-cc-fg3">
          <span>
            {compact(Math.round((pct / 100) * win))} of {compact(win)} tokens
          </span>
          <span>{usd(usage.costUsd)}</span>
        </div>
        <p className="tabular text-cc-fg2">{left < 30_000 ? "Auto-compacts soon" : `${compact(twoDigits(left))} until auto-compact`}</p>
        {cache?.cost && (
          <p className="text-xs text-cc-fg3">
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
          <p className="text-xs text-cc-fg3">Every message re-reads all {compact(cache.tokens)} tokens. A fresh session with a short brief (Start fresh, in the side panel) is cheaper and often more focused.</p>
        )}
        {canCompact && pct >= 50 && (
          <button
            type="button"
            aria-disabled={working || undefined}
            title={working ? "Available when Claude finishes this turn" : undefined}
            onClick={() => !working && sendMessage(sessionId, "/compact", "now")}
            className={cn(GHOST, "mt-1 self-start bg-cc-wash px-3 text-sm text-[var(--cc-fg)] aria-disabled:opacity-40")}
          >
            Compact
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
