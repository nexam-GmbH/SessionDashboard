// Above the overview while sessions sit at the usage limit: which ones, when the limit resets, and
// "Continue at reset" for the ones you tick, in list order, staggered.
import { useMemo, useState } from "react"
import { Hourglass } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useApp } from "@/store/app"
import { useNow } from "@/components/common/RelativeTime"
import { useUsage } from "@/features/usage/usageData"
import { plural, clockTime } from "@/lib/format"
import { cancelContinue, parkedAtLimit, scheduleContinue, useParkedPlan } from "./parked"

export function ParkedCard() {
  const sessions = useApp((s) => s.sessions)
  const repos = useApp((s) => s.repos)
  const ids = useMemo(() => Object.values(sessions).filter(parkedAtLimit).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).map((s) => s.id), [sessions])
  const limits = useUsage((s) => s.limits?.limits)
  const plan = useParkedPlan()
  const now = useNow()
  const [off, setOff] = useState<Set<string>>(() => new Set())
  const [open, setOpen] = useState(false)
  if (!ids.length && !plan) return null
  // the limit that is used up decides when work can go on; else the 5-hour window
  const spent = limits?.filter((l) => l.percent >= 99 && l.resets_at) ?? []
  const pick = spent.length ? spent : (limits?.filter((l) => l.group === "session" && l.resets_at) ?? [])
  const resetAt = pick.length ? Math.max(...pick.map((l) => Date.parse(l.resets_at!))) : null
  const chosen = ids.filter((id) => !off.has(id))
  return (
    <section aria-label="Sessions at the usage limit" className="mx-auto mt-4 flex w-[min(720px,calc(100%-2rem))] flex-col gap-2 rounded-xl bg-card px-4 py-3 text-sm ring-1 ring-foreground/10">
      <header className="flex items-center gap-2">
        <Hourglass size={15} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          {plan
            ? `${plural(plan.ids.length, "session")} will continue from ${clockTime(new Date(plan.at).toISOString())}, one every 45 s.`
            : `${plural(ids.length, "session")} stopped at the usage limit${resetAt ? `; it resets at ${clockTime(new Date(resetAt).toISOString())}` : ""}.`}
        </span>
        {plan ? (
          <Button size="xs" variant="ghost" onClick={cancelContinue}>
            Cancel
          </Button>
        ) : (
          <>
            <Button size="xs" variant="ghost" onClick={() => setOpen((v) => !v)}>
              {open ? "Hide" : "Choose"}
            </Button>
            <Button
              size="xs"
              disabled={!chosen.length}
              title="In this order, one every 45 seconds, starting a minute after the reset"
              onClick={() => scheduleContinue(chosen, resetAt && resetAt > now ? resetAt + 60_000 : 0)}
            >
              {resetAt && resetAt > now ? "Continue at reset" : "Continue now"}
            </Button>
          </>
        )}
      </header>
      {open && !plan && (
        <ul className="flex flex-col gap-1 pl-6">
          {ids.map((id) => {
            const s = sessions[id]
            return (
              <li key={id}>
                <label className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    checked={!off.has(id)}
                    onCheckedChange={(v) =>
                      setOff((prev) => {
                        const next = new Set(prev)
                        if (v) next.delete(id)
                        else next.add(id)
                        return next
                      })
                    }
                  />
                  <span className="min-w-0 truncate">{s.title}</span>
                  {s.repoId && <span className="shrink-0 text-xs text-muted-foreground">{repos[s.repoId]?.name}</span>}
                  {s.control === "observed" && <span className="shrink-0 text-xs text-muted-foreground">· moves from the terminal to the app</span>}
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
