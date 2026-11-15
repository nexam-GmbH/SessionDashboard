import { IN_TAURI } from "@/lib/platform"

/**
 * Which backend runs: real Claude Code sessions in the desktop app, the mock world in the browser
 * (and in the desktop app with `?mock=1`, for screenshots and design work).
 */
export const REAL = IN_TAURI && !(typeof location !== "undefined" && new URLSearchParams(location.search).has("mock"))

/**
 * A session in its own window (`?popout=<session id>`): it shows that one session, reads Claude Code
 * like the main window, attaches to the sessions the app runs, and leaves notifications, settings,
 * machines and the cloud to the main window.
 */
export const POPOUT: string | null = (() => {
  try {
    return typeof location !== "undefined" ? new URLSearchParams(location.search).get("popout") : null
  } catch {
    return null
  }
})()
