/**
 * Text to prefill the next "New session" prompt with (code graph "Ask a session" passes the
 * symbol reference). Module state instead of store state: it lives only between the click and
 * the dialog's first render, which clears it.
 */
let pending: string | null = null

export function setNewSessionPrefill(text: string) {
  pending = text
}
export function peekNewSessionPrefill() {
  return pending
}
export function clearNewSessionPrefill() {
  pending = null
}
