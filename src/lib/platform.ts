import { isTauri } from "@tauri-apps/api/core"

export type OsType = "macos" | "windows" | "linux"

export const IN_TAURI = (() => {
  try {
    return isTauri()
  } catch {
    return false
  }
})()

export const OS: OsType = (() => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
  if (/Mac/.test(ua)) return "macos"
  if (/Win/.test(ua)) return "windows"
  return "linux"
})()
