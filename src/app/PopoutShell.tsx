import { lazy, Suspense } from "react"

const SessionView = lazy(() => import("@/features/session-view/SessionView"))

/** Standalone layout for a popped-out session window (UI_PLAN §4.7). */
export function PopoutShell({ pathname }: { pathname: string }) {
  const id = pathname.split("/")[3]
  return (
    <div className="flex h-full flex-col bg-canvas text-fg">
      <div data-tauri-drag-region className="h-2 shrink-0 bg-chrome" />
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={null}>
          <div className="absolute inset-0 flex flex-col">
            <SessionView sessionId={id} popout />
          </div>
        </Suspense>
      </div>
    </div>
  )
}
