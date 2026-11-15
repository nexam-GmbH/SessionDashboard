// Interface size (Settings → Window, Ctrl+= / Ctrl+−): the whole window scales, like a browser's
// zoom, through the web view's own zoom so text stays sharp and menus stay where they belong.
import { getApp, setApp, useApp } from "@/store/app"
import { IN_TAURI } from "@/lib/platform"

export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]

async function apply(scale: number) {
  if (IN_TAURI) {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview")
      await getCurrentWebview().setZoom(scale)
      return
    } catch {
      /* fall back to CSS below */
    }
  }
  document.documentElement.style.zoom = scale === 1 ? "" : String(scale)
}

export function stepZoom(dir: 1 | -1) {
  const cur = getApp().settings.uiScale ?? 1
  const i = ZOOM_STEPS.findIndex((z) => z >= cur - 0.001)
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir))]
  setApp((s) => ({ settings: { ...s.settings, uiScale: next } }))
}

export function installZoom() {
  void apply(getApp().settings.uiScale ?? 1)
  useApp.subscribe(
    (s) => s.settings.uiScale,
    (z) => void apply(z ?? 1),
  )
}

/** Settings → Chat width: the readable column (Claude Code desktop) or a wide one. */
export function installChatWidth() {
  const set = (w: string | undefined) => {
    if (w === "wide") document.documentElement.dataset.chatWidth = "wide"
    else delete document.documentElement.dataset.chatWidth
  }
  set(getApp().settings.chatWidth)
  useApp.subscribe(
    (s) => s.settings.chatWidth,
    (w) => set(w),
  )
}
