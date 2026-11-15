import { tinykeys } from "tinykeys"
import { getApp } from "@/store/app"
import {
  goToNextWaiting,
  jumpToSession,
  openNewSession,
  openOverview,
  openPalette,
  openSettings,
  repoInFocus,
  stepSession,
  setWorkspace,
} from "@/store/actions"
import { stepZoom } from "@/app/zoom"
import { openPicker } from "@/features/composer/options"
import { toggleTerminal } from "@/features/terminal/terminals"
import { cycleTranscriptView } from "@/features/session-view/transcript/view"

/**
 * Global keyboard map (tinykeys, MIT), terminal-tab speed:
 *   Ctrl+Tab        previous session (hold Ctrl for the recent list; handled by app/Switcher)
 *   Ctrl+J          next session that needs you (tmux M-n, Codex ⌘⌥A, zellij Ctrl o n)
 *   Ctrl+1–9        session by position in the list, Ctrl+0 the overview (hints while Ctrl is held)
 *   Alt+↑ / Alt+↓   previous / next session in the list
 *   Ctrl+K search, Ctrl+N new session, Ctrl+, settings (? shortcuts: app/ShortcutsHelp)
 *   Ctrl+Shift+M / I / E   permission mode, model, effort menus (Claude Code desktop)
 *   Ctrl+`          the terminal of what is on screen
 *   Ctrl+O          transcript view: Normal → Thinking → Verbose (Claude Code desktop)
 */
function blocked() {
  const s = getApp()
  // a dialog that is open (a closing popover keeps role=dialog while it animates out)
  return s.paletteOpen || !!document.querySelector("[role=dialog][data-state=open]:not([data-slot=popover-content]), [role=alertdialog][data-state=open]")
}

/** Modifier shortcuts work while typing (the prompt box keeps focus), but not over a dialog. */
function mod(fn: () => void, overDialogs = false) {
  return (e: KeyboardEvent) => {
    if (!overDialogs && blocked()) return
    e.preventDefault()
    fn()
  }
}

export function installShortcuts() {
  const digits: Record<string, (e: KeyboardEvent) => void> = {}
  for (let n = 1; n <= 9; n++) digits[`$mod+Digit${n}`] = mod(() => jumpToSession(n))
  tinykeys(window, {
    "$mod+KeyK": mod(() => (getApp().paletteOpen ? undefined : openPalette())),
    "$mod+KeyN": mod(() => openNewSession(repoInFocus())),
    "$mod+KeyJ": mod(() => goToNextWaiting()),
    "$mod+Digit0": mod(() => openOverview()),
    ...digits,
    // Claude Code desktop: mode, model and effort menus of the prompt box on screen
    "$mod+Shift+KeyM": mod(() => openPicker("mode")),
    "$mod+Shift+KeyI": mod(() => openPicker("model")),
    "$mod+Shift+KeyE": mod(() => openPicker("effort")),
    "$mod+KeyO": mod(() => cycleTranscriptView()),
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `Alt+Digit${i + 1}`,
        mod(() => {
          const w = getApp().settings.workspaces[i]
          if (w) setWorkspace(w.id)
        }),
      ]),
    ),
    // Ctrl+B (session list) is the stock SidebarProvider's own shortcut
    "$mod+Backquote": mod(() => toggleTerminal(), true),
    // interface size, like a browser
    "$mod+Equal": mod(() => stepZoom(1), true),
    "$mod+Shift+Equal": mod(() => stepZoom(1), true),
    "$mod+NumpadAdd": mod(() => stepZoom(1), true),
    "$mod+Minus": mod(() => stepZoom(-1), true),
    "$mod+NumpadSubtract": mod(() => stepZoom(-1), true),
    "Alt+ArrowUp": mod(() => stepSession(-1)),
    "Alt+ArrowDown": mod(() => stepSession(1)),
    "$mod+Comma": mod(() => openSettings()),
  }, {
    // tinykeys ignores keys typed in inputs by default; every binding here has a modifier and must
    // work while you type in the prompt box (that is where your focus is most of the time)
    ignore: (e) => e.repeat || e.isComposing,
  })
}
