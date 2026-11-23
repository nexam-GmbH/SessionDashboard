// Accounts as menu items (the footer's switcher, the limit card): e-mail, plan, the 5-hour and weekly
// use as two thin bars, a check on the active one. An account at its limit is marked, still pickable.
import { Check } from "lucide-react"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { useApp } from "@/store/app"
import { accountTitle, type AccountView } from "@/lib/accounts"
import {
  atLimit,
  fiveHourOf,
  limitsFor,
  useUsage,
  weeklyOf,
  type Limits,
} from "@/features/usage/usageData"
import { severity } from "@/features/session-view/details/contextMath"
import { cn } from "@/lib/utils"
import { useAccounts, useActiveAccount } from "./accountState"

export interface AccountChoice extends AccountView {
  limits?: Limits
  five?: number
  week?: number
  full: boolean
}

/** Every account with its limits; `except` (ids) left out; `byRoom`: the one with the most room first. */
export function useAccountChoices(
  except: readonly string[] = [],
  byRoom = false
): AccountChoice[] {
  const accounts = useAccounts()
  const usage = useUsage()
  const list = accounts
    .filter((a) => !except.includes(a.id))
    .map((a) => {
      const limits = limitsFor(usage, a.id)
      return {
        ...a,
        limits,
        five: fiveHourOf(limits)?.percent,
        week: weeklyOf(limits)?.percent,
        full: atLimit(limits),
      }
    })
  return byRoom
    ? list.sort(
        (a, b) =>
          Number(a.full) - Number(b.full) || (a.five ?? 101) - (b.five ?? 101)
      )
    : list
}

/** Whether accounts beside your normal login are set up (else the UI stays as it was). */
export function useHasAccounts() {
  return useApp((st) => (st.settings.accounts ?? []).length > 0)
}

const pct = (p?: number) =>
  p == null ? "–" : `${Math.min(100, Math.max(0, Math.round(p)))}%`

/** "5 h 12% · week 30%", or that it is not known yet. */
export function limitLine(a: AccountChoice) {
  if (!a.limits)
    return a.login
      ? "limits not known yet"
      : "limits show after its first message"
  return `${a.full ? "at its limit · " : ""}5 h ${pct(a.five)} · week ${pct(a.week)}`
}

/** A thin use bar (blue, amber from 75 %, red from 90 %). */
export function Bar({ p, label }: { p?: number; label: string }) {
  const v = Math.min(100, Math.max(0, p ?? 0))
  return (
    <span
      className="flex min-w-0 flex-1 items-center gap-1.5"
      title={`${label}: ${pct(p)}`}
    >
      <span className="w-7 shrink-0 text-[11px] text-muted-foreground/70">
        {label}
      </span>
      <span
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-cc-wash-2"
        role="img"
        aria-label={`${label} ${pct(p)} used`}
      >
        {p != null && (
          <span
            className="block h-full rounded-full"
            style={{ width: `${v}%`, background: severity(v) }}
          />
        )}
      </span>
    </span>
  )
}

export function AccountItems({
  choices,
  onPick,
  check = true,
}: {
  choices: AccountChoice[]
  onPick: (id: string) => void
  check?: boolean
}) {
  const active = useActiveAccount()
  return choices.map((a) => (
    <DropdownMenuItem
      key={a.id || "login"}
      onSelect={() => onPick(a.id)}
      aria-label={`${accountTitle(a)}, ${limitLine(a)}${a.id === active ? ", active" : ""}`}
      className="flex-col items-stretch gap-1 py-1.5"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-[13px]">{accountTitle(a)}</span>
        {a.plan && (
          <span className="shrink-0 text-[11px] text-muted-foreground/70">
            {a.plan}
          </span>
        )}
        {a.full && (
          <span className="shrink-0 rounded-sm bg-st-error/15 px-1 text-[11px] text-st-error-fg">
            at limit
          </span>
        )}
        {a.invalid && (
          <span className="shrink-0 rounded-sm bg-st-error/15 px-1 text-[11px] text-st-error-fg">
            sign-in invalid
          </span>
        )}
        <span className="ml-auto flex size-4 shrink-0 items-center justify-center">
          {check && a.id === active && <Check className="size-3.5" />}
        </span>
      </span>
      {a.limits ? (
        <span className="flex items-center gap-3 pr-6">
          <Bar p={a.five} label="5 h" />
          <Bar p={a.week} label="week" />
        </span>
      ) : (
        <span className={cn("text-[11px] text-muted-foreground/70")}>
          {limitLine(a)}
        </span>
      )}
    </DropdownMenuItem>
  ))
}
