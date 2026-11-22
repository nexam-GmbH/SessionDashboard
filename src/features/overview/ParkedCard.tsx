// Above the overview while sessions sit at the usage limit: which ones, when the limit resets, and
// "Continue at reset" for the ones you tick, in list order, staggered. With another Claude account
// set up, "Switch and continue" makes another account the active one (the one with the most room
// first) and continues them there now: same sessions, same history.
import { useState } from "react"
import { ChevronDown, Hourglass } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useShallow } from "zustand/react/shallow"
import { getApp, useApp } from "@/store/app"
import { useNow } from "@/components/common/RelativeTime"
import { limitsFor, resetOf, useUsage } from "@/features/usage/usageData"
import { plural, clockTime } from "@/lib/format"
import { accountName } from "@/lib/accounts"
import { AccountItems, useAccountChoices, useHasAccounts } from "@/features/accounts/AccountItems"
import { setActiveAccount, useActiveAccount } from "@/features/accounts/accountState"
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
  const active = useActiveAccount()
  const chosen = ids.filter((id) => !off.has(id))
  // every account but the active one, the one with the most room first
  const choices = useAccountChoices([active], true)
  if (!ids.length && !plan) return null
  // the account a session ran on decides when it can go on; the card waits for the last of them
  const resetFor = (s?: { accountId?: string }) => resetOf(limitsFor(usage, s?.accountId ?? active))
  const resets = parked.filter((s) => s && !off.has(s.id)).map((s) => resetFor(s))
  const known = resets.filter((r): r is number => r != null)
  const resetAt = known.length ? Math.max(...known) : null
  const mixed = new Set(parked.map((s) => s?.accountId ?? active)).size > 1
  // sessions on this computer continue on another account; a server's keep its login
  const movable = chosen.filter((id) => !parked[ids.indexOf(id)]?.machine)
  const switchTo = (id: string) => {
    setActiveAccount(id, { note: "Switched to" })
    scheduleContinue(movable, 0)
  }
  return (
    <section aria-label="Sessions at the usage limit" className="mx-auto mt-4 flex w-[min(720px,calc(100%-2rem))] flex-col gap-2 rounded-xl bg-card px-4 py-3 text-sm ring-1 ring-foreground/10">
      <header className="flex items-center gap-2">
        <Hourglass size={15} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          {plan
            ? `${plural(plan.ids.length, "session")} will continue from ${clockTime(new Date(plan.at).toISOString())}, one every 45 s.`
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
                  <Button size="xs" variant="outline" disabled={!movable.length} title="Make another Claude account the active one and continue these sessions there now, one every 45 seconds">
                    Switch and continue <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80">
                  <DropdownMenuLabel>Switch to, and continue {plural(movable.length, "session")}</DropdownMenuLabel>
                  <AccountItems choices={choices} onPick={switchTo} check={false} />
                  <DropdownMenuLabel className="whitespace-normal">Same sessions, same history. The first message reads each conversation again, on that account&apos;s limit.</DropdownMenuLabel>
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
            const own = mixed ? resetFor(s) : null
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
                  {hasAccounts && <span className="shrink-0 text-xs text-muted-foreground">{accountName(getApp(), s.accountId ?? active)}</span>}
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
