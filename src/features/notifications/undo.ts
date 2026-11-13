import { create } from "zustand"
import { getApp } from "@/store/app"
import { archiveSessions, restoreSessions } from "@/store/actions"
import type { ID } from "@/lib/model"

/**
 * One "Undo" toast for reversible bulk actions (archive / restore), shown by ToastStack.
 * Every surface that archives (sidebar, map, inspector, Sessions table, session header,
 * palette) goes through archiveWithUndo, so the same action gives the same feedback everywhere.
 */
interface UndoState {
  /** bumps on every new action so the toast's timer restarts */
  seq: number
  label: string
  detail: string
  undo: (() => void) | null
}

export const useUndo = create<UndoState>(() => ({ seq: 0, label: "", detail: "", undo: null }))

export function showUndo(label: string, detail: string, undo: () => void) {
  useUndo.setState((s) => ({ seq: s.seq + 1, label, detail, undo }))
}
export function clearUndo() {
  useUndo.setState({ undo: null })
}

function detailFor(ids: ID[]) {
  return ids.length === 1 ? (getApp().sessions[ids[0]]?.title ?? "") : `${ids.length} sessions`
}

export function archiveWithUndo(ids: ID[]) {
  const st = getApp()
  const real = ids.filter((id) => st.sessions[id] && st.sessions[id].role !== "main" && !st.sessions[id].archived)
  if (!real.length) return
  const detail = detailFor(real)
  archiveSessions(real)
  showUndo("Archived", detail, () => restoreSessions(real))
}

export function restoreWithUndo(ids: ID[]) {
  const st = getApp()
  const real = ids.filter((id) => st.sessions[id]?.archived)
  if (!real.length) return
  const detail = detailFor(real)
  restoreSessions(real)
  showUndo("Restored", detail, () => archiveSessions(real))
}
