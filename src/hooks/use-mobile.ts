import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

// shadcn's use-mobile, read through useSyncExternalStore (no setState in an effect)
export function useIsMobile() {
  return React.useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(QUERY)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}
