import { useEffect } from "react"
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouterState,
} from "@tanstack/react-router"
import { syncActiveTab } from "@/store/actions"
import { setNavigate } from "./nav"
import { Shell } from "./Shell"
import { PopoutShell } from "./PopoutShell"

/**
 * Hash-history routes (UI_PLAN §1): every view has a URL so pop-out windows and
 * deep links are trivial. Route components render nothing: the Shell's TabHost
 * renders the open tabs (kept alive under <Activity>), keyed by pathname.
 */
function Root() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isPopout = pathname.startsWith("/popout/")
  useEffect(() => {
    if (!isPopout) syncActiveTab(pathname)
  }, [pathname, isPopout])
  return isPopout ? <PopoutShell pathname={pathname} /> : <Shell />
}

const Null = () => null

const rootRoute = createRootRoute({ component: Root })
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/map" } as Parameters<typeof redirect>[0])
  },
})
const paths = [
  "/map",
  "/sessions",
  "/session/$sessionId",
  "/review/$sessionId",
  "/repo/$repoId",
  "/graph/$scope",
  "/settings",
  "/dev/webgl",
  "/dev/perf",
  "/popout/session/$sessionId",
] as const
const children = paths.map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: Null }))

const routeTree = rootRoute.addChildren([indexRoute, ...children])

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: false,
})

setNavigate((to, opts) => {
  void router.navigate({ to: to as never, search: opts?.search as never })
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
