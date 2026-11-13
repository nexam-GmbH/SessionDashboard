import { create } from "zustand"
import { navigate } from "@/app/nav"

/**
 * "Find <symbol> in the code graph" from outside the graph view (command palette). The graph
 * view for that scope picks the query up once (mounted or not yet) and shows its matches.
 */
interface GraphIntent {
  scope: string
  query: string
  seq: number
}
export const useGraphIntent = create<GraphIntent>(() => ({ scope: "", query: "", seq: 0 }))

export function searchCodeGraph(query: string, scope = "global") {
  useGraphIntent.setState((s) => ({ scope, query, seq: s.seq + 1 }))
  navigate(`/graph/${scope}`)
}

/** The pending query for `scope` (empty when there is none). */
export function peekGraphIntent(scope: string) {
  const { scope: s, query } = useGraphIntent.getState()
  return query && s === scope ? query : ""
}
export function clearGraphIntent(scope: string) {
  if (useGraphIntent.getState().scope === scope) useGraphIntent.setState({ query: "" })
}
