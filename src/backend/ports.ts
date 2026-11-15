// The ports each live session's processes listen on (dev servers it started), polled every 10 s while
// local sessions run (src-tauri/src/claude/ports.rs). Kept apart from the sessions so a port coming
// or going re-renders only what shows it.
import { create } from "zustand"
import { getApp } from "@/store/app"

export const usePorts = create<Record<string, number[]>>(() => ({}))

const same = (a: Record<string, number[]>, b: Record<string, number[]>) => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] && a[k].length === b[k].length && a[k].every((p, i) => p === b[k][i]))
}

async function poll() {
  if (document.hidden) return
  const st = getApp()
  if (!Object.values(st.sessions).some((s) => !s.machine && !s.archived && (s.status === "working" || s.status === "idle" || s.status === "done_unseen" || s.status.startsWith("waiting")))) return
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const next = await invoke<Record<string, number[]>>("session_ports")
    if (!same(usePorts.getState(), next)) usePorts.setState(next, true)
  } catch {
    /* not on Linux, or no /proc */
  }
}

export function startPorts() {
  void poll()
  setInterval(() => void poll(), 10_000)
}

export function openPort(port: number) {
  void import("@tauri-apps/plugin-opener").then((o) => o.openUrl(`http://localhost:${port}`)).catch(() => undefined)
}
