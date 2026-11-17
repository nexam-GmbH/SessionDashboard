// Messages queued for later (Ctrl+Enter while Claude works) in a band joined to the top of the
// prompt box, as Claude Code desktop shows them; sent together when the turn is over. One message
// is a single row: "1 message queued", its text, Send now / Edit in composer / Remove from queue.
// Several fold into "N messages queued · Next: <text>"; open, each row has a drag handle (reorder)
// and the same three actions, with Clear all under them. Messages kept from before a restart (or a
// Stop) are held: they go only with Send now. Editing opens the message in the prompt box (↑ in an
// empty box does it for the newest); the row stays in its place, marked, until Enter puts it back.
import { memo, useEffect, useState, type ReactNode } from "react"
import { ChevronDown, ChevronUp, CornerDownLeft, GripVertical, Paperclip, Pencil, X } from "lucide-react"
import { REAL } from "@/backend/mode"
import { plural } from "@/lib/format"
import type { ID } from "@/lib/model"
import { useApp } from "@/store/app"
import { cn } from "@/lib/utils"
import { GHOST } from "@/features/composer/Pickers"
import { clearQueue, editQueuedInBox, moveQueued, removeQueuedMessage, sendQueuedNow, useExpanded, useQueued, useQueueEdit, type Queued } from "../sessionStore"

const ICON = cn(GHOST, "w-7 text-cc-fg3")

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

const NONE: Queued[] = []

export const PromptQueue = memo(function PromptQueue({ sessionId }: { sessionId: ID }) {
  const queued = useQueued(sessionId)
  // the last messages stay on screen for the 120 ms the band takes to leave
  const [last, setLast] = useState(queued)
  if (queued.length && last !== queued) setLast(queued)
  const leaving = !queued.length && last.length > 0
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => setLast(NONE), 120)
    return () => clearTimeout(t)
  }, [leaving])
  const items = leaving ? last : queued
  const editId = useQueueEdit(sessionId)?.id
  const [open, setOpen] = useExpanded(`queue-open:${sessionId}`, false)
  const [drag, setDrag] = useState<{ id: ID; over: number } | null>(null)
  // what Send now does, for its description
  const sendNow = useApp((s) => {
    const x = s.sessions[sessionId]
    if (x?.status !== "working" && x?.status !== "starting") return "Claude starts a new response with this message."
    return REAL && x.control === "owned" ? "Claude reads this message at its next step." : "Stops Claude's current response."
  })
  if (!items.length) return null
  const held = items.every((q) => q.held)
  const title = items.length === 1 ? (held ? "1 message" : "1 message queued") : held ? plural(items.length, "held message") : `${items.length} messages queued`
  const actions = (q: Queued) => <Actions sessionId={sessionId} q={q} editing={q.id === editId} sendNow={sendNow} held={held} />

  // one message: a single row
  if (items.length === 1) {
    const q = items[0]
    return (
      <Frame leaving={leaving}>
        <div className={cn("flex min-h-10 min-w-0 items-center gap-[5px] py-1 pr-2 pl-4", q.id === editId && "bg-cc-wash")}>
          <span className="shrink-0 font-medium">{title}</span>
          <Preview q={q} editing={q.id === editId} />
          {actions(q)}
        </div>
      </Frame>
    )
  }

  // several, folded: "N messages queued · Next: …"
  if (!open) {
    return (
      <Frame leaving={leaving}>
        <button type="button" onClick={() => setOpen(true)} aria-expanded={false} className="flex min-h-11 w-full min-w-0 items-center gap-[5px] pr-2 pl-4 text-left outline-none hover:bg-cc-wash focus-visible:shadow-[inset_0_0_0_1px_var(--cc-accent)]">
          <span className="shrink-0 font-medium">{title}</span>
          <span className="min-w-0 flex-1 truncate text-cc-fg3">Next: {oneLine(items[0].text)}</span>
          <span className="inline-flex size-7 shrink-0 items-center justify-center text-cc-fg3">
            <ChevronDown size={14} />
          </span>
        </button>
      </Frame>
    )
  }

  return (
    <Frame leaving={leaving}>
      <header className="flex min-h-10 items-center gap-2 pr-2 pl-4">
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <button type="button" aria-label={held ? "Collapse held messages" : "Collapse queued messages"} title="Collapse" onClick={() => setOpen(false)} className={ICON}>
          <ChevronUp size={14} />
        </button>
      </header>
      <ul className="flex max-h-[min(40vh,22rem)] flex-col overflow-y-auto border-t border-cc-wash-2 p-1.5">
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
                "group/q flex min-w-0 items-center gap-[5px] rounded-lg p-[5px]",
                editing && "bg-cc-wash",
                drag?.id === q.id && "bg-cc-wash-2 opacity-80",
                drag && drag.id !== q.id && drag.over === i && "shadow-[inset_0_2px_0_var(--cc-accent)]",
              )}
            >
              <span aria-label="Reorder queued message" title="Drag to reorder" className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center text-cc-fg3 active:cursor-grabbing">
                <GripVertical size={14} />
              </span>
              <Preview q={q} editing={editing} />
              {actions(q)}
            </li>
          )
        })}
      </ul>
      <footer className="flex justify-end border-t border-cc-wash-2 px-4 py-2">
        <button type="button" onClick={() => clearQueue(sessionId)} className="rounded-md text-[13px] text-cc-danger outline-none hover:underline focus-visible:shadow-[0_0_0_1px_var(--cc-accent)]">
          Clear all
        </button>
      </footer>
    </Frame>
  )
})

/** The band: on the box's top edge, inset to clear its rounded corners; fades and rises 6 px in. */
function Frame({ children, leaving }: { children: ReactNode; leaving: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[calc(var(--chat-w)+64px)] px-8 @max-[560px]:px-4">
      <section
        aria-label="Queued messages"
        inert={leaving}
        className={cn(
          "mx-3.5 overflow-hidden rounded-t-xl bg-cc-wash text-sm duration-[120ms] ease-[var(--cc-ease-out)] in-data-[reduce-motion]:animate-none",
          leaving ? "animate-out fill-mode-forwards fade-out slide-out-to-bottom-1.5" : "animate-in fade-in slide-in-from-bottom-1.5",
        )}
      >
        {children}
      </section>
    </div>
  )
}

function Preview({ q, editing }: { q: Queued; editing: boolean }) {
  return (
    <>
      <span className={cn("min-w-0 flex-1 truncate", editing ? "text-[var(--cc-fg)]" : "text-cc-fg3")} title={q.text}>
        {oneLine(q.text)}
      </span>
      {q.attachments?.length ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-cc-fg3" aria-label={`${q.attachments.length} attached`} title={q.attachments.join("\n")}>
          <Paperclip size={13} />
          <span className="tabular">{q.attachments.length}</span>
        </span>
      ) : null}
      {editing && <span className="shrink-0 px-1 text-xs text-cc-fg3">Editing in the box</span>}
    </>
  )
}

/** Send now, Edit in composer, Remove from queue (Claude Code desktop's three row buttons). */
function Actions({ sessionId, q, editing, sendNow, held }: { sessionId: ID; q: Queued; editing: boolean; sendNow: string; held: boolean }) {
  return (
    <span className="flex shrink-0 items-center">
      {!editing && (
        <button type="button" aria-label="Send now" title={`Send now: ${sendNow}`} onClick={() => sendQueuedNow(sessionId, q.id)} className={ICON}>
          <CornerDownLeft size={14} />
        </button>
      )}
      <button
        type="button"
        aria-label="Edit in composer"
        title="Edit in composer"
        onClick={() => {
          editQueuedInBox(sessionId, q.id)
          focusBox(sessionId)
        }}
        className={ICON}
      >
        <Pencil size={14} />
      </button>
      <button type="button" aria-label={held ? "Remove message" : "Remove from queue"} title={held ? "Remove message" : "Remove from queue"} onClick={() => removeQueuedMessage(sessionId, q.id)} className={ICON}>
        <X size={14} />
      </button>
    </span>
  )
}
