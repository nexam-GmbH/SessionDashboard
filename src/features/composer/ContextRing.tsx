// Context ring at the right end of the row under the prompt box. Claude Code desktop moved context
// % into a side panel and users asked for it back next to the composer (RESEARCH §11.5), so it
// stays here: a small ring that turns amber at 80% and red at 90%, details and "Compact now" on click.
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { useApp } from "@/store/app"
import { sendMessage } from "@/store/actions"
import { compact, usd } from "@/lib/format"
import type { ID } from "@/lib/model"

const WINDOW_TOKENS = 200_000

export function ContextRing({ sessionId, canCompact }: { sessionId: ID; canCompact: boolean }) {
  const usage = useApp((s) => s.sessions[sessionId]?.usage)
  if (!usage) return null
  const pct = Math.max(0, Math.min(100, usage.contextPct))
  const color = pct >= 90 ? "var(--st-error)" : pct >= 80 ? "var(--st-input)" : "color-mix(in oklab, var(--muted-foreground) 70%, transparent)"
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Context ${pct}% used`}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
            <circle cx="8" cy="8" r={r} fill="none" stroke="var(--border)" strokeWidth="2" />
            <circle cx="8" cy="8" r={r} fill="none" stroke={color} strokeWidth="2" strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round" />
          </svg>
          {pct >= 80 && <span className="tabular" style={{ color }}>{pct}%</span>}
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
            {compact(Math.round((pct / 100) * WINDOW_TOKENS))} of {compact(WINDOW_TOKENS)} tokens
          </span>
          <span>{usd(usage.costUsd)}</span>
        </div>
        {canCompact && (
          <Button size="sm" variant="outline" className="mt-1 self-start" onClick={() => sendMessage(sessionId, "/compact", "now")}>
            Compact now
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
