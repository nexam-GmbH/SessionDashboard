// Adapted from BloopAI/vibe-kanban@5f06193:packages/web-core/src/features/workspace-chat/model/conversation-row-model.ts (Apache-2.0). Modified for session-dashboard.
// Changes: rows are built from our Transcript (turns of items); consecutive tool calls
// fold into one tool-group row; turns are grouped into virtual blocks; semantic keys
// are item ids so they stay stable while the live tail streams; size hints are tuned
// for 13px IDE density.
import type { ID, Item, Transcript, Turn } from "@/lib/model"

export type Row =
  | { kind: "user"; key: string; itemId: ID; turnId: ID }
  | { kind: "thought"; key: string; itemId: ID; turnId: ID }
  | { kind: "agent"; key: string; itemId: ID; turnId: ID }
  | { kind: "tools"; key: string; itemIds: ID[]; turnId: ID; live: boolean }
  | { kind: "tool"; key: string; itemId: ID; turnId: ID }
  | { kind: "files"; key: string; itemId: ID; turnId: ID }
  | { kind: "compaction"; key: string; itemId: ID }
  | { kind: "notice"; key: string; itemId: ID; turnId: ID }
  | { kind: "receipt"; key: string; turnId: ID; receipt: NonNullable<Turn["receipt"]> }
  | { kind: "done"; key: string; turnId: ID; durationMs: number; at?: string }

/**
 * Walk `order` once. Item *types* never change after creation, so the row list
 * only changes when `order` or `turns` change (append), never while text streams.
 */
export function buildRows(order: ID[], items: Record<ID, Item>, turns: Turn[]): Row[] {
  const rows: Row[] = []
  const turnById = new Map<ID, Turn>()
  for (const t of turns) turnById.set(t.id, t)
  const lastTurn = turns.at(-1)
  let group: ID[] = []
  let groupTurn: ID | null = null
  let currentTurn: ID | null = null

  const flushGroup = () => {
    if (!group.length || !groupTurn) return
    const live = groupTurn === lastTurn?.id && lastTurn.status === "in_progress"
    if (group.length === 1 && !live) rows.push({ kind: "tool", key: group[0], itemId: group[0], turnId: groupTurn })
    else rows.push({ kind: "tools", key: `g:${group[0]}`, itemIds: group, turnId: groupTurn, live })
    group = []
    groupTurn = null
  }
  const closeTurn = (turnId: ID | null) => {
    if (!turnId) return
    const t = turnById.get(turnId)
    if (t?.receipt) rows.push({ kind: "receipt", key: `r:${turnId}`, turnId, receipt: t.receipt })
    // "✻ Cooked for 26s · done 19:49", as Claude Code ends a turn
    else if (t?.durationMs !== undefined && t.status !== "in_progress") rows.push({ kind: "done", key: `d:${turnId}`, turnId, durationMs: t.durationMs, at: t.completedAt })
  }

  for (const id of order) {
    const it = items[id]
    if (!it) continue
    if (it.turnId !== currentTurn && turnById.has(it.turnId)) {
      flushGroup()
      closeTurn(currentTurn)
      currentTurn = it.turnId
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
      continue
    }
    flushGroup()
    switch (it.type) {
      case "user_message":
        rows.push({ kind: "user", key: id, itemId: id, turnId: it.turnId })
        break
      case "thought":
        rows.push({ kind: "thought", key: id, itemId: id, turnId: it.turnId })
        break
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
  flushGroup()
  closeTurn(currentTurn)
  return rows
}

/** Coarse first-paint height per row; ResizeObserver measurement corrects it. */
export function estimateRow(row: Row, items: Record<ID, Item>, width: number): number {
  const charsPerLine = Math.max(40, Math.floor((Math.min(width, 1140) - 40) / 7.1))
  const textLines = (text: string, cpl = charsPerLine) => {
    let n = 0
    for (const para of text.split("\n")) n += Math.max(1, Math.ceil(para.length / cpl))
    return n
  }
  switch (row.kind) {
    case "user": {
      const it = items[row.itemId]
      // right-aligned bubble, at most 85% of the column
      return 32 + (it?.type === "user_message" ? textLines(it.text, Math.floor(charsPerLine * 0.85)) : 1) * 20
    }
    case "agent": {
      const it = items[row.itemId]
      return 12 + (it?.type === "agent_message" ? textLines(it.text) : 2) * 21
    }
    case "tools":
      return row.live ? 50 : 26
    case "tool":
      return 26
    case "files":
      return 80
    case "thought":
      return 26
    case "receipt":
      return 26
    case "done":
      return 28
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
}

export function groupBlocks(rows: Row[]): Block[] {
  const blocks: Block[] = []
  let cur: Block | null = null
  for (const r of rows) {
    const t = r.kind === "compaction" ? null : r.turnId
    if (r.kind === "compaction" || !cur || cur.turnId !== t) {
      cur = { key: `b:${r.key}`, turnId: t, rows: [] }
      blocks.push(cur)
    }
    cur.rows.push(r)
    if (r.kind === "compaction") cur = null
  }
  return blocks
}

export function estimateBlock(block: Block, items: Record<ID, Item>, width: number) {
  let h = 0
  for (const r of block.rows) h += estimateRow(r, items, width)
  return h
}

/** Index of the first block of the last turn: the live tail rendered outside the virtualizer. */
export function tailStartIndex(blocks: Block[], turns: Transcript["turns"]): number {
  const last = turns.at(-1)
  if (!last) return blocks.length
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].turnId === last.id) return i
  return Math.max(0, blocks.length - 1)
}
