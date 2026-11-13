import { useMemo, useSyncExternalStore } from "react"
import { useShallow } from "zustand/react/shallow"
import type { FileChange, ID, Item, PendingRequest, ToolCall, Transcript } from "@/lib/model"
import { getApp, setApp, useApp } from "@/store/app"
import { answerQuestion, interrupt, removeQueued, resolvePermission, sendMessage, setSessionSettings } from "@/store/actions"

/**
 * Session-view store helpers (UI_PLAN §5.3, §8). Everything here selects the
 * smallest possible slice: rows select one item by id, the transcript shell
 * selects only `order`/`turns`/`liveItemId`, which keep their identity while
 * the live item streams (the mock streamer replaces only `items[liveId]`).
 */

const EMPTY_ORDER: ID[] = []
const EMPTY_TURNS: Transcript["turns"] = []
const EMPTY_QUEUE: Transcript["queued"] = []
const EMPTY_TODOS: Transcript["todos"] = []

export function useTranscriptShape(sessionId: ID) {
  return useApp(
    useShallow((s) => {
      const t = s.transcripts[sessionId]
      return {
        ready: !!t,
        order: t?.order ?? EMPTY_ORDER,
        turns: t?.turns ?? EMPTY_TURNS,
        liveItemId: t?.liveItemId,
      }
    }),
  )
}

export const useItem = (sessionId: ID, itemId: ID) =>
  useApp((s) => s.transcripts[sessionId]?.items[itemId])

export const useQueued = (sessionId: ID) => useApp((s) => s.transcripts[sessionId]?.queued ?? EMPTY_QUEUE)
export const useTodos = (sessionId: ID) => useApp((s) => s.transcripts[sessionId]?.todos ?? EMPTY_TODOS)

/** Tool items of a group, as a shallow-compared tuple (re-renders only when one of them changes). */
export const useItems = (sessionId: ID, ids: ID[]) =>
  useApp(useShallow((s) => ids.map((id) => s.transcripts[sessionId]?.items[id])))

/**
 * Stream coalescing: subscribe to one item and commit at most once per
 * animation frame, however fast the source updates. Idea from Cline's
 * desktop `use-chat-session.ts` (Apache-2.0) buffered stream flush.
 */
export function useCoalescedItem(sessionId: ID, itemId: ID): Item | undefined {
  const source = useMemo(() => {
    const read = () => getApp().transcripts[sessionId]?.items[itemId]
    let snapshot = read()
    return {
      subscribe(notify: () => void) {
        let raf = 0
        const unsub = useApp.subscribe(read, () => {
          if (raf) return
          raf = requestAnimationFrame(() => {
            raf = 0
            snapshot = read()
            notify()
          })
        })
        return () => {
          unsub()
          if (raf) cancelAnimationFrame(raf)
        }
      },
      get: () => snapshot,
    }
  }, [sessionId, itemId])
  return useSyncExternalStore(source.subscribe, source.get)
}

// ---------- view state that survives virtualization ----------
const values = new Map<string, unknown>()
const listeners = new Map<string, Set<() => void>>()

function subscribeKey(key: string, cb: () => void) {
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(cb)
  return () => {
    set.delete(cb)
  }
}

export function setUiValue(key: string, value: unknown) {
  values.set(key, value)
  listeners.get(key)?.forEach((l) => l())
}

export function getUiValue<T>(key: string, fallback: T): T {
  return values.has(key) ? (values.get(key) as T) : fallback
}

/** Small keyed view state outside React (expanded rows, dock focus), so rows can unmount while scrolled away. */
export function useUiValue<T>(key: string, fallback: T): T {
  return useSyncExternalStore(
    (cb) => subscribeKey(key, cb),
    () => (values.has(key) ? (values.get(key) as T) : fallback),
  )
}

export const setExpanded = (key: string, open: boolean) => setUiValue(key, open)

export function useExpanded(key: string, defaultOpen = false): [boolean, (open: boolean) => void] {
  const open = useUiValue(key, defaultOpen)
  return [open, (v: boolean) => setExpanded(key, v)]
}

/** Ask the attention dock of a session to show a specific request (activity bar → dock). */
export const focusDockRequest = (sessionId: ID, requestId: ID) => setUiValue(`dock:${sessionId}`, requestId)
export const useDockFocus = (sessionId: ID) => useUiValue<ID | null>(`dock:${sessionId}`, null)

// ---------- queue ----------
function patchTranscript(sessionId: ID, patch: (t: Transcript) => Partial<Transcript>) {
  setApp((s) => {
    const t = s.transcripts[sessionId]
    if (!t) return s
    return { transcripts: { ...s.transcripts, [sessionId]: { ...t, ...patch(t) } } }
  })
}

export function editQueued(sessionId: ID, queuedId: ID, text: string) {
  patchTranscript(sessionId, (t) => ({ queued: t.queued.map((q) => (q.id === queuedId ? { ...q, text } : q)) }))
}

/** "Steer": take a queued message out of the queue and send it now (SDK priority "now"). */
export function sendQueuedNow(sessionId: ID, queuedId: ID) {
  const q = getApp().transcripts[sessionId]?.queued.find((x) => x.id === queuedId)
  if (!q) return
  removeQueued(sessionId, queuedId)
  sendMessage(sessionId, q.text, "now", q.attachments)
}

/** Up arrow in an empty composer: pull the last queued message back for editing (Claude Code CLI). */
export function takeLastQueued(sessionId: ID): string | undefined {
  const t = getApp().transcripts[sessionId]
  const last = t?.queued.at(-1)
  if (!last) return undefined
  removeQueued(sessionId, last.id)
  return last.text
}

/** Interrupt + close the live item so its caret stops and the turn reads "interrupted". */
export function interruptSession(sessionId: ID) {
  const s = getApp().sessions[sessionId]
  if (!s || (s.status !== "working" && s.status !== "starting")) return
  interrupt(sessionId)
  patchTranscript(sessionId, (t) => {
    const items = { ...t.items }
    const live = t.liveItemId ? items[t.liveItemId] : undefined
    if (live?.type === "agent_message") items[live.id] = { ...live, streaming: false }
    for (const id of t.turns.at(-1)?.itemIds ?? []) {
      const it = items[id]
      if (it?.type === "tool_call" && (it.call.status === "in_progress" || it.call.status === "pending")) {
        items[id] = { ...it, call: { ...it.call, status: "cancelled", display: "cancelled", completedAt: new Date().toISOString() } }
      }
    }
    const last = t.turns.at(-1)
    const noticeId = `n_int_${sessionId}_${Date.now().toString(36)}`
    if (last) items[noticeId] = { type: "notice", id: noticeId, turnId: last.id, at: new Date().toISOString(), severity: "info", text: "Interrupted" }
    const turns = last
      ? [...t.turns.slice(0, -1), { ...last, status: "interrupted" as const, completedAt: new Date().toISOString(), itemIds: [...last.itemIds, noticeId] }]
      : t.turns
    return { items, liveItemId: undefined, turns, order: last ? [...t.order, noticeId] : t.order }
  })
}

// ---------- derived ----------
/** The tool call a pending request refers to (mock ids differ, so match on the awaiting tool). */
export function findPendingToolCall(req: PendingRequest): ToolCall | undefined {
  const t = getApp().transcripts[req.sessionId]
  if (!t || req.type !== "permission") return undefined
  for (let i = t.order.length - 1; i >= 0; i--) {
    const it = t.items[t.order[i]]
    if (it?.type === "tool_call" && it.call.display === "awaiting_permission" && it.call.name === req.toolName) return it.call
  }
  return undefined
}

export interface ChangedFile {
  path: string
  op: FileChange["op"]
  added: number
  removed: number
  edits: number
  pending: boolean
}

/** Net file changes of a session, from its transcript's FileChanges (latest op wins, counts add up). */
export function deriveChangedFiles(t: Transcript | undefined): ChangedFile[] {
  if (!t) return []
  const byPath = new Map<string, ChangedFile>()
  for (const id of t.order) {
    const it = t.items[id]
    if (it?.type !== "tool_call" || !it.call.diff) continue
    const pending = it.call.display === "awaiting_permission"
    for (const d of it.call.diff) {
      const prev = byPath.get(d.path)
      byPath.set(d.path, {
        path: d.path,
        op: prev?.op === "add" ? "add" : d.op,
        added: (prev?.added ?? 0) + d.added,
        removed: (prev?.removed ?? 0) + d.removed,
        edits: (prev?.edits ?? 0) + 1,
        pending: (prev?.pending ?? false) || pending,
      })
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

const changedCache = new Map<ID, { order: ID[]; value: ChangedFile[] }>()
/** Memoized on the transcript's `order` (diffs never change while text streams). */
/**
 * Number of delegated child sessions of a main agent (what its combined review shows); 0 for
 * standard sessions. Recounted only when the structure changes, not on every engine tick.
 */
let delegatedCache: { v: number; byParent: Map<ID, number> } | null = null
function delegatedIn(s: ReturnType<typeof getApp>, sessionId: ID): number {
  if (s.sessions[sessionId]?.role !== "main") return 0
  if (delegatedCache?.v !== s.structVersion) {
    const byParent = new Map<ID, number>()
    for (const id in s.sessions) {
      const c = s.sessions[id]
      if (c.parent?.kind === "delegated" && !c.archived) byParent.set(c.parent.sessionId, (byParent.get(c.parent.sessionId) ?? 0) + 1)
    }
    delegatedCache = { v: s.structVersion, byParent }
  }
  return delegatedCache.byParent.get(sessionId) ?? 0
}
export const useDelegatedCount = (sessionId: ID) => useApp((s) => delegatedIn(s, sessionId))
export const getDelegatedCount = (sessionId: ID) => delegatedIn(getApp(), sessionId)

export function useChangedFiles(sessionId: ID): ChangedFile[] {
  return useApp((s) => {
    const t = s.transcripts[sessionId]
    if (!t) return EMPTY_CHANGES
    const hit = changedCache.get(sessionId)
    if (hit && hit.order === t.order) return hit.value
    const value = deriveChangedFiles(t)
    changedCache.set(sessionId, { order: t.order, value })
    return value
  })
}
const EMPTY_CHANGES: ChangedFile[] = []

// ---------- resolve a request and keep the transcript in step ----------
type Outcome = "allowed" | "rejected" | "answered"

/** Mark the transcript's awaiting tool call as resolved (mock: the backend would stream this). */
function syncAwaitingTool(sessionId: ID, toolName: string, outcome: Outcome, output?: string) {
  patchTranscript(sessionId, (t) => {
    for (let i = t.order.length - 1; i >= 0; i--) {
      const it = t.items[t.order[i]]
      if (it?.type !== "tool_call" || it.call.display !== "awaiting_permission" || it.call.name !== toolName) continue
      const now = new Date().toISOString()
      const runs = outcome === "allowed" && toolName === "Bash"
      const call: ToolCall = runs
        ? { ...it.call, status: "in_progress", display: "running", completedAt: undefined }
        : outcome === "rejected"
          ? { ...it.call, status: "cancelled", display: "rejected", completedAt: now, output: output ?? it.call.output }
          : { ...it.call, status: "completed", display: "done", completedAt: now, output: output ?? it.call.output }
      return { items: { ...t.items, [it.id]: { ...it, call } } }
    }
    return {}
  })
}

/** resolvePermission + transcript sync. Use from the session view's cards. */
export function resolveRequest(req: PendingRequest, optionId: string, feedback?: string) {
  if (req.type === "question") return
  const option = req.options.find((o) => o.id === optionId)
  const rejected = option?.kind === "reject_once" || option?.kind === "reject_always"
  const prevMode = getApp().sessions[req.sessionId]?.permissionMode
  resolvePermission(req.id, optionId, feedback)
  // Workaround: store/actions resolvePermission spreads `permissionMode: undefined` into the
  // session for non-plan requests, wiping the mode. Restore it (reported upstream).
  if (prevMode && !getApp().sessions[req.sessionId]?.permissionMode) setSessionSettings(req.sessionId, { permissionMode: prevMode })
  if (req.type === "permission" && req.subagentId) return
  const tool = req.type === "plan" ? "ExitPlanMode" : req.toolName
  syncAwaitingTool(req.sessionId, tool, rejected ? "rejected" : "allowed", rejected && feedback ? `Rejected: ${feedback}` : undefined)
}

/** answerQuestion + transcript sync. */
export function answerRequest(req: PendingRequest, answers: Record<string, string | string[]>) {
  if (req.type !== "question") return
  answerQuestion(req.id, answers)
  const text = Object.entries(answers)
    .map(([q, a]) => `${q} → ${Array.isArray(a) ? a.join(", ") : a}`)
    .join("\n")
  syncAwaitingTool(req.sessionId, "AskUserQuestion", "answered", text)
}
