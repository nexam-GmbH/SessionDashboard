import { lazy, Suspense, useEffect, useState } from "react"
import { useDefaultLayout, usePanelRef } from "react-resizable-panels"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useApp } from "@/store/app"
import { cn } from "@/lib/utils"
import { Titlebar } from "./Titlebar"
import { CenterTabs } from "./CenterTabs"
import { TabHost } from "./TabHost"
import { StatusBar } from "./StatusBar"
import { Sidebar } from "@/features/sidebar/Sidebar"
import { Inspector } from "@/features/inspector/Inspector"
import { BottomPanel } from "./BottomPanel"
import { ToastStack } from "@/features/notifications/ToastStack"
import { ShortcutsHelp } from "./ShortcutsHelp"
import { ErrorBoundary } from "@/components/common/ErrorBoundary"

const loadPalette = () => import("@/features/palette/CommandPalette")
const loadNewSession = () => import("@/features/new-session/NewSessionDialog")
const CommandPalette = lazy(loadPalette)
const NewSessionDialog = lazy(loadNewSession)

// Preload the dialogs once the app is idle, so keys typed right after Ctrl+K / Ctrl+N aren't lost
// while the chunk downloads (they stay out of the initial bundle).
if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1200))
  idle(() => {
    void loadPalette()
    void loadNewSession()
  })
}
const CrossRepoDialog = lazy(() => import("@/features/new-session/CrossRepoDialog"))
const AddReposDialog = lazy(() => import("@/features/settings/AddReposDialog").then((m) => ({ default: m.AddReposDialog })))

const FIRST_RUN = (() => {
  try {
    return new URLSearchParams(location.search).get("onboarding") === "1"
  } catch {
    return false
  }
})()

const storage = (() => {
  try {
    localStorage.getItem("x")
    return localStorage
  } catch {
    const mem = new Map<string, string>()
    return { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  }
})()

/**
 * App shell — UI_PLAN §4:
 * [sidebar | [center | bottom] | inspector], resizable, layouts persisted.
 * Panel structure follows Supabase Studio's ProjectLayout (Apache-2.0) and
 * Orca's right sidebar (MIT); sizes in px as in VS Code.
 */
export function Shell() {
  const panels = useApp((s) => s.panels)
  const density = useApp((s) => s.settings.density)
  const paletteOpen = useApp((s) => s.paletteOpen)
  const newSession = useApp((s) => s.newSession)
  const crossRepoOpen = useApp((s) => s.crossRepoOpen)
  const [firstRun, setFirstRun] = useState(FIRST_RUN)

  const outer = useDefaultLayout({ id: "sd.shell.h", storage })
  const inner = useDefaultLayout({ id: "sd.shell.v", storage })
  const sidebarRef = usePanelRef()
  const inspectorRef = usePanelRef()
  const bottomRef = usePanelRef()

  useEffect(() => {
    const p = sidebarRef.current
    if (!p) return
    if (panels.sidebar && p.isCollapsed()) p.expand()
    else if (!panels.sidebar && !p.isCollapsed()) p.collapse()
  }, [panels.sidebar, sidebarRef])
  useEffect(() => {
    const p = inspectorRef.current
    if (!p) return
    if (panels.inspector && p.isCollapsed()) p.expand()
    else if (!panels.inspector && !p.isCollapsed()) p.collapse()
  }, [panels.inspector, inspectorRef])
  useEffect(() => {
    const p = bottomRef.current
    if (!p) return
    if (panels.bottom && p.isCollapsed()) p.expand()
    else if (!panels.bottom && !p.isCollapsed()) p.collapse()
  }, [panels.bottom, bottomRef])

  return (
    <div className={cn("flex h-full flex-col bg-canvas text-fg", density === "comfortable" && "density-comfortable")}>
      <Titlebar />
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={outer.defaultLayout}
          onLayoutChanged={outer.onLayoutChanged}
        >
          <ResizablePanel
            id="sidebar"
            panelRef={sidebarRef}
            defaultSize="260px"
            minSize="200px"
            maxSize="480px"
            collapsible
            collapsedSize="0px"
            className="bg-chrome"
          >
            <div className="h-full" inert={!panels.sidebar}>
              <ErrorBoundary label="Sidebar">
                <Sidebar />
              </ErrorBoundary>
            </div>
          </ResizablePanel>
          <ResizableHandle className={cn(!panels.sidebar && "hidden")} />
          <ResizablePanel id="center" minSize="420px">
            <ResizablePanelGroup
              orientation="vertical"
              defaultLayout={inner.defaultLayout}
              onLayoutChanged={inner.onLayoutChanged}
            >
              <ResizablePanel id="main" minSize="200px">
                <div className="flex h-full min-h-0 flex-col">
                  <CenterTabs />
                  <div className="relative min-h-0 flex-1">
                    <TabHost />
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle className={cn(!panels.bottom && "hidden")} />
              <ResizablePanel
                id="bottom"
                panelRef={bottomRef}
                defaultSize="240px"
                minSize="120px"
                collapsible
                collapsedSize="0px"
                className="bg-chrome"
              >
                <div className="h-full" inert={!panels.bottom}>
                  <ErrorBoundary label="Panel">
                    <BottomPanel />
                  </ErrorBoundary>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle className={cn(!panels.inspector && "hidden")} />
          <ResizablePanel
            id="inspector"
            panelRef={inspectorRef}
            defaultSize="320px"
            minSize="280px"
            maxSize="560px"
            collapsible
            collapsedSize="0px"
            className="bg-chrome"
          >
            <div className="h-full" inert={!panels.inspector}>
              <ErrorBoundary label="Inspector">
                <Inspector />
              </ErrorBoundary>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar />
      <ToastStack />
      <ShortcutsHelp />
      <ErrorBoundary label="Dialog">
        <Suspense fallback={null}>
          {paletteOpen && <CommandPalette />}
          {newSession && <NewSessionDialog />}
          {crossRepoOpen && <CrossRepoDialog />}
          {firstRun && <AddReposDialog firstRun onClose={() => setFirstRun(false)} />}
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}
