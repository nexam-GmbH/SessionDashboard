// Above the overview while sessions sit at the usage limit: which ones, when the limit resets, and
// "Continue at reset" for the ones you tick, in list order, staggered. With another Claude account
// set up, "Continue now on…" carries them on there instead (each a fork on that account), the
// account with the most room first.
import { useState } from "react"
import { ChevronDown, Hourglass } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useShallow } from "zustand/react/shallow"
import { useApp } from "@/store/app"
import { useNow } from "@/components/common/RelativeTime"
import { limitsFor, resetOf, useUsage } from "@/features/usage/usageData"
import { plural, clockTime } from "@/lib/format"
import { accountKey, accountLabel } from "@/lib/accounts"
import { AccountItems, useAccountChoices, useHasAccounts } from "@/features/accounts/AccountItems"
import { cancelContinue, parkedAtLimit, scheduleContinue, useParkedPlan } from "./parked"

export function ParkedCard() {
  // only the parked sessions themselves: any other session changing does not render this again
  const ids = useApp(useShallow((s) => Object.values(s.sessions).filter(parkedAtLimit).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).map((x) => x.id)))
  const parked = useApp(useShallow((s) => ids.map((id) => s.sessions[id])))
  const repos = useApp((s) => s.repos)
  const usage = useUsage()
  const plan = useParkedPlan()
  const now = useNow()
  const [off, setOff] = useState<Set<string>>(() => new Set())
  const [open, setOpen] = useState(false)
  const hasAccounts = useHasAccounts()
  const chosen = ids.filter((id) => !off.has(id))
  // the accounts the chosen sessions could go to: not one they all are on already
  const chosenKeys = [...new Set(parked.filter((s) => s && !off.has(s.id)).map((s) => accountKey(s.configDir)))]
  const choices = useAccountChoices(chosenKeys.length === 1 ? chosenKeys : [])
  if (!ids.length && !plan) return null
  // each session's own account decides when it can go on; the card waits for the last of them
  const resetFor = (configDir?: string) => resetOf(limitsFor(usage, configDir))
  const resets = parked.filter((s) => s && !off.has(s.id)).map((s) => resetFor(s.configDir))
  const known = resets.filter((r): r is number => r != null)
  const resetAt = known.length ? Math.max(...known) : null
  const mixed = new Set(parked.map((s) => accountKey(s?.configDir))).size > 1
  // only sessions on this computer can move to another account
  const movable = chosen.filter((id) => !parked[ids.indexOf(id)]?.machine)
  return (
    <section aria-label="Sessions at the usage limit" className="mx-auto mt-4 flex w-[min(720px,calc(100%-2rem))] flex-col gap-2 rounded-xl bg-card px-4 py-3 text-sm ring-1 ring-foreground/10">
      <header className="flex items-center gap-2">
        <Hourglass size={15} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          {plan
            ? `${plural(plan.ids.length, "session")} will continue${plan.dir !== undefined ? ` on ${accountLabel(plan.dir)}` : ""} from ${clockTime(new Date(plan.at).toISOString())}, one every 45 s.`
            : `${plural(ids.length, "session")} stopped at the usage limit${resetAt ? `; ${mixed ? "the last" : "it"} resets at ${clockTime(new Date(resetAt).toISOString())}` : ""}.`}
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
            {hasAccounts && choices.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="xs" variant="outline" disabled={!movable.length} title="Carry the conversation on with another Claude account now, one session every 45 seconds">
                    Continue now on… <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80">
                  <DropdownMenuLabel>Continue {plural(movable.length, "session")} on</DropdownMenuLabel>
                  <AccountItems choices={choices} onPick={(dir) => scheduleContinue(movable, 0, dir)} />
                  <DropdownMenuLabel className="whitespace-normal">The first message reads each conversation again, on that account&apos;s limit. The old sessions are archived.</DropdownMenuLabel>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
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
          {ids.map((id, i) => {
            const s = parked[i]
            if (!s) return null
            const own = mixed ? resetFor(s.configDir) : null
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
                  {hasAccounts && <span className="shrink-0 font-mono text-xs text-muted-foreground">{accountLabel(s.configDir)}</span>}
                  {own != null && <span className="shrink-0 text-xs text-muted-foreground">resets {clockTime(new Date(own).toISOString())}</span>}
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
