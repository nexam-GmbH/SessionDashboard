import { useMemo, useSyncExternalStore } from "react"
import { REAL } from "@/backend/mode"
import { useShallow } from "zustand/react/shallow"
import type { FileChange, ID, Item, PendingRequest, ToolCall, Transcript } from "@/lib/model"
import { getApp, setApp, useApp } from "@/store/app"
import { attachmentsText, takeImages } from "@/features/composer/images"
import { answerQuestion, interrupt, removeQueued, resolvePermission, sendMessage, setSessionSettings } from "@/store/actions"

/**
 * Session-view store helpers. Everything here selects the
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

// ---------- queue and drafts ----------
function patchTranscript(sessionId: ID, patch: (t: Transcript) => Partial<Transcript>) {
  setApp((s) => {
    const t = s.transcripts[sessionId]
    if (!t) return s
    return { transcripts: { ...s.transcripts, [sessionId]: { ...t, ...patch(t) } } }
  })
}

export type Queued = Transcript["queued"][number]
export interface Draft {
  text: string
  attachments: string[]
}
const EMPTY_DRAFT: Draft = { text: "", attachments: [] }

/**
 * What is typed in a session's prompt box, kept per session for as long as the app runs: switching
 * sessions and coming back finds it as you left it. Cleared when it is sent.
 */
export const useDraft = (sessionId: ID) => useUiValue<Draft>(`draft:${sessionId}`, EMPTY_DRAFT)
export const getDraft = (sessionId: ID) => getUiValue<Draft>(`draft:${sessionId}`, EMPTY_DRAFT)
export function setDraft(sessionId: ID, next: Draft | ((d: Draft) => Draft)) {
  setUiValue(`draft:${sessionId}`, typeof next === "function" ? next(getDraft(sessionId)) : next)
}

/**
 * Messages for a real session the app can't write to while it works (a headless one it started
 * before a restart): they wait here, outside its transcript (which is re-read from disk at times),
 * and go out together once its turn is over. Mock sessions queue in `Transcript.queued`.
 */
const outboxIds = new Set<ID>()
const outboxKey = (sessionId: ID) => `outbox:${sessionId}`
const getOutbox = (sessionId: ID) => getUiValue<Queued[]>(outboxKey(sessionId), EMPTY_QUEUE)
let outboxWatch: (() => void) | null = null

function setOutbox(sessionId: ID, items: Queued[]) {
  setUiValue(outboxKey(sessionId), items)
  if (items.length) outboxIds.add(sessionId)
  else outboxIds.delete(sessionId)
  if (outboxIds.size && !outboxWatch) outboxWatch = useApp.subscribe((s) => s.sessions, deliverOutbox)
  else if (!outboxIds.size && outboxWatch) {
    outboxWatch()
    outboxWatch = null
  }
}

/** Send what waits in the outbox of every session whose turn is over (in one message, like Claude Code's queue). */
function deliverOutbox() {
  for (const id of [...outboxIds]) {
    const s = getApp().sessions[id]
    const items = getOutbox(id)
    if (!s) {
      setOutbox(id, [])
      continue
    }
    if (s.status !== "idle" && s.status !== "done_unseen") continue
    // the one open in the prompt box stays until it is saved back
    const editing = getUiValue<QueueEdit | null>(`qedit:${id}`, null)?.id
    const ready = items.filter((q) => q.id !== editing)
    if (!ready.length) continue
    setOutbox(id, items.filter((q) => q.id === editing))
    const text = ready.map((q) => q.text).join("\n\n")
    const attachments = ready.flatMap((q) => q.attachments ?? [])
    // a terminal session continues here (nothing is lost; pictures go as images, other files by
    // name); one the app runs takes it as a message
    if (s.control === "observed") {
      const { images, rest } = takeImages(attachments)
      const body = `${text}${attachmentsText(rest)}`
      // a terminal session is never closed for this: typed into its terminal when it can be; only
      // a headless one the app itself started (before a restart) is taken back
      void import("@/backend/real").then(async (r) => {
        const way = await r.realInjectWay(id)
        if (way === "headless") return r.realTakeOver(id, body, images)
        if (way) return r.realInject(id, body).catch((e) => r.realNotice(id, `Could not type into its terminal: ${String(e)}`))
        r.realNotice(id, "Your queued message could not reach its terminal; it is back in the prompt box.")
        setDraft(id, { text, attachments: rest })
      })
    } else sendMessage(id, text, "now", attachments)
  }
}

export function useQueued(sessionId: ID) {
  const mock = useApp((s) => s.transcripts[sessionId]?.queued ?? EMPTY_QUEUE)
  const real = useUiValue<Queued[]>(outboxKey(sessionId), EMPTY_QUEUE)
  return REAL ? real : mock
}
const queuedOf = (sessionId: ID): Queued[] => (REAL ? getOutbox(sessionId) : (getApp().transcripts[sessionId]?.queued ?? EMPTY_QUEUE))

/** Add a message to the session's queue: sent when Claude is done with this turn. */
export function queueMessage(sessionId: ID, text: string, attachments?: string[]) {
  if (!REAL) return sendMessage(sessionId, text, "queue", attachments)
  setOutbox(sessionId, [...getOutbox(sessionId), { id: `q_${Date.now().toString(36)}_${outboxIds.size}`, text, ...(attachments?.length ? { attachments } : {}) }])
  deliverOutbox()
}

function editQueued(sessionId: ID, queuedId: ID, text: string, attachments: string[]) {
  const edit = (q: Queued): Queued => (q.id === queuedId ? { id: q.id, text, ...(attachments.length ? { attachments } : {}) } : q)
  if (REAL) setOutbox(sessionId, getOutbox(sessionId).map(edit))
  else patchTranscript(sessionId, (t) => ({ queued: t.queued.map(edit) }))
}

export function removeQueuedMessage(sessionId: ID, queuedId: ID) {
  if (getUiValue<QueueEdit | null>(`qedit:${sessionId}`, null)?.id === queuedId) cancelQueueEdit(sessionId)
  if (REAL) setOutbox(sessionId, getOutbox(sessionId).filter((q) => q.id !== queuedId))
  else removeQueued(sessionId, queuedId)
}

/** A queued message open in the prompt box for editing, and what the box held before. */
export interface QueueEdit {
  id: ID
  stash: Draft
}
export const useQueueEdit = (sessionId: ID) => useUiValue<QueueEdit | null>(`qedit:${sessionId}`, null)

/**
 * Open a queued message in the prompt box (↑ in an empty box takes the newest, the pencil any of
 * them). It stays in its place in the queue, marked; Enter puts it back, Esc cancels, an empty box
 * removes it.
 */
export function editQueuedInBox(sessionId: ID, queuedId?: ID): boolean {
  const list = queuedOf(sessionId)
  const q = queuedId ? list.find((x) => x.id === queuedId) : list.at(-1)
  if (!q) return false
  const cur = getUiValue<QueueEdit | null>(`qedit:${sessionId}`, null)
  setUiValue(`qedit:${sessionId}`, { id: q.id, stash: cur ? cur.stash : getDraft(sessionId) })
  setDraft(sessionId, { text: q.text, attachments: q.attachments ?? [] })
  return true
}

export function cancelQueueEdit(sessionId: ID) {
  const cur = getUiValue<QueueEdit | null>(`qedit:${sessionId}`, null)
  if (!cur) return
  setUiValue(`qedit:${sessionId}`, null)
  setDraft(sessionId, cur.stash)
}

/** Enter while editing: back into its place (or out of the queue, when emptied). */
export function saveQueueEdit(sessionId: ID, text: string, attachments: string[]) {
  const cur = getUiValue<QueueEdit | null>(`qedit:${sessionId}`, null)
  if (!cur) return
  const still = queuedOf(sessionId).some((q) => q.id === cur.id)
  setUiValue(`qedit:${sessionId}`, null)
  setDraft(sessionId, cur.stash)
  if (!text.trim() && !attachments.length) {
    if (still) removeQueuedMessage(sessionId, cur.id)
  } else if (still) editQueued(sessionId, cur.id, text.trim(), attachments)
  // it went out while you edited it: the edited text follows as a new message
  else queueMessage(sessionId, text.trim(), attachments)
  if (REAL) deliverOutbox()
}

/**
 * A message sent to a session the app runs while Claude works goes in at once (Claude Code reads
 * it after the current step). The prompt box says so until the transcript moves past it.
 */
export function markSteered(sessionId: ID) {
  setUiValue(`steer:${sessionId}`, getApp().transcripts[sessionId]?.order.length ?? 0)
}
export function useSteerPending(sessionId: ID): boolean {
  const at = useUiValue<number | null>(`steer:${sessionId}`, null)
  return useApp((s) => {
    if (at === null) return false
    const st = s.sessions[sessionId]?.status
    return (st === "working" || st === "starting") && (s.transcripts[sessionId]?.order.length ?? 0) <= at
  })
}

/** Interrupt + close the live item so its caret stops and the turn reads "interrupted". */
export function interruptSession(sessionId: ID) {
  const s = getApp().sessions[sessionId]
  if (!s || (s.status !== "working" && s.status !== "starting")) return
  interrupt(sessionId)
  // real sessions: claude ends the turn itself and the stream says so
  if (REAL) return
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
  // the app's sessions: the backend marked the exact tool call; the rest is the mock world's
  if (REAL) return
  // Workaround: store/actions resolvePermission spreads `permissionMode: undefined` into the
  // session for non-plan requests, wiping the mode. Restore it (reported upstream).
  if (prevMode && !getApp().sessions[req.sessionId]?.permissionMode) setSessionSettings(req.sessionId, { permissionMode: prevMode })
  if (req.type === "permission" && req.subagentId) return
  const tool = req.type === "plan" ? "ExitPlanMode" : req.toolName
  syncAwaitingTool(req.sessionId, tool, rejected ? "rejected" : "allowed", rejected && feedback ? `Rejected: ${feedback}` : undefined)
}

/** Skip Claude's question: it goes on with its own best judgement. */
export function skipQuestion(req: PendingRequest) {
  if (req.type !== "question") return
  if (REAL) return resolvePermission(req.id, "reject", "The user skipped this question. Continue with your best judgement.")
  answerQuestion(req.id, {})
}

/** answerQuestion + transcript sync. */
export function answerRequest(req: PendingRequest, answers: Record<string, string | string[]>) {
  if (req.type !== "question") return
  answerQuestion(req.id, answers)
  if (REAL) return
  const text = Object.entries(answers)
    .map(([q, a]) => `${q} → ${Array.isArray(a) ? a.join(", ") : a}`)
    .join("\n")
  syncAwaitingTool(req.sessionId, "AskUserQuestion", "answered", text)
}

/** Every queued message of a session goes (Claude Code desktop's "Clear all"). */
export function clearQueue(sessionId: ID) {
  for (const q of [...queuedOf(sessionId)]) removeQueuedMessage(sessionId, q.id)
  cancelQueueEdit(sessionId)
}

/**
 * Send a message now while Claude works: its current step is stopped and this message is read at
 * once (Ctrl+Enter, a queued message's "Send now"). An idle session simply gets it.
 */
export function interruptAndSend(sessionId: ID, text: string, attachments?: string[]) {
  const s = getApp().sessions[sessionId]
  if (!s) return
  const working = s.status === "working" || s.status === "starting"
  if (working && REAL && s.control === "owned") {
    interruptSession(sessionId)
    // claude reads its input in order: the interrupt ends the step, then this message starts a turn
    sendMessage(sessionId, text, "now", attachments)
    return
  }
  if (working && !REAL) interrupt(sessionId)
  sendMessage(sessionId, text, "now", attachments)
}

/** A queued message's "Send now". */
export function sendQueuedNow(sessionId: ID, queuedId: string) {
  const q = queuedOf(sessionId).find((x) => x.id === queuedId)
  if (!q) return
  removeQueuedMessage(sessionId, queuedId)
  interruptAndSend(sessionId, q.text, q.attachments)
}
