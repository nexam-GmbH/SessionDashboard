// System notifications for the desktop app: when a session starts needing you (a permission, a
// question, an error) or finishes, and this window is not in front. Follows Settings →
// Notifications (kinds, muted projects); at most one per session every 20 s.
import type { SessionStatus } from "@/lib/model"
import { getApp, useApp } from "@/store/app"

type Kind = "permission" | "question" | "finished" | "error"
const KIND: Partial<Record<SessionStatus, Kind>> = { waiting_permission: "permission", waiting_input: "question", error: "error", done_unseen: "finished" }

const last = new Map<string, number>()
let api: typeof import("@tauri-apps/plugin-notification") | null = null

let listening = false

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
      if (id) void import("@/store/actions").then((a) => a.openSession(id))
    })
  } catch {
    /* clicks not reported on this desktop */
  }
}

async function send(title: string, body: string, sessionId?: string) {
  try {
    api ??= await import("@tauri-apps/plugin-notification")
    if (!(await api.isPermissionGranted()) && (await api.requestPermission()) !== "granted") return
    await listenClicks()
    api.sendNotification({ title, body, extra: sessionId ? { sessionId } : undefined })
  } catch {
    /* no notification service */
  }
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
        const kind = KIND[s.status]
        if (!kind || was === s.status || was === undefined) continue
        if (!st.settings.notify[kind]) continue
        if (s.repoId && st.settings.mutedRepos.includes(s.repoId)) continue
        // in front: the window itself shows it
        if (document.hasFocus()) continue
        const t = last.get(s.id) ?? 0
        if (Date.now() - t < 20_000) continue
        last.set(s.id, Date.now())
        const repo = s.repoId ? st.repos[s.repoId]?.name : undefined
        const body =
          kind === "permission" ? `Needs permission: ${s.waitingFor?.summary ?? ""}` : kind === "question" ? (s.waitingFor?.summary ?? "Waiting for you") : kind === "error" ? (s.errorMessage ?? "Something went wrong") : (s.activity ?? "Finished")
        void send(repo ? `${repo} · ${s.title}` : s.title, body.slice(0, 180), s.id)
      }
      prev = now
    },
  )
}
