import { Activity, lazy, Suspense, memo } from "react"
import { useApp } from "@/store/app"
import { ErrorBoundary } from "@/components/common/ErrorBoundary"

/**
 * Renders open tabs. Recently viewed tabs (LRU of 5) stay mounted under React
 * 19.2 <Activity mode="hidden"> so switching back is instant without render cost
 * while hidden (UI_PLAN §4.3, §8.6). Heavy views are lazy-loaded per route.
 */
const MapView = lazy(() => import("@/features/map/MapView"))
const SessionsView = lazy(() => import("@/features/sessions/SessionsView"))
const SessionView = lazy(() => import("@/features/session-view/SessionView"))
const ReviewView = lazy(() => import("@/features/review/ReviewView"))
const RepoView = lazy(() => import("@/features/repo/RepoView"))
const CodeGraphView = lazy(() => import("@/features/code-graph/CodeGraphView"))
const SettingsView = lazy(() => import("@/features/settings/SettingsView"))
const WebglCheck = lazy(() => import("@/features/dev/WebglCheck"))
const PerfHarness = lazy(() => import("@/features/dev/PerfHarness"))

export function TabHost() {
  const mounted = useApp((s) => s.mountedTabs)
  const active = useApp((s) => s.activeTab)
  const keys = mounted.includes(active) ? mounted : [active, ...mounted]
  return (
    <>
      {keys.map((key) => (
        <Activity key={key} mode={key === active ? "visible" : "hidden"}>
          <div className="absolute inset-0 flex flex-col">
            <ErrorBoundary label={key}>
              <Suspense fallback={<ViewFallback />}>
                <View tabKey={key} />
              </Suspense>
            </ErrorBoundary>
          </div>
        </Activity>
      ))}
    </>
  )
}

function ViewFallback() {
  return <div className="h-full w-full bg-canvas" />
}

const View = memo(function View({ tabKey }: { tabKey: string }) {
  const [, kind, ref] = tabKey.split("/")
  switch (kind) {
    case "map":
      return <MapView />
    case "sessions":
      return <SessionsView />
    case "session":
      return <SessionView sessionId={ref} />
    case "review":
      return <ReviewView sessionId={ref} />
    case "repo":
      return <RepoView repoId={ref} />
    case "graph":
      return <CodeGraphView scope={ref} />
    case "settings":
      return <SettingsView />
    case "dev":
      return ref === "webgl" ? <WebglCheck /> : <PerfHarness />
    default:
      return null
  }
})
