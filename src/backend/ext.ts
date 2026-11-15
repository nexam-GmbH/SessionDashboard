// Sessions that are not in this computer's ~/.claude: on a VPS (ssh) or in the cloud (claude.ai).
// Their sources (machines.ts, cloud.ts) keep them here; real.ts merges them into the store on
// every sync. Also the hook state of local sessions and the git state of folders, which real.ts
// folds into its own records. No imports from real.ts: it registers its sync function instead.
import type { ID, RepoGit, Session, SessionStatus } from "@/lib/model"

export interface ExtSession {
  id: ID
  /** "cloud" or an ssh host */
  machine: string
  cwd: string
  title: string
  status: SessionStatus
  waitingFor?: Session["waitingFor"]
  activity?: string
  errorMessage?: string
  updatedMs: number
  createdMs?: number
  model?: string
  branch?: string
  url?: string
  kind?: "interactive" | "background"
  /** a live process exists (a terminal on the VPS, a cloud container) */
  live: boolean
  /** its claude process there (VPS) */
  pid?: number
}

/** per machine: its sessions (replaced as a whole by each poll) */
export const extByMachine = new Map<string, Map<ID, ExtSession>>()

export function extSession(id: ID): ExtSession | undefined {
  for (const m of extByMachine.values()) {
    const s = m.get(id)
    if (s) return s
  }
  return undefined
}

/** What the last hook said about a session (newer than the pid file → it wins). */
export interface HookState {
  status: SessionStatus
  waitingFor?: Session["waitingFor"]
  activity?: string
  errorMessage?: string
  at: number
}
export const hookState = new Map<ID, HookState>()

/** git per folder key (`machine|path`, machine "" = this computer) */
export const gitByFolder = new Map<string, RepoGit>()
export const folderKey = (machine: string | undefined, path: string) => `${machine ?? ""}|${path}`

let syncFn: () => void = () => undefined
let queued = false
export function registerSync(f: () => void) {
  syncFn = f
}
/** Ask for one store rebuild soon (several sources in a tick → one sync). */
export function requestSync() {
  if (queued) return
  queued = true
  queueMicrotask(() => {
    queued = false
    syncFn()
  })
}
