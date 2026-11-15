// The sessions that were running when the app last closed. After a reboot, a crash or quitting the
// app, the ones not running any more are offered back in one go (with a choice of which).
import { create } from "zustand"
import type { ID, Session } from "@/lib/model"
import { getApp, useApp } from "@/store/app"

const KEY = "sd.running"
const MAX_AGE = 7 * 24 * 3600_000

export const useRestore = create<{ ids: ID[]; at: number } | null>(() => null)

const running = (s: Session) => !s.archived && !s.machine && (s.control === "owned" || (s.control === "observed" && s.status !== "stopped"))

function read(): { at: number; ids: ID[] } | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { at: number; ids: ID[] } | null
    return v && Array.isArray(v.ids) ? v : null
  } catch {
    return null
  }
}

/** Once the first list is in: offer what ran last time and runs no more; then keep the list current. */
export function startRestore() {
  const prev = read()
  const st = getApp()
  if (prev && Date.now() - prev.at < MAX_AGE) {
    const ids = prev.ids.filter((id) => st.sessions[id] && !running(st.sessions[id]) && !st.sessions[id].archived)
    if (ids.length) useRestore.setState({ ids, at: prev.at }, true)
  }
  let last = ""
  const save = () => {
    const ids = Object.values(getApp().sessions).filter(running).map((s) => s.id).sort()
    const key = ids.join(",")
    if (key === last) return
    last = key
    try {
      localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), ids }))
    } catch {
      /* storage unavailable */
    }
  }
  save()
  useApp.subscribe((s) => s.statusVersion + s.structVersion * 1e6, save)
}
