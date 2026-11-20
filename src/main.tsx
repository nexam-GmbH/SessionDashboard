import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "@tanstack/react-router"

import "./index.css"
import { router } from "./app/router"
import { ExternalLinkGuard } from "./components/external-link-guard.tsx"
import { DebugPanel } from "./components/debug-panel.tsx"
import { TooltipProvider } from "./components/ui/tooltip"
import { installShortcuts } from "./features/palette/shortcuts"
import { installChatWidth, installZoom } from "./app/zoom"
import { installTitleTooltips } from "./components/title-tooltips"
import { installSpinClock } from "./components/spin-clock"
import { installChrome } from "./app/chrome"
import { POPOUT, REAL } from "./backend/mode"
import { IN_TAURI } from "./lib/platform"
import { startReal } from "./backend/real"
import { startUsage } from "./features/usage/usageData"

// the desktop app shows your real Claude Code sessions; the browser preview runs the mock world
if (REAL) {
  void startReal()
  // a test copy started with SD_SELFTEST=1 checks its real paths and logs the result
  if (!POPOUT) void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<boolean>("sd_selftest"))
    .then(async (on) => {
      if (on) await (await import("./selftest")).runSelftest()
    })
    .catch(() => undefined)
}
// the mock world is a chunk of its own, so the desktop app never parses it; it is in place before the first render
else (await import("./mocks/boot")).bootMocks()
installShortcuts()
installZoom()
installChatWidth()
installTitleTooltips()
installSpinClock()
installChrome()
if (!POPOUT) startUsage()

;(window as unknown as { __sdLog?: (m: string, level?: number) => void }).__sdLog?.(`started ${innerWidth}x${innerHeight}`, 3)

// show the window once the first frame is painted with its fonts (Rust shows it after 2.5 s anyway)
if (IN_TAURI) {
  const fonts = Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 600))])
  void fonts.then(() =>
    setTimeout(() => {
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().show()).catch(() => undefined)
    }, 30),
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <ExternalLinkGuard />
      {import.meta.env.DEV && new URLSearchParams(location.search).get("debug") !== "off" ? <DebugPanel /> : null}
      <main data-ui-scroll-container>
        <RouterProvider router={router} />
      </main>
    </TooltipProvider>
  </StrictMode>,
)
