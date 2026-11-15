// Find in the chat (Ctrl+F) and opening a chat at one message (a search hit). Both end in the same
// request to the transcript on screen: "show item X" (it scrolls there, reading an older part of a
// long chat first when X is not loaded yet) and, with a query, the find bar with the matches lit.
import type { ID, Item, Transcript } from "@/lib/model"
import { getApp } from "@/store/app"
import { openSession } from "@/store/actions"
import { getUiValue, setUiValue, useUiValue } from "../sessionStore"

export interface FindState {
  open: boolean
  query: string
  /** bumps when Ctrl+F is pressed again (focus and select the field) */
  focus: number
}
const CLOSED: FindState = { open: false, query: "", focus: 0 }

export const useFind = (sessionId: ID) => useUiValue<FindState>(`find:${sessionId}`, CLOSED)
export const getFind = (sessionId: ID) => getUiValue<FindState>(`find:${sessionId}`, CLOSED)

export function openFind(sessionId: ID, query?: string) {
  const cur = getFind(sessionId)
  setUiValue(`find:${sessionId}`, { open: true, query: query ?? cur.query, focus: cur.focus + 1 })
}
export function setFindQuery(sessionId: ID, query: string) {
  setUiValue(`find:${sessionId}`, { ...getFind(sessionId), query })
}
export function closeFind(sessionId: ID) {
  setUiValue(`find:${sessionId}`, { ...getFind(sessionId), open: false })
}

/** A request to bring one item of a chat into view. */
export interface Jump {
  itemId: ID
  n: number
}
let seq = 0
export const useJump = (sessionId: ID) => useUiValue<Jump | null>(`jump:${sessionId}`, null)
export function jumpTo(sessionId: ID, itemId: ID) {
  setUiValue(`jump:${sessionId}`, { itemId, n: ++seq })
}

/** Open a session at one of its messages, with the words that found it lit (Ctrl+K "In messages"). */
export function openSessionAt(sessionId: ID, itemId: ID, query?: string) {
  if (query) setUiValue(`find:${sessionId}`, { open: true, query, focus: getFind(sessionId).focus })
  jumpTo(sessionId, itemId)
  openSession(sessionId)
}

/** The searchable text of an item: what you wrote, what Claude answered, notices. */
export function itemText(it: Item | undefined): string {
  if (!it) return ""
  if (it.type === "user_message" || it.type === "agent_message" || it.type === "notice") return it.text
  return ""
}

/** Ids of the loaded items whose text contains the phrase (case-insensitive), in chat order. */
export function findInTranscript(t: Transcript | undefined, query: string): ID[] {
  const q = query.trim().toLowerCase()
  if (!t || !q) return []
  const out: ID[] = []
  for (const id of t.order) if (itemText(t.items[id]).toLowerCase().includes(q)) out.push(id)
  return out
}

export const transcriptOf = (sessionId: ID) => getApp().transcripts[sessionId]

// ---------- painting the matches (CSS Custom Highlight API; nothing in the DOM changes) ----------
type HighlightCtor = new (...ranges: Range[]) => unknown
const HL = typeof window !== "undefined" ? (window as unknown as { Highlight?: HighlightCtor }).Highlight : undefined
const registry = typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined

/** Light every occurrence of `query` under `root`; the ones inside `current` get the stronger colour. */
export function paintMatches(root: HTMLElement | null, query: string, current: Element | null) {
  if (!registry || !HL) return
  const q = query.trim().toLowerCase()
  if (!root || !q) {
    registry.delete("sd-find")
    registry.delete("sd-find-current")
    return
  }
  const all: Range[] = []
  const cur: Range[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement?.closest("[data-find-skip]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
  })
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = (n.nodeValue ?? "").toLowerCase()
    let i = text.indexOf(q)
    while (i >= 0) {
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + q.length)
      if (current?.contains(n)) cur.push(r)
      else all.push(r)
      i = text.indexOf(q, i + q.length)
    }
  }
  registry.set("sd-find", new HL(...all))
  registry.set("sd-find-current", new HL(...cur))
}
