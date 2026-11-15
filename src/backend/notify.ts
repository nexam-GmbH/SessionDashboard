// System notifications for the desktop app, kept rare enough to stay trusted:
// - only what blocks a session (a permission, a question, an error) alerts; a finished turn is a badge
//   in the list unless Settings → Notifications asks for it too
// - a quiet 10 s first: a prompt answered in the terminal, or one that resolves itself, never pings
// - at most 2 single alerts in 10 minutes and 6 an hour; more become one summary of what still waits
// - never while the window is in front, never for a muted repo, never stealing focus
import type { SessionStatus } from "@/lib/model"
import { OS } from "@/lib/platform"
import { getApp, useApp } from "@/store/app"

type Kind = "permission" | "question" | "finished" | "error"
const KIND: Partial<Record<SessionStatus, Kind>> = { waiting_permission: "permission", waiting_input: "question", error: "error", done_unseen: "finished" }

const QUIET_MS = 10_000
const WINDOW_SHORT = 10 * 60_000
const MAX_SHORT = 2
const WINDOW_HOUR = 60 * 60_000
const MAX_HOUR = 6

let api: typeof import("@tauri-apps/plugin-notification") | null = null
let listening = false
/** pending alerts: session → timer, started when it began waiting */
const pending = new Map<string, ReturnType<typeof setTimeout>>()
/** sessions held back by the budget, sent later as one summary */
const held = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
const sent: number[] = []

/** A click on a notification brings the window forward on that session. */
async function listenClicks() {
  if (listening || !api) return
  listening = true
  try {
    await api.onAction((e) => {
      const id = (e.notification?.extra as { sessionId?: string } | undefined)?.sessionId
      void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        const w = getCurrentWindow()
        await w.unminimize().catch(() => undefined)
        await w.show().catch(() => undefined)
        await w.setFocus().catch(() => undefined)
      })
      void import("@/store/actions").then((a) => (id ? a.openSession(id) : a.goToNextWaiting()))
    })
  } catch {
    /* clicks not reported on this desktop */
  }
}

async function send(title: string, body: string, sessionId?: string) {
  sent.push(Date.now())
  try {
    api ??= await import("@tauri-apps/plugin-notification")
    if (!(await api.isPermissionGranted()) && (await api.requestPermission()) !== "granted") return
    await listenClicks()
    api.sendNotification({
      title,
      body: body.slice(0, 180),
      extra: sessionId ? { sessionId } : undefined,
      // the system's message sound: freedesktop name on Linux, the default sound elsewhere
      sound: getApp().settings.notify.sound ? (OS === "linux" ? "message-new-instant" : "default") : undefined,
    })
  } catch {
    /* no notification service */
  }
}

/** Still worth an alert: waiting the same way, not muted, the window in the background. */
function stillDue(id: string, focusMatters = true): Kind | null {
  const st = getApp()
  const s = st.sessions[id]
  const kind = s && KIND[s.status]
  if (!s || !kind || !st.settings.notify[kind] || s.archived) return null
  if (s.repoId && st.settings.mutedRepos.includes(s.repoId)) return null
  // checked when the alert would go out: you may switch away during the quiet seconds
  if (focusMatters && document.hasFocus()) return null
  return kind
}

function describe(id: string, kind: Kind) {
  const st = getApp()
  const s = st.sessions[id]
  const repo = s.repoId ? st.repos[s.repoId]?.name : undefined
  const body =
    kind === "permission"
      ? `Needs permission: ${s.waitingFor?.summary ?? ""}`
      : kind === "question"
        ? (s.waitingFor?.summary ?? "Waiting for you")
        : kind === "error"
          ? (s.errorMessage ?? "Something went wrong")
          : (s.activity ?? "Finished")
  return { title: repo ? `${repo} · ${s.title}` : s.title, body }
}

function budget() {
  const now = Date.now()
  while (sent.length && now - sent[0] > WINDOW_HOUR) sent.shift()
  const short = sent.filter((t) => now - t < WINDOW_SHORT)
  if (short.length < MAX_SHORT && sent.length < MAX_HOUR) return 0
  // wait until the oldest alert counted against a full window leaves it
  const waitShort = short.length >= MAX_SHORT ? short[short.length - MAX_SHORT] + WINDOW_SHORT - now : 0
  const waitHour = sent.length >= MAX_HOUR ? sent[sent.length - MAX_HOUR] + WINDOW_HOUR - now : 0
  return Math.max(waitShort, waitHour, 60_000)
}

function fire(id: string) {
  pending.delete(id)
  const kind = stillDue(id)
  if (!kind) return
  const wait = budget()
  if (!wait) {
    const d = describe(id, kind)
    void send(d.title, d.body, id)
    return
  }
  held.add(id)
  flushTimer ??= setTimeout(flush, wait)
}

/** The held alerts as one: what still waits by then, the longest-waiting first. */
function flush() {
  flushTimer = null
  const st = getApp()
  const due = [...held].filter((id) => stillDue(id) && KIND[st.sessions[id].status] !== "finished")
  held.clear()
  if (!due.length) return
  due.sort((a, b) => st.sessions[a].statusObservedAt.localeCompare(st.sessions[b].statusObservedAt))
  if (due.length === 1) {
    const d = describe(due[0], stillDue(due[0])!)
    void send(d.title, d.body, due[0])
    return
  }
  const names = due.slice(0, 4).map((id) => st.sessions[id].title)
  void send(`${due.length} sessions need you`, names.join(" · ") + (due.length > 4 ? ` and ${due.length - 4} more` : ""))
}

export function startNotify() {
  let prev = new Map(Object.values(getApp().sessions).map((s) => [s.id, s.status]))
  useApp.subscribe(
    (s) => s.statusVersion,
    () => {
      const st = getApp()
      const now = new Map<string, SessionStatus>()
      for (const s of Object.values(st.sessions)) {
        now.set(s.id, s.status)
        const was = prev.get(s.id)
        if (was === s.status || was === undefined) continue
        // the state changed: an alert waiting for the old one no longer applies
        const t = pending.get(s.id)
        if (t) {
          clearTimeout(t)
          pending.delete(s.id)
        }
        held.delete(s.id)
        if (KIND[s.status] && stillDue(s.id, false)) pending.set(s.id, setTimeout(() => fire(s.id), QUIET_MS))
      }
      prev = now
    },
  )
}
