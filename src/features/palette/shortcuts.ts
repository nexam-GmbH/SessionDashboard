import { tinykeys } from "tinykeys"
import { getApp } from "@/store/app"
import { openPalette, closeTab, reopenClosedTab, togglePanel, goToNextWaiting, openNewSession, openCrossRepo, openSession } from "@/store/actions"
import { navigate } from "@/app/nav"
import { selectAttention } from "@/store/selectors"

/**
 * Global keyboard map — UI_PLAN §7. Bound once at the root (tinykeys, MIT).
 * Single-key shortcuts are ignored while typing in inputs/composer/terminal.
 */
function typing(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  if (!el) return false
  if (el.closest(".xterm")) return true
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable
}

function single(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (typing(e) || getApp().paletteOpen || getApp().newSession || document.querySelector("[role=dialog]")) return
    e.preventDefault()
    fn()
  }
}

function mod(fn: () => void) {
  return (e: KeyboardEvent) => {
    e.preventDefault()
    fn()
  }
}

export function installShortcuts() {
  const jump = (i: number) =>
    single(() => {
      const list = selectAttention(getApp())
      const e = list[i]
      if (e) openSession(e.kind === "session" ? e.id : e.sessionId)
    })
  tinykeys(window, {
    "$mod+KeyK": mod(() => (getApp().paletteOpen ? undefined : openPalette())),
    "$mod+KeyP": mod(() => openPalette("@")),
    "$mod+Shift+KeyP": mod(() => openPalette(">")),
    "$mod+KeyN": mod(() => openNewSession()),
    "$mod+Shift+KeyN": mod(() => openCrossRepo()),
    "$mod+KeyB": mod(() => togglePanel("sidebar")),
    "$mod+Alt+KeyB": mod(() => togglePanel("inspector")),
    "$mod+KeyJ": mod(() => togglePanel("bottom")),
    "$mod+KeyW": mod(() => closeTab(getApp().activeTab)),
    "$mod+Shift+KeyT": mod(() => reopenClosedTab()),
    "$mod+Comma": mod(() => navigate("/settings")),
    // On the map, N is handled by the map itself (next waiting node + fit view).
    KeyN: (e) => {
      if (getApp().activeTab === "/map") return
      single(() => void goToNextWaiting())(e)
    },
    "KeyG KeyM": single(() => navigate("/map")),
    "KeyG KeyS": single(() => navigate("/sessions")),
    "KeyG KeyG": single(() => navigate("/graph/global")),
    "KeyG KeyR": single(() => {
      const sel = getApp().selection
      if (sel?.kind === "repo") navigate(`/repo/${sel.id}`)
    }),
    "Alt+Digit1": jump(0),
    "Alt+Digit2": jump(1),
    "Alt+Digit3": jump(2),
    "Alt+Digit4": jump(3),
    "Alt+Digit5": jump(4),
    "Alt+Digit6": jump(5),
    "Alt+Digit7": jump(6),
    "Alt+Digit8": jump(7),
    "Alt+Digit9": jump(8),
  })
}
