// Find in the chat (Ctrl+F): a small bar at the top right of the transcript, like a browser's. It
// counts every message with the words, also in the older part of a long chat that is not loaded
// yet (the backend's index), steps through them with Enter / Shift+Enter, and lights the words.
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronUp, X } from "lucide-react"
import { REAL } from "@/backend/mode"
import type { ID } from "@/lib/model"
import { useApp } from "@/store/app"
import { cn } from "@/lib/utils"
import { closeFind, findInTranscript, jumpTo, setFindQuery, useFind } from "./find"

const BTN =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"

export const FindBar = memo(function FindBar({ sessionId }: { sessionId: ID }) {
  const find = useFind(sessionId)
  if (!find.open) return null
  return <FindBarOpen sessionId={sessionId} query={find.query} focus={find.focus} />
})

function FindBarOpen({ sessionId, query, focus }: { sessionId: ID; query: string; focus: number }) {
  const input = useRef<HTMLInputElement>(null)
  const order = useApp((s) => s.transcripts[sessionId]?.order)
  // loaded messages that match, in chat order (recomputed when the chat grows or the words change)
  const loaded = useMemo(() => findInTranscript(useApp.getState().transcripts[sessionId], query), [sessionId, query, order]) // eslint-disable-line react-hooks/exhaustive-deps
  // older matches, before the loaded part (the app's sessions on this computer)
  const [older, setOlder] = useState<{ q: string; ids: ID[] }>({ q: "", ids: [] })
  useEffect(() => {
    const q = query.trim()
    if (!REAL || q.length < 2) return
    let alive = true
    const t = setTimeout(() => {
      void import("@/backend/real").then((r) =>
        r.realSearchIn(sessionId, q).then((ids) => {
          if (!alive) return
          const have = new Set(useApp.getState().transcripts[sessionId]?.order ?? [])
          setOlder({ q, ids: ids.filter((id) => !have.has(id)) })
        }),
      )
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [sessionId, query])
  const matches = useMemo(() => [...(older.q === query.trim() ? older.ids : []), ...loaded], [older, loaded, query])
  const [index, setIndex] = useState(-1)
  // a new query starts at the newest match (what you most likely look for)
  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setIndex(-1)
  }
  const at = index < 0 || index >= matches.length ? matches.length - 1 : index

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focus])

  // show the current match
  const target = matches[at]
  useEffect(() => {
    if (target) jumpTo(sessionId, target)
  }, [sessionId, target])

  const step = (d: number) => {
    if (!matches.length) return
    setIndex((at + d + matches.length) % matches.length)
  }

  return (
    <div
      role="search"
      data-find-skip
      className="absolute top-2 right-4 z-20 flex h-9 items-center gap-1 rounded-lg border border-border bg-popover py-1 pr-1 pl-2.5 shadow-lg"
    >
      <input
        ref={input}
        value={query}
        onChange={(e) => setFindQuery(sessionId, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          } else if (e.key === "Escape") {
            e.preventDefault()
            closeFind(sessionId)
          } else if (e.key === "F3") {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          }
        }}
        placeholder="Find in chat"
        aria-label="Find in chat"
        className="h-full w-48 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <span className={cn("tabular min-w-14 shrink-0 text-right text-xs", query.trim() && !matches.length ? "text-st-error-fg" : "text-muted-foreground")} aria-live="polite">
        {query.trim() ? (matches.length ? `${at + 1} of ${matches.length}` : "No results") : ""}
      </span>
      <button type="button" className={BTN} aria-label="Previous match" title="Previous · Shift+Enter" disabled={!matches.length} onClick={() => step(-1)}>
        <ChevronUp size={15} />
      </button>
      <button type="button" className={BTN} aria-label="Next match" title="Next · Enter" disabled={!matches.length} onClick={() => step(1)}>
        <ChevronDown size={15} />
      </button>
      <button type="button" className={BTN} aria-label="Close find" title="Close · Esc" onClick={() => closeFind(sessionId)}>
        <X size={15} />
      </button>
    </div>
  )
}
