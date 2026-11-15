// A session in its own window (side by side with the main one, or on another screen). The window
// loads the app with `?popout=<id>` and shows only that session (backend/mode.ts POPOUT).
import { IN_TAURI } from "@/lib/platform"
import { getApp } from "@/store/app"

export async function openSessionWindow(id: string) {
  if (!IN_TAURI) return
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
  const label = `session-${id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`
  const existing = await WebviewWindow.getByLabel(label)
  if (existing) {
    await existing.unminimize().catch(() => undefined)
    await existing.setFocus().catch(() => undefined)
    return
  }
  const title = getApp().sessions[id]?.title ?? "Session"
  new WebviewWindow(label, {
    url: `index.html?popout=${encodeURIComponent(id)}#/session/${encodeURIComponent(id)}`,
    title,
    width: 1040,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    decorations: true,
    dragDropEnabled: false,
  })
}
