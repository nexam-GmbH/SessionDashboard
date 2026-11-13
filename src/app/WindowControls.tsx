// Adapted from mountain-loop/yaak@6a34d0a:packages/ui/src/components/WindowControls.tsx (MIT).
// Modified for session-dashboard: Tauri window API directly, our tokens, 46px buttons.
import { useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { IN_TAURI } from "@/lib/platform"

export const WINDOW_CONTROLS_WIDTH = 138

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  if (!IN_TAURI) return null
  const win = getCurrentWindow()
  const btn =
    "flex h-full w-[46px] items-center justify-center text-fg-muted transition-colors hover:bg-hover hover:text-fg"
  return (
    <div className="flex h-full shrink-0 items-stretch" style={{ width: WINDOW_CONTROLS_WIDTH }}>
      <button className={btn} onClick={() => void win.minimize()} aria-label="Minimize">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <path fill="currentColor" d="M14 8v1H3V8z" />
        </svg>
      </button>
      <button
        className={btn}
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={async () => {
          if (await win.isMaximized()) {
            await win.unmaximize()
            setMaximized(false)
          } else {
            await win.maximize()
            setMaximized(true)
          }
        }}
      >
        {maximized ? (
          <svg width="16" height="16" viewBox="0 0 16 16">
            <g fill="currentColor">
              <path d="M3 5v9h9V5zm8 8H4V6h7z" />
              <path fillRule="evenodd" d="M5 5h1V4h7v7h-1v1h2V3H5z" clipRule="evenodd" />
            </g>
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path fill="currentColor" d="M3 3v10h10V3zm9 9H4V4h8z" />
          </svg>
        )}
      </button>
      <button
        className="flex h-full w-[46px] items-center justify-center text-fg-muted transition-colors hover:bg-[#c42b1c] hover:text-white"
        onClick={() => void win.close()}
        aria-label="Close"
      >
        <svg width="16" height="16" viewBox="0 0 16 16">
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
