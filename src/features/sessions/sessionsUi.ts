import { create } from "zustand"
import type { ControlMode, ID, SessionStatus } from "@/lib/model"

export type SessionsViewName = "attention" | "active" | "recent" | "history" | "archived"

export interface SessionsFilter {
  view: SessionsViewName
  query: string
  status: SessionStatus[]
  repos: ID[]
  control: ControlMode[]
  model: string[]
  groupByRepo: boolean
  sort: { id: string; desc: boolean } | null
  /** columns the user turned off (the table also drops low-priority columns when narrow) */
  hiddenColumns: string[]
}

export const useSessionsUi = create<SessionsFilter>(() => ({
  view: "attention",
  query: "",
  status: [],
  repos: [],
  control: [],
  model: [],
  groupByRepo: false,
  sort: null,
  // Calm UI (§2.5): status, title, repo, activity, last at rest; the rest via View options
  hiddenColumns: ["branch", "diff", "unpushed", "ctx", "cost", "model", "control"],
}))

export function setSessionsFilter(patch: Partial<SessionsFilter>) {
  useSessionsUi.setState((s) => ({
    ...s,
    ...patch,
    // switching view resets per-view facets unless explicitly given
    status: patch.status ?? (patch.view && patch.view !== s.view ? [] : s.status),
  }))
}
