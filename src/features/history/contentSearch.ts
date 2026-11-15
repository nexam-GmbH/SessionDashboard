// What was said in every session, searched: the backend's index in the app (every transcript, also
// sessions not loaded and old parts of long chats); in the browser preview the loaded chats and each
// session's first and last words. Shared by Ctrl+K and the History screen.
import { useEffect, useState } from "react"
import { REAL } from "@/backend/mode"
import type { SearchHit } from "@/backend/real"
import { getApp } from "@/store/app"

/**
 * What was said in every session: the backend's index in the app (also sessions not loaded, and
 * old parts of long chats); the loaded chats and last messages in the browser preview.
 */
export function useContentSearch(query: string, limit = 40): { hits: SearchHit[]; busy: boolean } {
  const [state, setState] = useState<{ q: string; hits: SearchHit[] }>({ q: "", hits: [] })
  useEffect(() => {
    if (query.length < 2) return
    let alive = true
    const t = setTimeout(() => {
      const done = (hits: SearchHit[]) => alive && setState({ q: query, hits })
      if (REAL) void import("@/backend/real").then((r) => r.realSearch(query, limit)).then(done)
      else done(mockSearch(query))
    }, 180)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, limit])
  const known = getApp().sessions
  return { hits: state.q === query ? state.hits.filter((h) => known[h.sessionId]) : [], busy: query.length >= 2 && state.q !== query }
}

/** The browser preview: loaded chats, plus each session's first and last words. */
export function mockSearch(query: string): SearchHit[] {
  const s = getApp()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const out: SearchHit[] = []
  for (const x of Object.values(s.sessions)) {
    const t = s.transcripts[x.id]
    const texts: { id: string; text: string; at: string; role: "user" | "assistant" }[] = t
      ? t.order.flatMap((id) => {
          const it = t.items[id]
          return it?.type === "user_message" || it?.type === "agent_message" ? [{ id, text: it.text, at: it.at, role: it.type === "user_message" ? ("user" as const) : ("assistant" as const) }] : []
        })
      : [
          { id: "", text: x.firstPrompt, at: x.createdAt, role: "user" as const },
          { id: "", text: x.lastText ?? "", at: x.updatedAt, role: "assistant" as const },
        ]
    const hits = texts.filter((m) => words.every((w) => m.text.toLowerCase().includes(w)))
    const best = hits.at(-1)
    if (!best) continue
    const i = best.text.toLowerCase().indexOf(words[0])
    out.push({ sessionId: x.id, uuid: best.id, role: best.role, at: best.at, before: (i > 60 ? "…" : "") + best.text.slice(Math.max(0, i - 60), i), matched: best.text.slice(i, i + words[0].length), after: best.text.slice(i + words[0].length, i + words[0].length + 120), count: hits.length })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200)
}

