// Messages queued for later (Ctrl+Enter while Claude works) above the prompt box, as Claude Code
// desktop shows them; sent together when the turn is over. One message is a single row: "1 message
// queued", its text, Send now and a ⋯ menu. Several fold into "N messages queued · Next: <text>";
// open, each row has a drag handle (reorder) and the ⋯ menu (Edit in composer, Send now, Remove
// from queue), with Clear all under them. Messages kept from before a restart (or a Stop) are held:
// they go only with Send now. Editing opens the message in the prompt box (↑ in an empty box does
// it for the newest); the row stays in its place, marked, until Enter puts it back or Esc cancels.
import { memo, useState, type ReactNode } from "react"
import { ChevronDown, CornerDownLeft, GripVertical, MoreHorizontal, Paperclip, Pencil, SendHorizontal, Trash2 } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { plural } from "@/lib/format"
import type { ID } from "@/lib/model"
import { cn } from "@/lib/utils"
import { clearQueue, editQueuedInBox, moveQueued, removeQueuedMessage, sendQueuedNow, useExpanded, useQueued, useQueueEdit, type Queued } from "../sessionStore"

const ICON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground"

/** Focus the session's prompt box (the queue sits outside it). */
function focusBox(sessionId: ID) {
  requestAnimationFrame(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(`[data-session-view="${sessionId}"] [data-prompt-box] textarea`)
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
  })
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

export const PromptQueue = memo(function PromptQueue({ sessionId }: { sessionId: ID }) {
  const items = useQueued(sessionId)
  const editId = useQueueEdit(sessionId)?.id
  const [open, setOpen] = useExpanded(`queue-open:${sessionId}`, false)
  const [drag, setDrag] = useState<{ id: ID; over: number } | null>(null)
  if (!items.length) return null
  const held = items.every((q) => q.held)
  const title = held ? `${plural(items.length, "held message")}` : `${plural(items.length, "message")} queued`

  // one message: a single row
  if (items.length === 1) {
    const q = items[0]
    return (
      <Frame>
        <div className={cn("flex min-h-10 min-w-0 items-center gap-2 pr-1.5 pl-3.5 text-sm", q.id === editId && "bg-accent/60")}>
          <span className="shrink-0 font-medium text-foreground">{title}</span>
          <Preview sessionId={sessionId} q={q} editing={q.id === editId} />
          {q.id !== editId && <SendNow sessionId={sessionId} id={q.id} />}
          <RowMenu sessionId={sessionId} q={q} />
        </div>
      </Frame>
    )
  }

  // several, folded: "N messages queued · Next: …"
  if (!open) {
    return (
      <Frame>
        <button type="button" onClick={() => setOpen(true)} aria-expanded={false} className="flex h-10 w-full min-w-0 items-center gap-2 pr-3 pl-3.5 text-left text-sm outline-none focus-visible:bg-accent">
          <span className="shrink-0 font-medium text-foreground">{title}</span>
          <span className="shrink-0 text-muted-foreground/60">·</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">Next: {oneLine(items[0].text)}</span>
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        </button>
      </Frame>
    )
  }

  return (
    <Frame>
      <header className="flex h-10 items-center gap-2 pr-1.5 pl-3.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
        <button type="button" aria-label="Collapse" title="Collapse" onClick={() => setOpen(false)} className={ICON}>
          <ChevronDown size={14} className="rotate-180" />
        </button>
      </header>
      <ul className="flex max-h-[min(40vh,22rem)] flex-col overflow-y-auto border-t border-border/70 py-1">
        {items.map((q, i) => {
          const editing = q.id === editId
          return (
            <li
              key={q.id}
              draggable={!editing}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move"
                e.dataTransfer.setData("text/plain", q.text)
                setDrag({ id: q.id, over: i })
              }}
              onDragOver={(e) => {
                if (!drag) return
                e.preventDefault()
                if (drag.over !== i) setDrag({ ...drag, over: i })
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (drag) moveQueued(sessionId, drag.id, i)
                setDrag(null)
              }}
              onDragEnd={() => setDrag(null)}
              aria-current={editing || undefined}
              className={cn(
                "group/q flex min-h-9 min-w-0 items-center gap-1 pr-1.5 pl-1 text-sm",
                editing && "bg-accent/60",
                drag?.id === q.id && "opacity-50",
                drag && drag.id !== q.id && drag.over === i && "shadow-[inset_0_2px_0_var(--color-ring)]",
              )}
            >
              <span aria-label="Reorder queued message" title="Drag to reorder" className="inline-flex size-6 shrink-0 cursor-grab items-center justify-center text-muted-foreground/50 group-hover/q:text-muted-foreground active:cursor-grabbing">
                <GripVertical size={14} />
              </span>
              <Preview sessionId={sessionId} q={q} editing={editing} />
              <RowMenu sessionId={sessionId} q={q} />
            </li>
          )
        })}
      </ul>
      <footer className="flex h-9 items-center border-t border-border/70 px-2">
        <button type="button" onClick={() => clearQueue(sessionId)} className="rounded-md px-1.5 py-1 text-xs font-medium text-st-error-fg outline-none hover:bg-st-error-tint focus-visible:ring-1 focus-visible:ring-ring">
          Clear all
        </button>
      </footer>
    </Frame>
  )
})

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[var(--chat-w)] px-5 pb-2">
      <section aria-label="Queued messages" className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {children}
      </section>
    </div>
  )
}

function Preview({ sessionId, q, editing }: { sessionId: ID; q: Queued; editing: boolean }) {
  return (
    <>
      <span className={cn("min-w-0 flex-1 truncate py-1", editing ? "text-foreground" : "text-muted-foreground")} title={q.text}>
        {oneLine(q.text)}
      </span>
      {q.attachments?.length ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground/70" aria-label={`${q.attachments.length} attached`} title={q.attachments.join("\n")}>
          <Paperclip size={13} />
          <span className="tabular">{q.attachments.length}</span>
        </span>
      ) : null}
      {editing && (
        <button type="button" onClick={() => focusBox(sessionId)} className="shrink-0 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
          Editing in the box
        </button>
      )}
    </>
  )
}

function SendNow({ sessionId, id }: { sessionId: ID; id: ID }) {
  return (
    <button type="button" aria-label="Send now" title="Send now: while Claude works, it reads this message at its next step" onClick={() => sendQueuedNow(sessionId, id)} className={ICON}>
      <CornerDownLeft size={14} />
    </button>
  )
}

/** "Queued message actions": Edit in composer, Send now, Remove from queue. */
function RowMenu({ sessionId, q }: { sessionId: ID; q: Queued }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Queued message actions" title="Queued message actions" className={ICON}>
          <MoreHorizontal size={15} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem
          onSelect={() => {
            editQueuedInBox(sessionId, q.id)
            focusBox(sessionId)
          }}
        >
          <Pencil /> Edit in composer
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => sendQueuedNow(sessionId, q.id)}>
          <SendHorizontal /> Send now
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => removeQueuedMessage(sessionId, q.id)}>
          <Trash2 /> Remove from queue
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
