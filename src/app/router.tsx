import { useEffect } from "react"
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router"
import { syncRoute } from "@/store/actions"
import { setNavigate } from "./nav"
import { Shell } from "./Shell"

/**
 * Hash-history routes: "/" is the overview; a session, its review, settings and the archive each
 * have a URL. Route components render nothing: the Shell renders the screen for the current route
 * (and keeps recently opened sessions mounted, see ContentHost).
 */
function Root() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => {
    syncRoute(pathname)
  }, [pathname])
  return <Shell />
}

const Null = () => null

const rootRoute = createRootRoute({ component: Root })
const paths = ["/", "/new", "/new/$repoId", "/session/$sessionId", "/review/$sessionId", "/settings", "/archive", "/history", "/usage"] as const
const children = paths.map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: Null }))

export const router = createRouter({
  routeTree: rootRoute.addChildren(children),
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
