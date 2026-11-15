// Context ring at the right end of the row under the prompt box. Claude Code desktop moved context
// % into a side panel and users asked for it back next to the composer, so it
// stays here: a small ring that turns amber at 80% and red at 90%, details and "Compact now" on click.
// Beside it, once the prompt cache has expired on a large conversation, "Cold cache": the next message
// pays to write the whole conversation to the cache again.
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { useApp } from "@/store/app"
import { sendMessage } from "@/store/actions"
import { compact, usd } from "@/lib/format"
import type { ID } from "@/lib/model"
import { minutes, useCache } from "./cache"

const WINDOW_TOKENS = 200_000

export function ContextRing({ sessionId, canCompact }: { sessionId: ID; canCompact: boolean }) {
  const usage = useApp((s) => s.sessions[sessionId]?.usage)
  const cache = useCache(sessionId)
  if (!usage) return null
  // a session in your terminal has no context report: its newest call's size stands in
  const win = cache && cache.tokens > WINDOW_TOKENS ? 1_000_000 : WINDOW_TOKENS
  const pct = Math.max(0, Math.min(100, usage.contextPct || (cache ? Math.round((cache.tokens / win) * 100) : 0)))
  const cold = !!cache && !cache.warm && !!cache.cost && cache.cost.cold >= 0.25
  const color = pct >= 90 ? "var(--st-error)" : pct >= 80 ? "var(--st-input)" : "color-mix(in oklab, var(--muted-foreground) 70%, transparent)"
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Context ${pct}% used${cold ? ", prompt cache expired" : ""}`}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
            <circle cx="8" cy="8" r={r} fill="none" stroke="var(--border)" strokeWidth="2" />
            <circle cx="8" cy="8" r={r} fill="none" stroke={color} strokeWidth="2" strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round" />
          </svg>
          {pct >= 80 && <span className="tabular" style={{ color }}>{pct}%</span>}
          {cold && <span>Cold cache</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-64 gap-2 border border-border bg-muted p-3 text-xs shadow-[0_10px_28px_rgba(0,0,0,0.5)] ring-0">
        <div className="flex items-baseline justify-between">
          <span className="font-medium text-foreground">Context</span>
          <span className="tabular text-muted-foreground">{pct}%</span>
        </div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-accent">
          <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: color }} />
        </div>
        <div className="tabular flex justify-between text-xs text-muted-foreground/70">
          <span>
            {compact(Math.round((pct / 100) * win))} of {compact(win)} tokens
          </span>
          <span>{usd(usage.costUsd)}</span>
        </div>
        {cache?.cost && (
          <p className="text-xs text-muted-foreground">
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
          <p className="text-xs text-muted-foreground">Every message re-reads all {compact(cache.tokens)} tokens. A fresh session with a short brief is cheaper and often more focused.</p>
        )}
        {canCompact && (
          <Button size="sm" variant="outline" className="mt-1 self-start" onClick={() => sendMessage(sessionId, "/compact", "now")}>
            Compact now
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
