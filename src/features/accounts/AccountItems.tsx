// The accounts a session can continue on, as menu items: each with its 5-hour and weekly use, the
// one with the most room first; an account at its limit is shown but cannot be picked.
import { useShallow } from "zustand/react/shallow"
import { UserRound } from "lucide-react"
import { DropdownMenuItem, MENU_HINT } from "@/components/ui/dropdown-menu"
import { useApp } from "@/store/app"
import { accountsOf, accountKey, type Account } from "@/lib/accounts"
import { atLimit, fiveHourOf, limitsFor, useUsage, weeklyOf } from "@/features/usage/usageData"
import type { Limits } from "@/features/usage/usageData"

export interface AccountChoice extends Account {
  limits?: Limits
  five?: number
  week?: number
  full: boolean
}

/** Every account but `except` (account keys), with its limits, the one with the most room first. */
export function useAccountChoices(except: readonly string[] = []): AccountChoice[] {
  const dirs = useApp(useShallow((st) => st.settings.claudeConfigDirs ?? []))
  const usage = useUsage()
  return accountsOf(dirs)
    .filter((a) => !except.includes(a.key))
    .map((a) => {
      const limits = limitsFor(usage, a.dir)
      return { ...a, limits, five: fiveHourOf(limits)?.percent, week: weeklyOf(limits)?.percent, full: atLimit(limits) }
    })
    .sort((a, b) => Number(a.full) - Number(b.full) || (a.five ?? 101) - (b.five ?? 101))
}

/** Whether more than one account is set up (otherwise nothing about accounts shows). */
export function useHasAccounts() {
  return useApp((st) => (st.settings.claudeConfigDirs ?? []).some((d) => accountKey(d) !== ""))
}

const pct = (p?: number) => (p == null ? "–" : `${Math.min(100, Math.max(0, Math.round(p)))}%`)

/** "5 h 12% · week 30%", or why it can't be picked. */
export function limitLine(a: AccountChoice) {
  if (!a.limits) return "limits not known yet"
  return `${a.full ? "at its limit · " : ""}5 h ${pct(a.five)} · week ${pct(a.week)}`
}

export function AccountItems({ choices, onPick }: { choices: AccountChoice[]; onPick: (dir: string) => void }) {
  return choices.map((a) => <AccountItem key={a.key} a={a} onPick={onPick} />)
}

function AccountItem({ a, onPick }: { a: AccountChoice; onPick: (dir: string) => void }) {
  const line = limitLine(a)
  return (
    <DropdownMenuItem disabled={a.full} onSelect={() => onPick(a.dir)} aria-label={`${a.label}, ${line}`} title={a.full ? "This account is at its usage limit too" : undefined}>
      <UserRound />
      <span className="truncate font-mono text-[13px]">{a.label}</span>
      <span className={MENU_HINT}>{line}</span>
    </DropdownMenuItem>
  )
}
