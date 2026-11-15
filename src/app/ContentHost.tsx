import { Activity, lazy, memo, Suspense } from "react"
import { useShallow } from "zustand/react/shallow"
import { useApp } from "@/store/app"
import { ErrorBoundary } from "@/components/common/ErrorBoundary"

// the session screen is the main screen: in the first bundle, so opening one never flashes empty
import SessionView from "@/features/session-view/SessionView"

const loadReview = () => import("@/features/review/ReviewView")
const loadSettings = () => import("@/features/settings/SettingsView")
const loadArchive = () => import("@/features/archive/ArchiveView")
const loadNew = () => import("@/features/new-session/NewSessionView")
const loadUsage = () => import("@/features/usage/UsageView")
const ReviewView = lazy(loadReview)
const SettingsView = lazy(loadSettings)
const ArchiveView = lazy(loadArchive)
const NewSessionView = lazy(loadNew)
const UsageView = lazy(loadUsage)

// the other screens load while the app is idle, so they open without a blank frame too
if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500))
  idle(() => void Promise.all([loadNew(), loadSettings(), loadArchive(), loadReview(), loadUsage()]))
}

/** sessions kept mounted besides the current screen: switching back to one of them is instant */
const KEEP = 5

/**
 * The screen beside the session list. The current screen plus the most recently opened sessions
 * stay mounted under React <Activity mode="hidden"> (no render cost while hidden), so Ctrl+Tab and
 * Ctrl+number switch like terminal tabs: no reload, scroll position kept.
 */
export function ContentHost() {
  const screen = useApp((s) => s.screen)
  const recent = useApp(useShallow((s) => s.recent.slice(0, KEEP)))
  const keys = [...new Set([...(screen ? [screen] : []), ...recent.map((id) => `/session/${id}`)])]
  if (!screen) return <EmptyScreen />
  return (
    <>
      {keys.map((key) => (
        <Activity key={key} mode={key === screen ? "visible" : "hidden"}>
          <div className="absolute inset-0 flex flex-col">
            <ErrorBoundary label={key}>
              <Suspense fallback={<div className="h-full w-full bg-background" />}>
                <Screen route={key} />
              </Suspense>
            </ErrorBoundary>
          </div>
        </Activity>
      ))}
    </>
  )
}

function EmptyScreen() {
  return <div className="absolute inset-0 bg-background" />
}

const Screen = memo(function Screen({ route }: { route: string }) {
  const [, kind, ref] = route.split("/")
  switch (kind) {
    case "session":
      return <SessionView sessionId={ref} />
    case "review":
      return <ReviewView sessionId={ref} />
    case "settings":
      return <SettingsView />
    case "archive":
      return <ArchiveView />
    case "new":
      return <NewSessionView repoId={ref} />
    case "usage":
      return <UsageView />
    default:
      return null
  }
})
