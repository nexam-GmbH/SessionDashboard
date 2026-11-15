import { Activity, lazy, Suspense, useState, type CSSProperties } from "react"
import { useApp } from "@/store/app"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { toggleSidebar } from "@/store/actions"
import { ResizeEdges } from "./chrome"
import { AppSidebar } from "./AppSidebar"
import { SiteHeader } from "./SiteHeader"
import { ContentHost } from "./ContentHost"
import { Switcher } from "./Switcher"
import { ShortcutsHelp } from "./ShortcutsHelp"
import { ErrorBoundary } from "@/components/common/ErrorBoundary"
import Overview from "@/features/overview/Overview"
import { TerminalDock } from "@/features/terminal/TerminalDock"

const loadPalette = () => import("@/features/palette/CommandPalette")
const CommandPalette = lazy(loadPalette)
const AddReposDialog = lazy(() => import("@/features/settings/AddReposDialog").then((m) => ({ default: m.AddReposDialog })))
const loadSettingsDialog = () => import("@/features/settings/SettingsDialog").then((m) => ({ default: m.SettingsDialog }))
const SettingsDialog = lazy(loadSettingsDialog)

// Preload the palette once the app is idle, so keys typed right after Ctrl+K aren't lost while the
// chunk downloads (it stays out of the initial bundle).
if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1200))
  idle(() => {
    void loadPalette()
    void loadSettingsDialog()
  })
}

const FIRST_RUN = (() => {
  try {
    return new URLSearchParams(location.search).get("onboarding") === "1"
  } catch {
    return false
  }
})()

const LAYOUT = { "--sidebar-width": "17rem", "--header-height": "3rem" } as CSSProperties

/**
 * The stock create-tauri-ui starter layout: the session list in an inset sidebar, the screen in a
 * rounded panel with the window header on top. Two screens: the Overview tree, or a session (also
 * review, settings, archive, new session). The terminal docks at the bottom of the panel.
 */
export function Shell() {
  const open = useApp((s) => !s.settings.sidebarHidden)
  const overview = useApp((s) => s.route === "/")
  const paletteOpen = useApp((s) => s.paletteOpen)
  const settingsOpen = useApp((s) => !!s.settingsOpen)
  const [firstRun, setFirstRun] = useState(FIRST_RUN)

  return (
    <SidebarProvider data-tauri-drag-region open={open} onOpenChange={(v) => v !== open && toggleSidebar()} style={LAYOUT} className="h-svh min-h-0 overflow-hidden">
      <ErrorBoundary label="Sessions">
        <AppSidebar />
      </ErrorBoundary>
      <SidebarInset className="min-w-0 overflow-hidden">
        <SiteHeader />
        <div className="relative min-h-0 flex-1">
          {/* both screens stay mounted (React <Activity>): going to the overview and back keeps the
              open sessions' scroll position and switching stays instant */}
          <Activity mode={overview ? "visible" : "hidden"}>
            <div className="absolute inset-0 flex">
              <ErrorBoundary label="Overview">
                <Overview />
              </ErrorBoundary>
            </div>
          </Activity>
          <Activity mode={overview ? "hidden" : "visible"}>
            <div className="absolute inset-0">
              <ContentHost />
            </div>
          </Activity>
        </div>
        <TerminalDock />
      </SidebarInset>
      <ResizeEdges />
      <Switcher />
      <ShortcutsHelp />
      <ErrorBoundary label="Dialog">
        <Suspense fallback={null}>
          {paletteOpen && <CommandPalette />}
          {settingsOpen && <SettingsDialog />}
          {firstRun && <AddReposDialog firstRun onClose={() => setFirstRun(false)} />}
        </Suspense>
      </ErrorBoundary>
    </SidebarProvider>
  )
}
