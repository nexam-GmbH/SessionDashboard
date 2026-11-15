// Messages waiting for Claude, stacked above the prompt box (Claude Code desktop's queue). Each row
// is one line of its text with an edit pencil and a remove ×. Editing opens the message in the
// prompt box (so does ↑ in an empty box, for the newest); the row stays in its place, marked,
// until Enter puts it back or Esc cancels.
import { memo } from "react"
import { ChevronUp, Paperclip, Pencil, SendHorizontal, X } from "lucide-react"
import { plural } from "@/lib/format"
import type { ID } from "@/lib/model"
import { cn } from "@/lib/utils"
import { clearQueue, editQueuedInBox, removeQueuedMessage, sendQueuedNow, useExpanded, useQueued, useQueueEdit } from "../sessionStore"

const ACTION =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"

/** Focus the session's prompt box (the queue sits outside it). */
function focusBox(sessionId: ID) {
  requestAnimationFrame(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(`[data-session-view="${sessionId}"] [data-prompt-box] textarea`)
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
  })
}

/**
 * "2 messages queued" above the prompt box (Claude Code desktop): a panel that opens to one row per
 * message with Edit, Send now (stops the current step, this one is read now) and Remove, and
 * "Clear all" for the lot.
 */
export const PromptQueue = memo(function PromptQueue({ sessionId }: { sessionId: ID }) {
  const items = useQueued(sessionId)
  const editId = useQueueEdit(sessionId)?.id
  const [open, setOpen] = useExpanded(`queue-open:${sessionId}`, true)
  if (!items.length) return null
  return (
    <div className="mx-auto w-full max-w-[var(--chat-w)] px-5 pb-2">
      <section aria-label="Queued messages" className="rounded-xl bg-card ring-1 ring-foreground/10">
        <header className="flex h-9 items-center gap-2 pr-2 pl-3.5">
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-foreground outline-none focus-visible:underline">
            {plural(items.length, "message")} queued
            <span className="text-xs font-normal text-muted-foreground/70">sent when Claude finishes this turn</span>
          </button>
          <button type="button" onClick={() => clearQueue(sessionId)} className="shrink-0 rounded-md px-1.5 text-xs text-st-error-fg outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring">
            Clear all
          </button>
          <button type="button" aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)} className={ACTION}>
            <ChevronUp size={14} className={cn("transition-transform", !open && "rotate-180")} />
          </button>
        </header>
        {open && (
          <ul className="flex flex-col border-t border-border/70 py-1">
            {items.map((q) => {
              const editing = q.id === editId
              return (
                <li
                  key={q.id}
                  aria-current={editing || undefined}
                  className={cn("group/q flex min-h-8 min-w-0 items-center gap-2 pr-2 pl-3.5 text-sm", editing && "bg-accent/60")}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    editQueuedInBox(sessionId, q.id)
                    focusBox(sessionId)
                  }}
                >
                  <span className={cn("min-w-0 flex-1 truncate py-1", editing ? "text-foreground" : "text-muted-foreground")} title={q.text}>
                    {q.text}
                  </span>
                  {q.attachments?.length ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground/70" aria-label={`${q.attachments.length} attached`} title={q.attachments.join("\n")}>
                      <Paperclip size={14} />
                      <span className="tabular">{q.attachments.length}</span>
                    </span>
                  ) : null}
                  {editing ? (
                    <span className="shrink-0 px-2 text-xs text-muted-foreground">Editing in the box</span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-0.5 opacity-60 group-hover/q:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        aria-label="Edit queued message"
                        title="Edit in the prompt box"
                        className={ACTION}
                        onClick={() => {
                          editQueuedInBox(sessionId, q.id)
                          focusBox(sessionId)
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                      <button type="button" aria-label="Send now" title="Send now: stops the current step, this message is read at once" className={ACTION} onClick={() => sendQueuedNow(sessionId, q.id)}>
                        <SendHorizontal size={14} />
                      </button>
                    </span>
                  )}
                  <button type="button" aria-label="Remove queued message" title="Remove" className={ACTION} onClick={() => removeQueuedMessage(sessionId, q.id)}>
                    <X size={14} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
})
