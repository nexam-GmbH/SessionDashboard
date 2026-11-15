// Number hints on modifier hold (Conductor, T3 Code): while Ctrl (⌘ on macOS) is held for a moment,
// the session list shows the Ctrl+1–9 number next to each row. Quick shortcuts (Ctrl+K, Ctrl+J)
// never flash the hints because they only appear after HOLD_MS.
import { useSyncExternalStore } from "react"
import { IS_MAC } from "@/lib/platform"

const HOLD_MS = 350
let held = false
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function set(v: boolean) {
  if (held === v) return
  held = v
  listeners.forEach((l) => l())
}

function isMod(e: KeyboardEvent) {
  return IS_MAC ? e.key === "Meta" : e.key === "Control"
}

let installed = false
function install() {
  if (installed || typeof window === "undefined") return
  installed = true
  window.addEventListener(
    "keydown",
    (e) => {
      if (isMod(e)) {
        if (!timer && !held) timer = setTimeout(() => set(true), HOLD_MS)
      } else if (!(IS_MAC ? e.metaKey : e.ctrlKey)) {
        clearTimeout(timer)
        timer = undefined
      }
    },
    true,
  )
  const release = () => {
    clearTimeout(timer)
    timer = undefined
    set(false)
  }
  window.addEventListener("keyup", (e) => isMod(e) && release(), true)
  window.addEventListener("blur", release)
}

export function useModHeld() {
  install()
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => held,
  )
}
