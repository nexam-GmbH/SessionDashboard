import { IN_TAURI } from "@/lib/platform"

/**
 * Pop-out (UI_PLAN §4.7): a session tab opens in its own Tauri WebviewWindow
 * labelled `session-<id>`, routed to `#/popout/session/<id>`. In the browser
 * (dev/screenshots) it opens a regular window with the same URL.
 */
export async function openPopout(tabKey: string) {
  const [, kind, id] = tabKey.split("/")
  if (kind !== "session" || !id) return
  const url = `${location.origin}${location.pathname}${location.search}#/popout/session/${id}`
  if (!IN_TAURI) {
    window.open(url, `session-${id}`, "width=1100,height=800")
    return
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
  const label = `session-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`
  const existing = await WebviewWindow.getByLabel(label)
  if (existing) {
    await existing.setFocus()
    return
  }
  new WebviewWindow(label, {
    url: `index.html#/popout/session/${id}`,
    title: "Session",
    width: 1100,
    height: 800,
    minWidth: 640,
    minHeight: 420,
  })
}
