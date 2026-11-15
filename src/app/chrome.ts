// The window's own frame (Linux, Windows): one bar instead of the system title bar plus ours, like
// the Claude desktop app and Zed. The system frame goes (setDecorations), the top bar drags and
// double-click maximizes (data-tauri-drag-region), and thin invisible edges keep the window
// resizable. Settings → Window → "Native title bar" brings the system frame back.
import { createElement, useEffect, useState } from "react"
import { getApp, useApp } from "@/store/app"
import { IN_TAURI, OS } from "@/lib/platform"

export const customChrome = (native: boolean) => IN_TAURI && (OS === "windows" || (OS === "linux" && !native))

async function apply(native: boolean) {
  if (!IN_TAURI || OS === "macos") return
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    await getCurrentWindow().setDecorations(!customChrome(native))
  } catch (e) {
    console.warn("setDecorations", e)
  }
}

export function installChrome() {
  void apply(getApp().settings.nativeTitlebar)
  useApp.subscribe(
    (s) => s.settings.nativeTitlebar,
    (n) => void apply(n),
  )
}

type Dir = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest"
const EDGES: { dir: Dir; style: Record<string, string | number> }[] = [
  { dir: "North", style: { top: 0, left: 8, right: 8, height: 4, cursor: "ns-resize" } },
  { dir: "South", style: { bottom: 0, left: 8, right: 8, height: 5, cursor: "ns-resize" } },
  { dir: "West", style: { left: 0, top: 8, bottom: 8, width: 5, cursor: "ew-resize" } },
  { dir: "East", style: { right: 0, top: 8, bottom: 8, width: 5, cursor: "ew-resize" } },
  { dir: "NorthWest", style: { left: 0, top: 0, width: 8, height: 8, cursor: "nwse-resize" } },
  { dir: "NorthEast", style: { right: 0, top: 0, width: 8, height: 8, cursor: "nesw-resize" } },
  { dir: "SouthWest", style: { left: 0, bottom: 0, width: 8, height: 8, cursor: "nesw-resize" } },
  { dir: "SouthEast", style: { right: 0, bottom: 0, width: 8, height: 8, cursor: "nwse-resize" } },
]

/** Invisible borders to resize a frameless window by its edges (not while maximized). */
export function ResizeEdges() {
  const native = useApp((s) => s.settings.nativeTitlebar)
  const [maximized, setMaximized] = useState(false)
  const on = customChrome(native)
  useEffect(() => {
    if (!on) return
    let unlisten: (() => void) | undefined
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow()
      setMaximized(await w.isMaximized())
      unlisten = await w.onResized(async () => setMaximized(await w.isMaximized()))
    })
    return () => unlisten?.()
  }, [on])
  if (!on || maximized) return null
  return createElement(
    "div",
    { "aria-hidden": true },
    EDGES.map((e) =>
      createElement("div", {
        key: e.dir,
        style: { position: "fixed", zIndex: 60, ...e.style },
        onMouseDown: (ev: MouseEvent) => {
          if ((ev as unknown as { button: number }).button !== 0) return
          void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().startResizeDragging(e.dir as never))
        },
      }),
    ),
  )
}
