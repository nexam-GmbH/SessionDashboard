// Ctrl+Tab: most-recently-used session switcher (VS Code / Zed / Firefox pattern; tmux `last-window`).
// A quick Ctrl+Tab goes straight back to the previous session; holding Ctrl shows the recent list,
// Tab / Shift+Tab move through it and releasing Ctrl opens the highlighted one. Esc cancels.
import { useEffect, useState } from "react"
import { POPOUT } from "@/backend/mode"
import { useApp, getApp } from "@/store/app"
import { currentSessionId, openSession } from "@/store/actions"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { useShownStatus } from "@/store/selectors"
import { cn } from "@/lib/utils"
import { IS_MAC } from "@/lib/platform"
import type { ID } from "@/lib/model"

/** the list appears only if Ctrl is still held after this long (a quick toggle never flashes it) */
const SHOW_AFTER_MS = 160
const MAX = 8

type State = { list: ID[]; index: number; visible: boolean } | null

function recentList(): ID[] {
  const s = getApp()
  const cur = currentSessionId()
  const live = s.recent.filter((id) => {
    const x = s.sessions[id]
    // past sessions you opened too (an old chat found with Ctrl+K)
    return x && !x.archived
  })
  // the current session first (index 0), so the first Tab lands on the previous one
  return (cur && live[0] === cur ? live : live.filter((id) => id !== cur)).slice(0, MAX)
}

export function Switcher() {
  const [state, setState] = useState<State>(null)

  useEffect(() => {
    let showTimer: ReturnType<typeof setTimeout> | undefined
    let cur: State = null
    const update = (next: State) => {
      cur = next
      setState(next)
    }
    const modDown = (e: KeyboardEvent) => (IS_MAC ? e.metaKey || e.ctrlKey : e.ctrlKey)
    const onKeyDown = (e: KeyboardEvent) => {
      // a session's own window stays on its session
      if (POPOUT) return
      if (e.key === "Tab" && modDown(e)) {
        e.preventDefault()
        e.stopPropagation()
        if (!cur) {
          const list = recentList()
          if (!list.length) return
          const startsWithCurrent = list[0] === currentSessionId()
          const first = startsWithCurrent ? Math.min(1, list.length - 1) : 0
          update({ list, index: e.shiftKey ? list.length - 1 : first, visible: false })
          showTimer = setTimeout(() => cur && update({ ...cur, visible: true }), SHOW_AFTER_MS)
        } else {
          const n = cur.list.length
          update({ ...cur, index: (cur.index + (e.shiftKey ? -1 : 1) + n) % n })
        }
      } else if (e.key === "Escape" && cur) {
        e.preventDefault()
        e.stopPropagation()
        clearTimeout(showTimer)
        update(null)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!cur) return
      if (e.key === "Control" || e.key === "Meta") {
        clearTimeout(showTimer)
        const id = cur.list[cur.index]
        update(null)
        if (id && id !== currentSessionId()) openSession(id)
      }
    }
    const onBlur = () => {
      clearTimeout(showTimer)
      update(null)
    }
    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("keyup", onKeyUp, true)
    window.addEventListener("blur", onBlur)
    return () => {
      clearTimeout(showTimer)
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("keyup", onKeyUp, true)
      window.removeEventListener("blur", onBlur)
    }
  }, [])

  if (!state?.visible) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center pt-[18vh]">
      <div role="listbox" aria-label="Recent sessions" className="w-[420px] rounded-xl border border-border bg-muted p-1.5 shadow-[0_12px_32px_rgb(0_0_0/0.45)]">
        {state.list.map((id, i) => (
          <SwitcherRow key={id} id={id} active={i === state.index} />
        ))}
      </div>
    </div>
  )
}

function SwitcherRow({ id, active }: { id: ID; active: boolean }) {
  const s = useApp((st) => st.sessions[id])
  const status = useShownStatus(id)
  const repo = useApp((st) => (s?.repoId ? st.repos[s.repoId]?.name : "main agent"))
  if (!s) return null
  return (
    <div role="option" aria-selected={active} className={cn("flex h-9 items-center gap-2.5 rounded-md px-2.5", active && "bg-accent")}>
      <StatusGlyph status={status} outcome={s.outcome} unread={!!s.unreadSince} size="sm" title={null} />
      <span className={cn("min-w-0 flex-1 truncate text-sm", active || s.unreadSince ? "text-foreground" : "text-muted-foreground", s.unreadSince && "font-medium")}>{s.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground/70">{repo}</span>
    </div>
  )
}
