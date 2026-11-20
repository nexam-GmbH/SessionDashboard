// When you were last here, per session, if it was long enough ago to have lost the thread: set when
// you come back to a session (or to the window) after 10 minutes or more, cleared once you act.
import { useSyncExternalStore } from "react"
import type { ID } from "@/lib/model"

export const AWAY_MS = 10 * 60_000

const since = new Map<ID, string>()
const subs = new Set<() => void>()

export function setAway(id: ID, iso: string | null) {
  if ((since.get(id) ?? null) === iso) return
  if (iso) since.set(id, iso)
  else since.delete(id)
  subs.forEach((f) => f())
}

export function useAway(id: ID) {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => since.get(id) ?? null,
  )
}

// Where the chat's "New since you last looked" line goes, per session: the time you had last
// looked before this visit. Set when you open a session with unread messages, cleared by a visit
// with none; `n` counts the visits, so the chat scrolls to the line again each time.
const newSince = new Map<ID, { at: string; n: number }>()
const newSubs = new Set<() => void>()
let visits = 0

export function setNewSince(id: ID, iso: string | null) {
  if (!iso && !newSince.has(id)) return
  if (iso) newSince.set(id, { at: iso, n: ++visits })
  else newSince.delete(id)
  newSubs.forEach((f) => f())
}

export function useNewSince(id: ID) {
  return useSyncExternalStore(
    (cb) => {
      newSubs.add(cb)
      return () => newSubs.delete(cb)
    },
    () => newSince.get(id) ?? null,
  )
}
