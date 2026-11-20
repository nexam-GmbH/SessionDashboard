// Sessions stopping at the usage limit: the limits are asked again at once (which account has room
// just changed), and with Settings → Sessions → Switch accounts at the limit on, the app's own
// sessions carry on with the account that has the most room, one every 45 s. A session moves by
// itself at most once in 5 hours (no ping-pong); with no account under the threshold nothing moves
// and the limit card offers "Continue at reset" as before.
import { getApp, useApp } from "@/store/app"
import type { ID, Session } from "@/lib/model"
import { accountKey, accountLabel, accountsOf } from "@/lib/accounts"
import { plural } from "@/lib/format"
import { continueOnAccount, pushNotification } from "@/store/actions"
import { atLimit, fiveHourOf, limitsFor, refreshLimitsSoon, useUsage } from "@/features/usage/usageData"
import { couldNotMove, parkedAtLimit } from "@/features/overview/parked"

const WINDOW_MS = 5 * 3600_000
const STAGGER_MS = 45_000
/** a session just stopped: a moment for its state to settle (and fresh limits to arrive) */
const SETTLE_MS = 3000

let parked = new Set<ID>()
const queue: ID[] = []
let running = false
let started = false

export function startAccountWatch() {
  if (started) return
  started = true
  useApp.subscribe((st, prev) => {
    if (st.sessions !== prev.sessions) check()
  })
}

/** Moved by itself in the last 5 hours: stays where it is now. */
function movedLately(s: Session) {
  return !!s.movedFrom?.auto && Date.now() - Date.parse(s.movedFrom.at) < WINDOW_MS
}

/** A session the app started, on this computer: the ones that may move by themselves. */
function mayMove(s: Session) {
  return s.control === "owned" && !s.machine && s.role !== "main" && !movedLately(s)
}

function check() {
  const st = getApp()
  const now = Object.values(st.sessions).filter(parkedAtLimit)
  const fresh = now.filter((s) => !parked.has(s.id))
  parked = new Set(now.map((s) => s.id))
  if (!fresh.length) return
  refreshLimitsSoon()
  if (!(st.settings.autoSwitchAccount > 0) || !(st.settings.claudeConfigDirs ?? []).length) return
  for (const s of fresh) if (mayMove(s) && !queue.includes(s.id)) queue.push(s.id)
  void pump()
}

/** The account with the most room under the threshold, not at a limit itself; none: stay. */
export function pickAccount(s: Session, threshold: number) {
  const own = accountKey(s.configDir)
  const usage = useUsage.getState()
  return accountsOf(getApp().settings.claudeConfigDirs ?? [])
    .filter((a) => a.key !== own)
    .map((a) => ({ a, l: limitsFor(usage, a.dir) }))
    .filter((x) => x.l && !atLimit(x.l) && (fiveHourOf(x.l)?.percent ?? 100) < threshold)
    .sort((x, y) => (fiveHourOf(x.l)?.percent ?? 100) - (fiveHourOf(y.l)?.percent ?? 100))[0]?.a
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function pump() {
  if (running) return
  running = true
  const moved = new Map<string, { dir: string; ids: ID[] }>()
  try {
    await sleep(SETTLE_MS)
    let first = true
    while (queue.length) {
      const id = queue.shift()!
      const s = getApp().sessions[id]
      const threshold = getApp().settings.autoSwitchAccount
      if (!s || !threshold || !parkedAtLimit(s) || !mayMove(s)) continue
      const to = pickAccount(s, threshold)
      if (!to) continue
      if (!first) await sleep(STAGGER_MS)
      first = false
      try {
        const nid = await continueOnAccount(id, to.dir, { prompt: "continue", auto: true })
        if (nid) {
          const m = moved.get(to.key) ?? { dir: to.dir, ids: [] }
          m.ids.push(nid)
          moved.set(to.key, m)
        }
      } catch (e) {
        couldNotMove(s, to.dir, e)
      }
    }
  } finally {
    running = false
  }
  // one quiet line per account: "3 sessions continued on ~/.claude-work"
  for (const m of moved.values()) {
    pushNotification({
      sessionId: m.ids[0],
      kind: "finished",
      title: "Usage limit",
      body: `${plural(m.ids.length, "session")} continued on ${accountLabel(m.dir)}`,
      createdAt: new Date().toISOString(),
    })
  }
  if (queue.length) void pump()
}
