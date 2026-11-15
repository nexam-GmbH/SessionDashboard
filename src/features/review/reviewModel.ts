// Adapted from coollabsio/jean@1d53d3c:src/components/chat/git-diff-tree.ts (Apache-2.0). Modified for session-dashboard.
// Review model. Turns a session transcript's FileChanges into the
// review list: net change per path (first old text → last new text in scope),
// per-turn scoping (the Codex `turn/diff/updated` idea), and for the main agent
// the delegated child sessions grouped by repo. File tree builder (folders first,
// VS Code style compact folders) from Jean's git-diff-tree.ts.
import { isTestPath, lookFirst } from "@/features/requests/risk"
import { useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import type {
  FileChange,
  ID,
  Item,
  Session,
  Transcript,
  Turn,
} from "@/lib/model"
import { useApp, getApp } from "@/store/app"
import { homePath } from "@/lib/format"

// ---------- raw changes per owner session ----------
export interface RawChange {
  /** 1-based index of the owner's own turn */
  turn: number
  at: string
  change: FileChange
  /** proposed edit still awaiting approval: counted, never listed */
  pending?: boolean
}

interface OwnerCache {
  order: ID[]
  turns: Turn[]
  refs: Item[]
  changes: RawChange[]
}
const ownerCache = new Map<ID, OwnerCache>()

/**
 * Applied FileChanges of one transcript, in turn order. Memoized on the item
 * references that carry diffs, so streaming text (which replaces only the live
 * agent_message item) never re-derives the review.
 */
function ownerChanges(t: Transcript): RawChange[] {
  const hit = ownerCache.get(t.sessionId)
  if (
    hit &&
    hit.order === t.order &&
    hit.turns === t.turns &&
    hit.refs.every((r) => t.items[r.id] === r)
  )
    return hit.changes
  const refs: Item[] = []
  const changes: RawChange[] = []
  t.turns.forEach((turn, i) => {
    for (const id of turn.itemIds) {
      const it = t.items[id]
      if (it?.type !== "tool_call" || !it.call.diff?.length) continue
      refs.push(it)
      // Only applied edits are reviewable: awaiting approval, rejected or failed ones never touched the tree.
      const pending = it.call.display === "awaiting_permission"
      if (it.call.status !== "completed" && !pending) continue
      for (const change of it.call.diff)
        changes.push({ turn: i + 1, at: it.at, change, pending })
    }
  })
  ownerCache.set(t.sessionId, { order: t.order, turns: t.turns, refs, changes })
  return changes
}

// ---------- public model ----------
export interface ReviewFile {
  /** `${ownerId}::${path}` — also the key of the review mark */
  key: string
  ownerId: ID
  groupId: string
  path: string
  name: string
  dir: string
  op: FileChange["op"]
  oldText: string | null
  newText: string | null
  added: number
  removed: number
  edits: number
  lastAt: string
  /** worker highlight cache key: changes whenever the contents change */
  cacheKey: string
  /** why to look at it before the rest (secrets, CI, migration, auth, dependencies, deleted) */
  look?: string
}

export interface FolderNode {
  type: "folder"
  name: string
  fullPath: string
  children: TreeNode[]
}
export interface FileNode {
  type: "file"
  name: string
  file: ReviewFile
}
export type TreeNode = FolderNode | FileNode

export interface ReviewGroup {
  id: string
  sessionId: ID
  label: string
  sublabel: string
  root: FolderNode
  files: ReviewFile[]
  added: number
  removed: number
}

export interface TurnOption {
  index: number
  startedAt: string
  files: number
  pending: number
}

export interface ReviewModel {
  /** true for the main agent: groups are repos of delegated sessions */
  cross: boolean
  groups: ReviewGroup[]
  /** all files in tree order (group → folders first → name) */
  files: ReviewFile[]
  turns: TurnOption[]
  totals: { files: number; added: number; removed: number }
  /** edits in scope that are still waiting for approval in the session */
  pending: number
}

// ---------- helpers ----------
/** Net line counts without a full diff: multiset of removed/added lines (O(n)). */
export function countLines(oldText: string, newText: string) {
  const a = oldText ? oldText.replace(/\n$/, "").split("\n") : []
  const b = newText ? newText.replace(/\n$/, "").split("\n") : []
  const bag = new Map<string, number>()
  for (const l of a) bag.set(l, (bag.get(l) ?? 0) + 1)
  let added = 0
  for (const l of b) {
    const n = bag.get(l) ?? 0
    if (n > 0) bag.set(l, n - 1)
    else added++
  }
  let removed = 0
  for (const n of bag.values()) removed += n
  return { added, removed }
}

function hash(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function splitPath(path: string) {
  const i = path.lastIndexOf("/")
  return { name: path.slice(i + 1), dir: i > 0 ? path.slice(0, i) : "" }
}

interface Agg {
  ownerId: ID
  path: string
  first: FileChange
  last: FileChange
  edits: number
  lastAt: string
}

function toFile(a: Agg, groupId: string): ReviewFile {
  const created =
    a.first.op === "add" || (a.first.oldText === "" && a.first.op !== "delete")
  const deleted = a.last.op === "delete"
  const oldText = created ? null : a.first.oldText
  const newText = deleted ? null : a.last.newText
  const { added, removed } = countLines(oldText ?? "", newText ?? "")
  const key = `${a.ownerId}::${a.path}`
  return {
    key,
    ownerId: a.ownerId,
    groupId,
    path: a.path,
    ...splitPath(a.path),
    op: created
      ? "add"
      : deleted
        ? "delete"
        : a.last.op === "move"
          ? "move"
          : "modify",
    oldText,
    newText,
    added,
    removed,
    edits: a.edits,
    lastAt: a.lastAt,
    cacheKey: `${key}:${hash(oldText ?? "")}:${hash(newText ?? "")}`,
    look: lookFirst(a.path, created ? "add" : deleted ? "delete" : "modify"),
  }
}

// Tree builder after Jean's buildFileTree: folders first, then names; single-child
// folder chains collapse into one row ("src/components/ui").
function buildTree(files: ReviewFile[]): FolderNode {
  const root: FolderNode = {
    type: "folder",
    name: "",
    fullPath: "",
    children: [],
  }
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean)
    const name = segments.pop()
    if (!name) continue
    let folder = root
    let path = ""
    for (const seg of segments) {
      path = path ? `${path}/${seg}` : seg
      let next = folder.children.find(
        (c): c is FolderNode => c.type === "folder" && c.fullPath === path
      )
      if (!next) {
        next = { type: "folder", name: seg, fullPath: path, children: [] }
        folder.children.push(next)
      }
      folder = next
    }
    folder.children.push({ type: "file", name, file })
  }
  sortTree(root)
  compactTree(root)
  return root
}

function sortTree(node: FolderNode) {
  node.children.sort((a, b) =>
    a.type !== b.type
      ? a.type === "folder"
        ? -1
        : 1
      : a.name.localeCompare(b.name)
  )
  for (const c of node.children) if (c.type === "folder") sortTree(c)
}

function compactTree(node: FolderNode) {
  for (const c of node.children) if (c.type === "folder") compactTree(c)
  for (const c of node.children) {
    if (c.type !== "folder") continue
    let inner = c.children[0]
    while (c.children.length === 1 && inner?.type === "folder") {
      c.name = `${c.name}/${inner.name}`
      c.fullPath = inner.fullPath
      c.children = inner.children
      inner = c.children[0]
    }
  }
}

function collectFiles(node: FolderNode, out: ReviewFile[]) {
  for (const c of node.children) {
    if (c.type === "folder") collectFiles(c, out)
    else out.push(c.file)
  }
  return out
}

// ---------- owners (the session itself + delegated children for the main agent) ----------
export interface Owner {
  id: ID
  groupId: string
  label: string
  sublabel: string
}

function ownerFor(s: Session, main: boolean, dupRepo: boolean): Owner {
  const st = getApp()
  if (main || !s.repoId)
    return {
      id: s.id,
      groupId: `self:${s.id}`,
      label: main ? "main agent" : s.title,
      sublabel: homePath(s.cwd),
    }
  const repo = st.repos[s.repoId]
  const wt = s.worktreeId
    ? repo?.worktrees.find((w) => w.id === s.worktreeId)
    : undefined
  return {
    id: s.id,
    groupId: dupRepo ? `${s.repoId}:${s.id}` : s.repoId,
    label: dupRepo
      ? `${repo?.name ?? s.repoId} · ${s.handle}`
      : (repo?.name ?? s.repoId),
    sublabel: wt?.branch ?? repo?.defaultBranch ?? "",
  }
}

/** Sessions whose changes this review shows. Stable per structVersion. */
export function useOwners(sessionId: ID): Owner[] {
  const structVersion = useApp((s) => s.structVersion)
  const role = useApp((s) => s.sessions[sessionId]?.role)
  return useMemo(() => {
    const st = getApp()
    const self = st.sessions[sessionId]
    if (!self) return []
    if (role !== "main") return [ownerFor(self, false, false)]
    const children = Object.values(st.sessions)
      .filter(
        (c) =>
          c.parent?.sessionId === sessionId &&
          c.parent.kind === "delegated" &&
          !c.archived
      )
      .sort(
        (a, b) =>
          (a.repoId ?? "").localeCompare(b.repoId ?? "") ||
          a.createdAt.localeCompare(b.createdAt)
      )
    const perRepo = new Map<string, number>()
    for (const c of children)
      perRepo.set(c.repoId ?? "", (perRepo.get(c.repoId ?? "") ?? 0) + 1)
    return [
      ownerFor(self, true, false),
      ...children.map((c) =>
        ownerFor(c, false, (perRepo.get(c.repoId ?? "") ?? 0) > 1)
      ),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, role, structVersion])
}

/** Changes per owner (stable while only text streams); `null` entries until a transcript exists. */
export function useOwnerChanges(owners: Owner[]): (RawChange[] | null)[] {
  return useApp(
    useShallow((s) => {
      const out: (RawChange[] | null)[] = []
      for (const o of owners) {
        const t = s.transcripts[o.id]
        out.push(t ? ownerChanges(t) : null)
      }
      return out
    })
  )
}

const NO_TURNS: Turn[] = []

/**
 * The review model for a scope. For the main agent, "Turn N" is a time window of
 * the main transcript: changes delegated sessions made while the main agent was
 * on that turn.
 */
export function buildModel(
  owners: Owner[],
  changes: (RawChange[] | null)[],
  mainTurns: Turn[] | undefined,
  turn: number | "all",
  cross: boolean
): ReviewModel {
  const turns = mainTurns ?? NO_TURNS
  const starts = turns.map((t) => Date.parse(t.startedAt))
  const scopeTurn = (ownerIdx: number, c: RawChange) => {
    if (ownerIdx === 0 || !cross) return c.turn
    const at = Date.parse(c.at)
    let idx = 0
    for (let i = 0; i < starts.length; i++) if (starts[i] <= at) idx = i
    return idx + 1
  }

  const counts = new Map<number, Set<string>>()
  const pendingByTurn = new Map<number, number>()
  let pending = 0
  const aggs = new Map<string, Agg & { groupId: string }>()
  owners.forEach((o, oi) => {
    for (const c of changes[oi] ?? []) {
      const tn = scopeTurn(oi, c)
      if (c.pending) {
        pendingByTurn.set(tn, (pendingByTurn.get(tn) ?? 0) + 1)
        if (turn === "all" || tn === turn) pending++
        continue
      }
      const key = `${o.id}::${c.change.path}`
      let set = counts.get(tn)
      if (!set) counts.set(tn, (set = new Set()))
      set.add(key)
      if (turn !== "all" && tn !== turn) continue
      const prev = aggs.get(key)
      if (prev) {
        prev.last = c.change
        prev.edits++
        prev.lastAt = c.at
      } else {
        aggs.set(key, {
          ownerId: o.id,
          path: c.change.path,
          first: c.change,
          last: c.change,
          edits: 1,
          lastAt: c.at,
          groupId: o.groupId,
        })
      }
    }
  })

  const byGroup = new Map<string, ReviewFile[]>()
  for (const a of aggs.values()) {
    const f = toFile(a, a.groupId)
    let list = byGroup.get(a.groupId)
    if (!list) byGroup.set(a.groupId, (list = []))
    list.push(f)
  }

  const groups: ReviewGroup[] = []
  const files: ReviewFile[] = []
  let added = 0
  let removed = 0
  for (const o of owners) {
    const list = byGroup.get(o.groupId)
    if (!list?.length || groups.some((g) => g.id === o.groupId)) continue
    const root = buildTree(list)
    // the files worth a look first lead and tests come last, after the code they test (stable: the
    // tree order otherwise). Files shown first get the most attention in a review.
    const rank = (f: ReviewFile) => (f.look ? 0 : isTestPath(f.path) ? 2 : 1)
    const ordered = collectFiles(root, []).sort((a, b) => rank(a) - rank(b))
    const g: ReviewGroup = {
      id: o.groupId,
      sessionId: o.id,
      label: o.label,
      sublabel: o.sublabel,
      root,
      files: ordered,
      added: ordered.reduce((n, f) => n + f.added, 0),
      removed: ordered.reduce((n, f) => n + f.removed, 0),
    }
    groups.push(g)
    files.push(...ordered)
    added += g.added
    removed += g.removed
  }

  return {
    cross,
    groups,
    files,
    turns: turns.map((t, i) => ({
      index: i + 1,
      startedAt: t.startedAt,
      files: counts.get(i + 1)?.size ?? 0,
      pending: pendingByTurn.get(i + 1) ?? 0,
    })),
    totals: { files: files.length, added, removed },
    pending,
  }
}
