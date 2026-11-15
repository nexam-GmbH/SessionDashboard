// Claude Code JSONL / stream-json records → the chat's Transcript (turns and items). Idempotent by
// record uuid, so the same record arriving from the live stream and later from the file tail is
// applied once. Partial text from the stream (`stream_event` text deltas) shows as a streaming
// agent message until the final assistant record replaces it.
import type { FileChange, ID, Item, ToolCall, ToolKind, Transcript, Turn, Picture } from "@/lib/model"
import { normPath } from "@/lib/format"
import { classifyTool } from "@/features/session-view/tools/toolSummary"

type Usage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } }
type Rec = Record<string, unknown> & { type?: string; uuid?: string; timestamp?: string; message?: { id?: string; role?: string; content?: unknown; model?: string; stop_reason?: string; usage?: Usage } }
type Block = Record<string, unknown> & { type?: string }

/** Per-transcript bookkeeping that is not part of the UI model. */
export interface MapState {
  seen: Set<string>
  /** tool_use id → item id */
  tools: Map<string, ID>
  /** message id → item id of its streaming placeholder */
  live: Map<string, ID>
  /** user messages sent from the app, waiting for their record (text → item id) */
  pending: Map<string, ID>
}

export function emptyTranscript(sessionId: ID): Transcript {
  return { sessionId, turns: [], order: [], items: {}, queued: [], todos: [] }
}
export function newMapState(): MapState {
  return { seen: new Set(), tools: new Map(), live: new Map(), pending: new Map() }
}

const FAMILY_KIND: Record<string, ToolKind> = {
  read: "read",
  edit: "edit",
  command: "execute",
  search: "search",
  graph: "search",
  web: "fetch",
  plan: "switch_mode",
  todo: "think",
}

function userText(r: Rec): string | null {
  if (r.isMeta || r.isCompactSummary) return null
  const c = r.message?.content
  let text = ""
  if (typeof c === "string") text = c
  else if (Array.isArray(c)) {
    for (const p of c as Block[]) {
      if (p.type === "tool_result") return null
      if (p.type === "text" && typeof p.text === "string") text += p.text
    }
  } else return null
  text = text.trim()
  if (!text || text.startsWith("<") || text.startsWith("Caveat:")) return null
  return text
}

/** Pictures in message content: base64 blocks become data: URLs. */
function picturesOf(content: unknown): Picture[] {
  if (!Array.isArray(content)) return []
  const out: Picture[] = []
  for (const b of content as Block[]) {
    if (b.type !== "image") continue
    const src = (b as unknown as { source?: { type?: string; media_type?: string; data?: string; url?: string } }).source
    if (src?.type === "base64" && src.data) out.push({ src: `data:${src.media_type ?? "image/png"};base64,${src.data}`, mediaType: src.media_type })
    else if (src?.url) out.push({ src: src.url, mediaType: src.media_type })
  }
  return out
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return (content as Block[]).map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : "")).join("")
  return ""
}

function count(text: string) {
  return text ? text.split("\n").length : 0
}

function toolTitle(name: string, input: Record<string, unknown>) {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "")
  return s("description") || s("command") || s("file_path") || s("pattern") || s("url") || s("query") || name
}

function diffFor(name: string, input: Record<string, unknown>): FileChange[] | undefined {
  const path = typeof input.file_path === "string" ? normPath(input.file_path) : undefined
  if (!path) return undefined
  if (name === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    return [{ path, op: "modify", oldText: input.old_string, newText: input.new_string, added: count(input.new_string), removed: count(input.old_string) }]
  }
  if (name === "Write" && typeof input.content === "string") {
    return [{ path, op: "add", oldText: "", newText: input.content, added: count(input.content), removed: 0 }]
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const edits = input.edits as { old_string?: string; new_string?: string }[]
    const oldText = edits.map((e) => e.old_string ?? "").join("\n…\n")
    const newText = edits.map((e) => e.new_string ?? "").join("\n…\n")
    return [{ path, op: "modify", oldText, newText, added: count(newText), removed: count(oldText) }]
  }
  return undefined
}

/** Mutable builder over a copy of the transcript (one store update per batch). */
class Builder {
  t: Transcript
  st: MapState
  constructor(base: Transcript, st: MapState) {
    this.st = st
    this.t = { ...base, items: { ...base.items }, order: base.order.slice(), turns: base.turns.slice() }
  }
  turn(): Turn {
    let last = this.t.turns.at(-1)
    if (!last) {
      last = { id: `turn_start_${this.t.sessionId}`, sessionId: this.t.sessionId, status: "completed", startedAt: new Date().toISOString(), itemIds: [] }
      this.t.turns.push(last)
    }
    return last
  }
  add(item: Item) {
    const turn = this.turn()
    this.t.items[item.id] = item
    this.t.order.push(item.id)
    this.t.turns[this.t.turns.length - 1] = { ...turn, itemIds: [...turn.itemIds, item.id] }
  }
  newTurn(id: string, at: string) {
    const prev = this.t.turns.at(-1)
    if (prev && prev.status === "in_progress") this.t.turns[this.t.turns.length - 1] = { ...prev, status: "completed", completedAt: at }
    this.t.turns.push({ id, sessionId: this.t.sessionId, status: "in_progress", startedAt: at, itemIds: [] })
  }
  patchTool(toolUseId: string, patch: (c: ToolCall) => ToolCall) {
    const id = this.st.tools.get(toolUseId)
    const it = id ? this.t.items[id] : undefined
    if (it?.type === "tool_call") this.t.items[it.id] = { ...it, call: patch(it.call) }
  }
}

function applyRecord(b: Builder, r: Rec) {
  const at = r.timestamp ?? new Date().toISOString()
  const uuid = r.uuid
  if (uuid) {
    if (b.st.seen.has(uuid)) return
    b.st.seen.add(uuid)
  }
  if (r.type === "user") {
    let text = userText(r)
    // a message that is only pictures (photos you sent) still is your message
    const pics = !r.isMeta ? picturesOf(r.message?.content) : []
    const hasResult = Array.isArray(r.message?.content) && (r.message!.content as Block[]).some((p) => p.type === "tool_result")
    if (text == null && pics.length && !hasResult) text = ""
    if (text != null && text.startsWith("[Request interrupted")) {
      b.add({ type: "notice", id: uuid ?? `n_${b.t.order.length}`, turnId: b.turn().id, at, severity: "info", text: "Interrupted" })
      return
    }
    if (text != null) {
      // a message sent from the app: its local placeholder becomes this record
      const pend = b.st.pending.get(text)
      if (pend) {
        b.st.pending.delete(text)
        return
      }
      b.newTurn(uuid ?? `turn_${b.t.order.length}`, at)
      b.add({ type: "user_message", id: uuid ?? `u_${b.t.order.length}`, turnId: b.turn().id, at, text, ...(pics.length ? { images: pics } : {}) })
      return
    }
    if (r.isCompactSummary) {
      b.add({ type: "compaction", id: uuid ?? `c_${b.t.order.length}`, turnId: b.turn().id, at, trigger: "auto", preTokens: 0 })
      return
    }
    const content = r.message?.content
    if (Array.isArray(content)) {
      for (const p of content as Block[]) {
        if (p.type !== "tool_result" || typeof p.tool_use_id !== "string") continue
        const failed = p.is_error === true
        const output = textOf(p.content).slice(0, 12000)
        const denied = failed && /denied|rejected|doesn't want/i.test(output)
        const images = picturesOf(p.content)
        // SendUserFile: the files as delivered (size, type, claude.ai's id)
        const att = (r as unknown as { toolUseResult?: { attachments?: { path?: string; size?: number; media_type?: string; file_uuid?: string }[] } }).toolUseResult?.attachments
        b.patchTool(p.tool_use_id, (c) => ({
          ...c,
          status: failed ? "failed" : "completed",
          display: denied ? "rejected" : failed ? "failed" : "done",
          output,
          completedAt: at,
          ...(images.length ? { images } : {}),
          ...(Array.isArray(att) && att.length
            ? { files: att.filter((a) => a.path).map((a) => ({ path: a.path!, name: a.path!.split(/[\\/]/).pop() ?? a.path!, size: a.size, mediaType: a.media_type, fileUuid: a.file_uuid })) }
            : {}),
        }))
      }
    }
    return
  }
  if (r.type === "assistant") {
    // the prompt cache after this call: how much it holds, when, and for how long it stays warm
    const u = r.message?.usage
    if (u && !r.isSidechain && r.message?.model && r.message.model !== "<synthetic>") {
      const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
      const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
      const ttl = w1 > 0 ? 3600 : w5 > 0 ? 300 : (b.t.lastCall?.ttl ?? 300)
      if (tokens > 0 && (!b.t.lastCall || at >= b.t.lastCall.at)) b.t.lastCall = { at, tokens, ttl, model: r.message.model }
    }
    const msgId = r.message?.id
    const content = r.message?.content
    if (!Array.isArray(content)) return
    // the final record replaces the streaming placeholder of the same message
    if (msgId && b.st.live.has(msgId)) {
      const liveId = b.st.live.get(msgId)!
      b.st.live.delete(msgId)
      delete b.t.items[liveId]
      b.t.order = b.t.order.filter((x) => x !== liveId)
      b.t.turns = b.t.turns.map((t) => (t.itemIds.includes(liveId) ? { ...t, itemIds: t.itemIds.filter((x) => x !== liveId) } : t))
      if (b.t.liveItemId === liveId) b.t.liveItemId = undefined
    }
    ;(content as Block[]).forEach((p, i) => {
      const id = `${uuid ?? msgId ?? b.t.order.length}:${i}`
      const turnId = b.turn().id
      b.t.thinkingNow = p.type === "thinking"
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
        b.add({ type: "agent_message", id, turnId, at, text: p.text, streaming: false })
      } else if (p.type === "thinking") {
        // hidden reasoning is stored without text: nothing to show
        if (typeof p.thinking === "string" && p.thinking.trim()) b.add({ type: "thought", id, turnId, at, text: p.thinking })
      } else if (p.type === "tool_use" && typeof p.id === "string") {
        const name = typeof p.name === "string" ? p.name : "tool"
        const input = (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>
        const call: ToolCall = {
          id: p.id,
          name,
          kind: FAMILY_KIND[classifyTool(name)] ?? "other",
          title: toolTitle(name, input),
          status: "in_progress",
          display: "running",
          input,
          diff: diffFor(name, input),
          terminal: name === "Bash" && typeof input.command === "string" ? { command: input.command } : undefined,
          locations: typeof input.file_path === "string" ? [{ path: normPath(input.file_path) }] : undefined,
          startedAt: at,
          // files Claude hands you: known from the call, completed by its result
          ...(name === "SendUserFile" && Array.isArray(input.files)
            ? { files: (input.files as unknown[]).filter((f): f is string => typeof f === "string").map((f) => ({ path: f, name: f.split(/[\\/]/).pop() ?? f })), caption: typeof input.caption === "string" ? input.caption : undefined }
            : {}),
        }
        b.st.tools.set(p.id, id)
        b.add({ type: "tool_call", id, turnId, at, call })
        if (name === "TodoWrite" && Array.isArray(input.todos)) b.t.todos = input.todos as Transcript["todos"]
      }
    })
    return
  }
  if (r.type === "system") {
    const sub = r.subtype as string | undefined
    if (sub === "compact_boundary") {
      b.add({ type: "compaction", id: uuid ?? `c_${b.t.order.length}`, turnId: b.turn().id, at, trigger: "auto", preTokens: 0 })
    } else if (sub === "turn_duration") {
      // the turn ended: Claude Code's own measure of how long it took ("Cooked for 26s")
      const ms = (r as unknown as { durationMs?: number }).durationMs
      const last = b.t.turns[b.t.turns.length - 1]
      if (last) b.t.turns[b.t.turns.length - 1] = { ...last, status: last.status === "in_progress" ? "completed" : last.status, completedAt: at, ...(typeof ms === "number" ? { durationMs: ms } : {}) }
    } else if (r.level === "error" || sub === "api_error") {
      const text = typeof r.content === "string" ? r.content : "Error"
      b.add({ type: "notice", id: uuid ?? `n_${b.t.order.length}`, turnId: b.turn().id, at, severity: "error", text: text.slice(0, 500) })
    } else if (sub === "away_summary" && typeof r.content === "string") {
      // Claude Code's recap for when you come back ("Goal was …; next: …")
      b.t.recap = { text: r.content.replace(/\s*\(disable recaps in \/config\)\s*$/, "").slice(0, 600), at }
    } else if (sub === "informational" && typeof r.content === "string" && uuid?.startsWith("note-")) {
      // a note the app itself adds (an MCP server's sign-in opened in the browser, …)
      b.add({ type: "notice", id: uuid, turnId: b.turn().id, at, severity: "info", text: r.content.slice(0, 500) })
    }
  }
}

/** Apply records (from the file or the live stream) to a transcript. */
export function applyRecords(base: Transcript, st: MapState, records: Rec[], opts: { running?: boolean } = {}): Transcript {
  // nothing new (the 1.5 s tail re-reads what the stream already delivered): the same object, so
  // the chat does not render again
  const fresh = records.some((r) => !r.uuid || !st.seen.has(r.uuid))
  const open = base.turns.at(-1)
  if (!fresh && !(open && !opts.running && open.status === "in_progress")) return base
  const b = new Builder(base, st)
  for (const r of records) applyRecord(b, r)
  // the last turn is in progress only while the session runs
  const last = b.t.turns.at(-1)
  if (last && !opts.running && last.status === "in_progress") b.t.turns[b.t.turns.length - 1] = { ...last, status: "completed" }
  return b.t
}

/** A text delta from `stream_event` (owned sessions): grows the streaming placeholder. */
export function applyTextDelta(base: Transcript, st: MapState, msgId: string, delta: string): Transcript {
  // a token for the message already streaming: only that item changes (order and turns keep their
  // identity, so the other rows of the chat stay as they are)
  const live = st.live.get(msgId)
  const cur = live ? base.items[live] : undefined
  if (cur?.type === "agent_message") return { ...base, items: { ...base.items, [cur.id]: { ...cur, text: cur.text + delta } } }
  const b = new Builder(base, st)
  let id = st.live.get(msgId)
  if (!id) {
    id = `live:${msgId}`
    st.live.set(msgId, id)
    b.add({ type: "agent_message", id, turnId: b.turn().id, at: new Date().toISOString(), text: delta, streaming: true })
    b.t.liveItemId = id
  } else {
    const it = b.t.items[id]
    if (it?.type === "agent_message") b.t.items[id] = { ...it, text: it.text + delta }
  }
  return b.t
}

/** A user message sent from the app, shown at once (its record later dedupes against it). */
export function addPendingUser(base: Transcript, st: MapState, text: string, attachments?: string[], images?: string[]): Transcript {
  const b = new Builder(base, st)
  const at = new Date().toISOString()
  const id = `pending:${crypto.randomUUID()}`
  st.pending.set(text.trim(), id)
  b.newTurn(`turn:${id}`, at)
  b.add({ type: "user_message", id, turnId: b.turn().id, at, text, ...(attachments?.length ? { attachments } : {}), ...(images?.length ? { images: images.map((src) => ({ src })) } : {}) })
  return b.t
}

/** Mark a pending tool call as waiting for the user's permission. */
export function markAwaiting(base: Transcript, st: MapState, toolUseId: string, waiting: boolean): Transcript {
  const b = new Builder(base, st)
  b.patchTool(toolUseId, (c) => ({ ...c, display: waiting ? "awaiting_permission" : "running" }))
  return b.t
}

/** End of a turn (stream `result`): close it and stop any streaming placeholder. */
export function endTurn(base: Transcript, st: MapState, failed: boolean): Transcript {
  const b = new Builder(base, st)
  const last = b.t.turns.at(-1)
  if (last && last.status === "in_progress") b.t.turns[b.t.turns.length - 1] = { ...last, status: failed ? "failed" : "completed", completedAt: new Date().toISOString() }
  for (const [, id] of st.live) {
    const it = b.t.items[id]
    if (it?.type === "agent_message") b.t.items[id] = { ...it, streaming: false }
  }
  st.live.clear()
  b.t.liveItemId = undefined
  return b.t
}
