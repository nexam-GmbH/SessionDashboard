import { IN_TAURI } from "@/lib/platform"

/**
 * Which backend runs: real Claude Code sessions in the desktop app, the mock world in the browser
 * (and in the desktop app with `?mock=1`, for screenshots and design work).
 */
export const REAL = IN_TAURI && !(typeof location !== "undefined" && new URLSearchParams(location.search).has("mock"))
