// Sessions stopping at the usage limit: the limits are asked again at once, and with Settings →
// Accounts → Switch accounts at the limit on, the whole app switches to the account with the most
// room (under the threshold, not at a limit itself), then continues the sessions that stopped, one
// every 45 s. At most one switch in 30 minutes (no ping-pong); with no account free nothing changes
// and the limit card offers "Continue at reset" as before.
import { getApp, useApp } from "@/store/app"
import type { Session } from "@/lib/model"
import { accountName, accountsOf, activeAccountOf } from "@/lib/accounts"
import { pushNotification } from "@/store/actions"
import {
  atLimit,
  fiveHourOf,
  limitsFor,
  refreshLimitsSoon,
  useUsage,
} from "@/features/usage/usageData"
import { parkedAtLimit, scheduleContinue } from "@/features/overview/parked"
import { setActiveAccount } from "./accountState"

const QUIET_MS = 30 * 60_000
/** a session just stopped: a moment for its state to settle (and others that stop with it) */
const SETTLE_MS = 3000

let parked = new Set<string>()
let lastSwitch = 0
let timer: ReturnType<typeof setTimeout> | undefined
let started = false

export function startAccountWatch() {
  if (started) return
  started = true
  useApp.subscribe((st, prev) => {
    if (st.sessions !== prev.sessions) check()
  })
}

/** Sessions the app runs on this computer: the ones that continue on another account. */
const mine = (s: Session) =>
  s.control === "owned" && !s.machine && s.role !== "main"

function check() {
  const st = getApp()
  const now = Object.values(st.sessions).filter(parkedAtLimit)
  const fresh = now.filter((s) => !parked.has(s.id))
  parked = new Set(now.map((s) => s.id))
  if (!fresh.length) return
  refreshLimitsSoon()
  if (
    !(st.settings.autoSwitchAccount > 0) ||
    !(st.settings.accounts ?? []).length ||
    !fresh.some(mine)
  )
    return
  clearTimeout(timer)
  timer = setTimeout(switchNow, SETTLE_MS)
}

/**
 * The account with the most room in its 5-hour window, under `threshold` and at no limit, not the
 * active one. An account whose limits are not known yet (no message sent on it so far) comes after
 * the known ones.
 */
export function pickAccount(threshold: number): string | undefined {
  const st = getApp()
  const usage = useUsage.getState()
  const active = activeAccountOf(st)
  return accountsOf(st)
    .filter((a) => a.id !== active)
    .map((a) => ({ id: a.id, l: limitsFor(usage, a.id) }))
    .filter(
      (x) =>
        !x.l || (!atLimit(x.l) && (fiveHourOf(x.l)?.percent ?? 0) < threshold)
    )
    .sort(
      (x, y) =>
        Number(!x.l) - Number(!y.l) ||
        (fiveHourOf(x.l)?.percent ?? 0) - (fiveHourOf(y.l)?.percent ?? 0)
    )[0]?.id
}

function switchNow() {
  const st = getApp()
  const threshold = st.settings.autoSwitchAccount
  if (!threshold || Date.now() - lastSwitch < QUIET_MS) return
  const stopped = Object.values(st.sessions).filter(
    (s) => parkedAtLimit(s) && mine(s)
  )
  if (!stopped.length) return
  const to = pickAccount(threshold)
  if (to === undefined) return
  lastSwitch = Date.now()
  const name = accountName(st, to)
  setActiveAccount(to, { note: "Limit reached, switched to" })
  // each continues on the new account with "continue" (its process restarts under the new token)
  scheduleContinue(
    stopped
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((s) => s.id),
    0
  )
  pushNotification({
    sessionId: stopped[0].id,
    kind: "finished",
    title: "Usage limit",
    body: `Limit reached, switched to ${name}`,
    createdAt: new Date().toISOString(),
  })
}
