// Git state of the folders sessions work in: branch, uncommitted and unpushed work, and "loose
// ends" (worktrees and branches with work nobody committed or pushed). Folders with a running
// session are read every 20 s, every other folder Claude Code was used in every 2 minutes, VPS
// folders over ssh every minute. Plain git, read-only (src-tauri/src/claude/git.rs).
import { invoke } from "@tauri-apps/api/core"
import type { LooseEnd, RepoGit } from "@/lib/model"
import { folderKey, gitByFolder, requestSync } from "./ext"

interface RawWorktree {
  path: string
  branch?: string
  main: boolean
  changed: number
  untracked: number
  unpushed: number
  ahead: number
  behind: number
  upstream?: string
  lastCommitMs: number
  locked: boolean
  prunable: boolean
}
interface RawBranch {
  name: string
  upstream?: string
  unpushed: number
  gone: boolean
  lastCommitMs: number
}
interface RawGit {
  path: string
  isRepo: boolean
  hasRemote: boolean
  remoteUrl?: string
  worktrees: RawWorktree[]
  branches: RawBranch[]
  error?: string
}

/** A remote URL as a repository key: git@github.com:Acme/api.git and https://github.com/acme/api → "github.com/acme/api". */
export function repoKey(url?: string): string | undefined {
  if (!url) return undefined
  const u = url.trim().replace(/\.git$/, "").replace(/\/+$/, "")
  // an ssh alias for a second GitHub account (git@github-work:acme/api) is still github.com
  const host = (h: string) => (/github/i.test(h) ? "github.com" : h)
  let m = /^[\w.-]+@([^:/]+):(.+)$/.exec(u)
  if (m) return `${host(m[1])}/${m[2]}`.toLowerCase()
  m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(u)
  if (m) return `${host(m[1])}/${m[2]}`.toLowerCase()
  m = /^([^/:]+):(.+)$/.exec(u)
  if (m && !u.startsWith("/")) return `${host(m[1])}/${m[2]}`.toLowerCase()
  return u.toLowerCase()
}

function toRepoGit(cwd: string, g: RawGit): RepoGit {
  const now = new Date().toISOString()
  if (!g.isRepo) return { isRepo: false, hasRemote: false, changed: 0, untracked: 0, ahead: 0, behind: 0, unpushed: 0, looseEnds: [], observedAt: now, error: g.error }
  // the worktree this folder is in (the longest path that contains it)
  const here = [...g.worktrees].filter((w) => cwd === w.path || cwd.startsWith(w.path + "/")).sort((a, b) => b.path.length - a.path.length)[0] ?? g.worktrees[0]
  const checkedOut = new Set(g.worktrees.map((w) => w.branch).filter(Boolean))
  const loose: LooseEnd[] = []
  for (const w of g.worktrees) {
    if (w === here || w.prunable) continue
    if (w.changed + w.untracked > 0 || w.unpushed > 0) {
      loose.push({ kind: "worktree", name: w.branch ?? w.path.split("/").pop() ?? w.path, path: w.path, changed: w.changed + w.untracked, unpushed: w.unpushed, lastCommitMs: w.lastCommitMs })
    }
  }
  for (const b of g.branches) {
    if (checkedOut.has(b.name) || b.unpushed === 0) continue
    loose.push({ kind: "branch", name: b.name, changed: 0, unpushed: b.unpushed, gone: b.gone, lastCommitMs: b.lastCommitMs })
  }
  return {
    isRepo: true,
    root: g.worktrees[0]?.path,
    remote: repoKey(g.remoteUrl),
    remoteName: g.remoteUrl?.replace(/\.git$/, "").split(/[/:]/).pop(),
    slug: g.remoteUrl?.replace(/\.git$/, "").replace(/\/+$/, "").split(/[/:]/).slice(-2).join("/"),
    hasRemote: g.hasRemote,
    branch: here?.branch,
    changed: (here?.changed ?? 0) + (here?.untracked ?? 0),
    untracked: here?.untracked ?? 0,
    ahead: here?.ahead ?? 0,
    behind: here?.behind ?? 0,
    unpushed: here?.unpushed ?? 0,
    looseEnds: loose,
    branches: g.branches.length ? Object.fromEntries(g.branches.map((b) => [b.name, { unpushed: b.unpushed, gone: b.gone }])) : undefined,
    observedAt: now,
    error: g.error,
  }
}

function same(a: RepoGit | undefined, b: RepoGit) {
  return !!a && a.remote === b.remote && a.root === b.root && a.branch === b.branch && a.changed === b.changed && a.unpushed === b.unpushed && a.ahead === b.ahead && a.behind === b.behind && a.error === b.error && JSON.stringify(a.looseEnds) === JSON.stringify(b.looseEnds) && JSON.stringify(a.branches) === JSON.stringify(b.branches)
}

/**
 * Read git for these folders (on `host`, or here) and keep it; one sync if anything changed.
 * `quick`: only each folder's own worktree (the 20 s rounds); the branch and worktree scan behind
 * "loose ends" is kept from the last full read (every 2 minutes). Unchanged state keeps its old
 * object, so nothing that shows it renders again.
 */
export async function readGit(paths: string[], host?: string, quick = false) {
  if (!paths.length) return
  try {
    const list = await invoke<RawGit[]>("git_state", { paths, host, quick })
    let changed = false
    list.forEach((g, i) => {
      const key = folderKey(host, paths[i])
      const prev = gitByFolder.get(key)
      // a read that failed (ssh down, folder busy) says nothing new: keep the last good state
      if (g.error && prev?.isRepo) return
      let next = toRepoGit(paths[i], g)
      if (quick && prev?.isRepo) next = { ...next, looseEnds: prev.looseEnds, branches: prev.branches }
      if (same(prev, next)) return
      changed = true
      gitByFolder.set(key, next)
    })
    if (changed) requestSync()
  } catch (e) {
    console.warn("git_state", e)
  }
}

/** git status lines a hook sent (`git status --porcelain=v2 --branch`) → the folder's state. */
export function gitFromPorcelain(machine: string, cwd: string, text: string) {
  if (!text.trim()) return
  const prev = gitByFolder.get(folderKey(machine, cwd))
  let branch: string | undefined
  let ahead = 0
  let behind = 0
  let changed = 0
  let untracked = 0
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice(14)
    else if (line.startsWith("# branch.ab ")) {
      const [a, b] = line.slice(12).split(" ")
      ahead = Number(a?.replace("+", "")) || 0
      behind = Number(b?.replace("-", "")) || 0
    } else if (/^[12u] /.test(line)) changed++
    else if (line.startsWith("? ")) untracked++
  }
  const next: RepoGit = {
    isRepo: true,
    root: prev?.root,
    remote: prev?.remote,
    remoteName: prev?.remoteName,
    slug: prev?.slug,
    hasRemote: prev?.hasRemote ?? true,
    branch: branch === "(detached)" ? undefined : branch,
    changed: changed + untracked,
    untracked,
    ahead,
    behind,
    unpushed: prev && prev.branch === branch ? prev.unpushed : ahead,
    looseEnds: prev?.looseEnds ?? [],
    branches: prev?.branches,
    observedAt: new Date().toISOString(),
  }
  if (!same(prev, next)) {
    gitByFolder.set(folderKey(machine, cwd), next)
    requestSync()
  }
}
