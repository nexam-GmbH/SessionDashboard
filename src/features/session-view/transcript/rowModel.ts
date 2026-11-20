// Adapted from BloopAI/vibe-kanban@5f06193:packages/web-core/src/features/workspace-chat/model/conversation-row-model.ts (Apache-2.0). Modified for session-dashboard.
// Changes: rows are built from our Transcript (turns of items); consecutive tool calls
// fold into one tool-group row (Claude Code desktop: "Read 3 files, edited 2 files"), and
// assistant text always breaks a fold so prose is never hidden; the transcript view decides
// whether thinking shows (Normal hides it, so the calls around it fold together); a finished
// turn that edited files ends with an "Edited N files" card; turns are grouped into virtual
// blocks; semantic keys are item ids so they stay stable while the live tail streams.
import type { ID, Item, Transcript, Turn } from "@/lib/model"
import { classifyTool } from "../tools/toolSummary"

/** Claude Code desktop's transcript views: tool calls folded; + thinking; every step open. */
export type TranscriptView = "normal" | "thinking" | "verbose"

export type Row =
  | { kind: "user"; key: string; itemId: ID; turnId: ID }
  | { kind: "thought"; key: string; itemId: ID; turnId: ID; durationMs?: number; live: boolean }
  | { kind: "agent"; key: string; itemId: ID; turnId: ID }
  | { kind: "tools"; key: string; itemIds: ID[]; turnId: ID; live: boolean }
  | { kind: "tool"; key: string; itemId: ID; turnId: ID }
  | { kind: "files"; key: string; itemId: ID; turnId: ID }
  | { kind: "edits"; key: string; itemIds: ID[]; turnId: ID }
  | { kind: "compaction"; key: string; itemId: ID }
  | { kind: "notice"; key: string; itemId: ID; turnId: ID }
  | { kind: "receipt"; key: string; turnId: ID; receipt: NonNullable<Turn["receipt"]> }
  | { kind: "done"; key: string; turnId: ID; promptId?: ID; durationMs: number; at?: string; tokens?: number }
  | { kind: "date"; key: string; turnId: ID; at: string }
  | { kind: "new"; key: string; turnId: ID }

/**
 * Walk `order` once. Item *types* never change after creation, so the row list
 * only changes when `order`, `turns` or the view change, never while text streams.
 * `newSince`: the time you had last looked; a "New since you last looked" line goes before the
 * first thing Claude wrote after it (not when there is nothing older above it).
 */
export function buildRows(order: ID[], items: Record<ID, Item>, turns: Turn[], view: TranscriptView = "normal", newSince?: string): Row[] {
  const rows: Row[] = []
  const turnById = new Map<ID, Turn>()
  for (const t of turns) turnById.set(t.id, t)
  const lastTurn = turns.at(-1)
  const liveTurn = lastTurn?.status === "in_progress" ? lastTurn.id : undefined
  let group: ID[] = []
  let groupTurn: ID | null = null
  let currentTurn: ID | null = null
  let edits: ID[] = []
  // a thought lasts until the next thing Claude produced (real transcripts carry no duration)
  let openThought: Extract<Row, { kind: "thought" }> | null = null
  let openThoughtAt = 0
  // a line with the day where the conversation crosses into another one
  let lastDay = ""
  let sinceMs = newSince ? Date.parse(newSince) || 0 : 0

  const flushGroup = () => {
    if (!group.length || !groupTurn) return
    const live = groupTurn === liveTurn
    if (group.length === 1) rows.push({ kind: "tool", key: group[0], itemId: group[0], turnId: groupTurn })
    else rows.push({ kind: "tools", key: `g:${group[0]}`, itemIds: group, turnId: groupTurn, live })
    group = []
    groupTurn = null
  }
  const closeTurn = (turnId: ID | null) => {
    if (!turnId) return
    const t = turnById.get(turnId)
    // "Edited 3 files": what the turn changed, once it is over
    if (edits.length && t && t.status !== "in_progress") rows.push({ kind: "edits", key: `e:${turnId}`, itemIds: edits, turnId })
    edits = []
    if (t?.receipt) rows.push({ kind: "receipt", key: `r:${turnId}`, turnId, receipt: t.receipt })
    // "✻ Cooked for 26s · done 19:49", as Claude Code ends a turn
    else if (t?.durationMs !== undefined && t.status !== "in_progress") {
      const promptId = items[t.itemIds[0]]?.type === "user_message" ? t.itemIds[0] : undefined
      rows.push({ kind: "done", key: `d:${turnId}`, turnId, promptId, durationMs: t.durationMs, at: t.completedAt, tokens: t.outputTokens })
    }
  }

  for (const id of order) {
    const it = items[id]
    if (!it) continue
    if (openThought) {
      if (openThought.durationMs === undefined) openThought.durationMs = Math.max(0, Date.parse(it.at) - openThoughtAt) || undefined
      openThought.live = false
      openThought = null
    }
    if (it.turnId !== currentTurn && turnById.has(it.turnId)) {
      flushGroup()
      closeTurn(currentTurn)
      currentTurn = it.turnId
    }
    // your own prompt is not news (sent from a terminal after your last look here): the line goes
    // before what Claude wrote; the steps before it fold on their own, the new ones under the line
    if (sinceMs && it.type !== "user_message" && Date.parse(it.at) > sinceMs) {
      flushGroup()
      if (rows.length) rows.push({ kind: "new", key: `new:${id}`, turnId: it.turnId })
      sinceMs = 0
    }
    // files Claude handed you are a message to you, not a step to fold away
    if (it.type === "tool_call" && it.call.name === "SendUserFile") {
      flushGroup()
      rows.push({ kind: "files", key: id, itemId: id, turnId: it.turnId })
      continue
    }
    if (it.type === "tool_call") {
      if (groupTurn && groupTurn !== it.turnId) flushGroup()
      group.push(id)
      groupTurn = it.turnId
      if (it.call.diff?.length && classifyTool(it.call.name) === "edit") edits.push(id)
      continue
    }
    // Normal view: thinking is not shown, and the calls on either side of it fold together
    if (it.type === "thought" && view === "normal") continue
    flushGroup()
    switch (it.type) {
      case "user_message": {
        const day = it.at.slice(0, 10)
        if (day && day !== lastDay) {
          if (lastDay) rows.push({ kind: "date", key: `day:${id}`, turnId: it.turnId, at: it.at })
          lastDay = day
        }
        rows.push({ kind: "user", key: id, itemId: id, turnId: it.turnId })
        break
      }
      case "thought": {
        const row: Extract<Row, { kind: "thought" }> = { kind: "thought", key: id, itemId: id, turnId: it.turnId, durationMs: it.durationMs, live: it.turnId === liveTurn }
        rows.push(row)
        openThought = row
        openThoughtAt = Date.parse(it.at)
        break
      }
      case "agent_message":
        rows.push({ kind: "agent", key: id, itemId: id, turnId: it.turnId })
        break
      case "compaction":
        closeTurn(currentTurn)
        currentTurn = null
        rows.push({ kind: "compaction", key: id, itemId: id })
        break
      case "notice":
        rows.push({ kind: "notice", key: id, itemId: id, turnId: it.turnId })
        break
    }
  }
  // the newest thought of a turn that is over is not live either
  if (openThought && openThought.turnId !== liveTurn) openThought.live = false
  flushGroup()
  closeTurn(currentTurn)
  return rows
}

/**
 * The height an answer will take, by what it is made of: wrapped prose at 21 px a line, code at
 * 19 px a line plus the box, table rows at ~30 px, headings and lists a little taller. Close
 * enough that a row barely changes size when it is measured (each change moves the chat under the
 * wheel).
 */
function markdownHeight(text: string, cpl: number): number {
  let h = 0
  let inCode = false
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      h += inCode ? 14 : 24
      inCode = !inCode
      continue
    }
    if (inCode) h += 19
    else if (line.startsWith("|")) h += /^\|[\s:|-]+\|?\s*$/.test(line) ? 0 : 30
    else if (/^#{1,6}\s/.test(line)) h += 34
    else if (!line.trim()) h += 10
    else h += Math.max(1, Math.ceil(line.length / cpl)) * 21 + (/^\s*([-*]|\d+\.)\s/.test(line) ? 4 : 0)
  }
  return Math.max(23, h)
}

/** Coarse first-paint height per row; ResizeObserver measurement corrects it. */
export function estimateRow(row: Row, items: Record<ID, Item>, width: number): number {
  // 15 px prose in a column of at most 768 px (32 px gutters)
  const charsPerLine = Math.max(40, Math.floor(Math.min(width - 64, 768) / 7.8))
  const textLines = (text: string, cpl = charsPerLine) => {
    let n = 0
    for (const para of text.split("\n")) n += Math.max(1, Math.ceil(para.length / cpl))
    return n
  }
  switch (row.kind) {
    case "user": {
      const it = items[row.itemId]
      // right-aligned bubble, at most 85% of the column
      const shell = it?.type === "user_message" && it.shell ? 28 + Math.min(`${it.shell.stdout}\n${it.shell.stderr}`.trim().split("\n").length, 14) * 19 : 0
      return 60 + shell + Math.min(it?.type === "user_message" ? textLines(it.text, Math.floor(charsPerLine * 0.85)) : 1, 12) * 21
    }
    case "agent": {
      const it = items[row.itemId]
      return it?.type === "agent_message" ? markdownHeight(it.text, charsPerLine) : 42
    }
    case "tools":
    case "tool":
      return 28
    case "edits":
      return 44 + Math.min(row.itemIds.length, 4) * 32
    case "files":
      return 80
    case "thought":
      return 28
    case "receipt":
      return 26
    case "done":
      return 24
    case "date":
    case "new":
      return 20
    case "compaction":
      return 36
    case "notice":
      return 44
  }
}

/**
 * Virtual items are whole turns (user → thought → tools → answer → receipt), with
 * compaction dividers on their own. Five times fewer virtual items than rows keeps
 * TanStack's measurement pass cheap on 10k-item transcripts; rows inside a block
 * stay individually memoized.
 */
export interface Block {
  key: string
  turnId: ID | null
  rows: Row[]
  /** space above each row, in px */
  gaps: number[]
}

const STEP = new Set<Row["kind"]>(["tool", "tools", "thought"])

/**
 * Claude Code desktop's rhythm: 24 px before a new turn, 8 px from your message to the reply,
 * 20 px between the items of a reply; one-line steps stack with no gap (each is 28 px tall).
 */
function gapBefore(prev: Row | undefined, row: Row): number {
  if (!prev) return 0
  // a line (the day, "New since you last looked") sits closer to what it heads
  if (prev.kind === "date" || prev.kind === "new") return row.kind === "user" || row.kind === "date" ? 8 : 12
  if (row.kind === "user") return 24
  if (row.kind === "date" || row.kind === "new" || row.kind === "compaction") return 24
  if (row.kind === "done" || row.kind === "receipt" || prev.kind === "user") return 8
  return STEP.has(prev.kind) && STEP.has(row.kind) ? 0 : 20
}

export function groupBlocks(rows: Row[]): Block[] {
  const blocks: Block[] = []
  let cur: Block | null = null
  let prev: Row | undefined
  for (const r of rows) {
    const t = r.kind === "compaction" ? null : r.turnId
    if (r.kind === "compaction" || !cur || cur.turnId !== t) {
      cur = { key: `b:${r.key}`, turnId: t, rows: [], gaps: [] }
      blocks.push(cur)
    }
    cur.rows.push(r)
    cur.gaps.push(gapBefore(prev, r))
    prev = r
    if (r.kind === "compaction") cur = null
  }
  return blocks
}

export function estimateBlock(block: Block, items: Record<ID, Item>, width: number) {
  let h = 0
  block.rows.forEach((r, i) => (h += estimateRow(r, items, width) + block.gaps[i]))
  return h
}

/** Index of the first block of the last turn: the live tail rendered outside the virtualizer. */
export function tailStartIndex(blocks: Block[], turns: Transcript["turns"]): number {
  const last = turns.at(-1)
  if (!last) return blocks.length
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].turnId === last.id) return i
  return Math.max(0, blocks.length - 1)
}
