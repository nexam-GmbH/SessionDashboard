// Renaming a session where you see it: the overview card, the session list. Right-click → Rename,
// the pencil on a card, a double-click in the list, or F2 on a focused row. Enter keeps the name,
// Esc leaves it; an empty name goes back to Claude's own title.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Archive, Pencil, SquareArrowOutUpRight } from "lucide-react"
import { create } from "zustand"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { archiveSessions, openSession, renameSession } from "@/store/actions"
import { useApp } from "@/store/app"
import { cn } from "@/lib/utils"
import type { ID } from "@/lib/model"

/** Which session's title is being edited, and where (a card and a list row may both show it). */
export const useRenaming = create<{ id: ID | null; where: string | null; menu: boolean }>(() => ({ id: null, where: null, menu: false }))
export const startRename = (id: ID, where: string) => useRenaming.setState({ id, where })
const stopRename = () => useRenaming.setState({ id: null, where: null })

/** The title as text, or as an input while it is being renamed here. */
export function EditableTitle({ id, where, className, children }: { id: ID; where: string; className?: string; children: ReactNode }) {
  const editing = useRenaming((s) => s.id === id && s.where === where)
  return editing ? <RenameInput id={id} className={className} /> : <>{children}</>
}

function finish(id: ID, original: string, value: string, done: { current: boolean }) {
  if (done.current) return
  done.current = true
  if (value.trim() !== original) renameSession(id, value)
  stopRename()
}

/** Mounted when renaming starts: starts from the current title, selected. */
function RenameInput({ id, className }: { id: ID; className?: string }) {
  const title = useApp((s) => s.sessions[id]?.title ?? "")
  const [draft, setDraft] = useState(title)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  // the name as it was when renaming started (what counts as "unchanged")
  const [original] = useState(title)
  const commit = () => finish(id, original, ref.current?.value ?? draft, done)
  useEffect(() => {
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.select()
    })
    // it ends by Enter, Esc or a click somewhere else; focus that wanders off on its own (a menu
    // closing, the list reordering under a live update) comes back
    const outside = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) finish(id, original, ref.current.value, done)
    }
    document.addEventListener("pointerdown", outside, true)
    return () => document.removeEventListener("pointerdown", outside, true)
  }, [id, original])
  return (
    <input
      ref={ref}
      value={draft}
      aria-label="Session name"
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") commit()
        if (e.key === "Escape") {
          done.current = true
          stopRename()
        }
      }}
      onBlur={() => {
        requestAnimationFrame(() => {
          if (!done.current) ref.current?.focus()
        })
      }}
      className={cn("pointer-events-auto relative z-10 w-full min-w-0 rounded-md border border-input bg-background px-1.5 text-foreground outline-none focus:border-ring", className)}
    />
  )
}

/** Right-click on a session: open, rename, archive. */
export function SessionMenu({ id, where, children }: { id: ID; where: string; children: ReactNode }) {
  return (
    <ContextMenu onOpenChange={(o) => useRenaming.setState({ menu: o })}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {/* closing must not pull focus back to the card: the rename field is taking it */}
      <ContextMenuContent className="w-48" onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuItem className="text-sm" onSelect={() => openSession(id)}>
          <SquareArrowOutUpRight size={13} /> Open
        </ContextMenuItem>
        <ContextMenuItem className="text-sm" onSelect={() => setTimeout(() => startRename(id, where), 0)}>
          <Pencil size={13} /> Rename
          <span className="ml-auto text-xs text-muted-foreground/70">F2</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-sm" onSelect={() => archiveSessions([id])}>
          <Archive size={13} /> Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
