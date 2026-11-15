// The window's own buttons when the system frame is off (Linux, Windows). Round buttons inside the
// header like GNOME / libadwaita header bars. Icon paths from mountain-loop/yaak@6a34d0a:
// packages/ui/src/components/WindowControls.tsx (MIT).
import { useEffect, useState } from "react"
import { IN_TAURI } from "@/lib/platform"

const BTN =
  "flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none"

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!IN_TAURI) return
    let off: (() => void) | undefined
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow()
      setMaximized(await w.isMaximized())
      off = await w.onResized(async () => setMaximized(await w.isMaximized()))
    })
    return () => off?.()
  }, [])
  if (!IN_TAURI) return null
  const win = async () => (await import("@tauri-apps/api/window")).getCurrentWindow()
  return (
    <div className="flex shrink-0 items-center gap-2 pl-1">
      <button className={BTN} onClick={() => void win().then((w) => w.minimize())} aria-label="Minimize">
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
          <path fill="currentColor" d="M14 8v1H3V8z" />
        </svg>
      </button>
      <button className={BTN} aria-label={maximized ? "Restore" : "Maximize"} onClick={() => void win().then((w) => w.toggleMaximize())}>
        {maximized ? (
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
            <g fill="currentColor">
              <path d="M3 5v9h9V5zm8 8H4V6h7z" />
              <path fillRule="evenodd" d="M5 5h1V4h7v7h-1v1h2V3H5z" clipRule="evenodd" />
            </g>
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
            <path fill="currentColor" d="M3 3v10h10V3zm9 9H4V4h8z" />
          </svg>
        )}
      </button>
      <button className={BTN} onClick={() => void win().then((w) => w.close())} aria-label="Close">
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="m7.116 8l-4.558 4.558l.884.884L8 8.884l4.558 4.558l.884-.884L8.884 8l4.558-4.558l-.884-.884L8 7.116L3.442 2.558l-.884.884z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  )
}
