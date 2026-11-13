import { useApp } from "@/store/app"
import type { SessionStatus } from "@/lib/model"

export interface TabTitle {
  title: string
  parts: string[]
  status?: SessionStatus
}

/** Title + breadcrumb for a tab key (pathname). */
export function useTabTitle(key: string, breadcrumb = false): TabTitle {
  const [, kind, refId] = key.split("/")
  const session = useApp((s) => (kind === "session" || kind === "review" ? s.sessions[refId] : undefined))
  const repoName = useApp((s) => {
    if (kind === "repo") return s.repos[refId]?.name
    if (session?.repoId) return s.repos[session.repoId]?.name
    if (kind === "graph" && refId !== "global") return s.repos[refId]?.name
    return undefined
  })
  switch (kind) {
    case "map":
      return { title: "Map", parts: ["Map"] }
    case "sessions":
      return { title: "Sessions", parts: ["Sessions"] }
    case "session":
      return {
        title: session?.title ?? "Session",
        parts: breadcrumb ? [session?.role === "main" ? "Main agent" : (repoName ?? "—"), session?.title ?? ""] : [],
        status: session?.status,
      }
    case "review":
      return { title: `Review · ${session?.title ?? ""}`, parts: [repoName ?? "", session?.title ?? "", "Review"] }
    case "repo":
      return { title: repoName ?? "Repo", parts: ["Repos", repoName ?? ""] }
    case "graph":
      return { title: `Graph · ${refId === "global" ? "all repos" : (repoName ?? "")}`, parts: ["Code graph", refId === "global" ? "All repos" : (repoName ?? "")] }
    case "settings":
      return { title: "Settings", parts: ["Settings"] }
    case "dev":
      return { title: refId === "webgl" ? "WebGL check" : "Perf harness", parts: ["Dev", refId] }
    default:
      return { title: key, parts: [key] }
  }
}
