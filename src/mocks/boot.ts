import { getApp, setApp, useApp } from "@/store/app"
import { setMockTranscripts } from "@/backend/transcript"
import { generateWorld } from "./world"
import { ensureTranscript } from "./transcript"
import { startEngine } from "./engine"

/** The browser preview's world: main.tsx loads this chunk only in mock mode, before the first render. */
export function bootMocks() {
  setApp(generateWorld())
  setMockTranscripts(ensureTranscript)
  syncWorkspaces()
  useApp.subscribe((s) => s.settings.workspaces, syncWorkspaces)
  startEngine()
}

/**
 * Workspace membership by repository, as the desktop app works it out (backend/real.ts
 * workspaceOfRepo): a repository picked by its key, else "every repo of an owner" (github.com/acme/*).
 * Folder-based workspaces need the desktop app (it lists the repos inside a folder).
 */
function syncWorkspaces() {
  const st = getApp()
  const list = st.settings.workspaces
  const of = (key: string) =>
    list.find((w) => w.repos?.some((r) => r.key === key))?.id ??
    list.find((w) => w.repos?.some((r) => r.key.endsWith("/*") && key.startsWith(r.key.slice(0, -1))))?.id
  let repos = st.repos
  for (const [id, r] of Object.entries(st.repos)) {
    const ws = id.startsWith("repo:") ? of(id.slice(5)) : undefined
    if (r.workspace === ws && !!r.inWorkspace === !!ws) continue
    if (repos === st.repos) repos = { ...st.repos }
    repos[id] = { ...r, workspace: ws, inWorkspace: !!ws }
  }
  if (repos !== st.repos) setApp((s) => ({ repos, structVersion: s.structVersion + 1, statusVersion: s.statusVersion + 1 }))
}
