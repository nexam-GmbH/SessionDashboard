import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "@tanstack/react-router"

import "./index.css"
import { router } from "./app/router"
import { ExternalLinkGuard } from "./components/external-link-guard.tsx"
import { DebugPanel } from "./components/debug-panel.tsx"
import { TooltipProvider } from "./components/ui/tooltip"
import { startEngine } from "./mocks/engine"
import { installShortcuts } from "./features/palette/shortcuts"
import { scheduleBootDiagnostics } from "./features/dev/bootDiagnostics"

startEngine()
installShortcuts()
scheduleBootDiagnostics()

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
