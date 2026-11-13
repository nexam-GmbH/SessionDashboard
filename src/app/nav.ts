/**
 * Navigation indirection so non-React code (store actions, palette commands,
 * notifications) can change routes without importing the router (no cycles).
 */
type NavigateFn = (to: string, opts?: { search?: Record<string, string> }) => void

let impl: NavigateFn = (to) => {
  window.location.hash = to
}

export function setNavigate(fn: NavigateFn) {
  impl = fn
}

export function navigate(to: string, opts?: { search?: Record<string, string> }) {
  impl(to, opts)
}
