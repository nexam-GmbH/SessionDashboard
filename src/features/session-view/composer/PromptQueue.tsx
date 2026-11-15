// Messages waiting for Claude, stacked above the prompt box (Claude Code desktop's queue). Each row
// is one line of its text with an edit pencil and a remove ×. Editing opens the message in the
// prompt box (so does ↑ in an empty box, for the newest); the row stays in its place, marked,
// until Enter puts it back or Esc cancels.
import { memo } from "react"
import { Paperclip, Pencil, X } from "lucide-react"
import type { ID } from "@/lib/model"
import { cn } from "@/lib/utils"
import { editQueuedInBox, removeQueuedMessage, useQueued, useQueueEdit } from "../sessionStore"

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

export const PromptQueue = memo(function PromptQueue({ sessionId }: { sessionId: ID }) {
  const items = useQueued(sessionId)
  const editId = useQueueEdit(sessionId)?.id
  if (!items.length) return null
  return (
    <div className="mx-auto w-full max-w-[var(--chat-w)] px-5 pb-2">
      <ul className="flex flex-col gap-1" aria-label="Queued messages">
        {items.map((q) => {
          const editing = q.id === editId
          return (
            <li
              key={q.id}
              aria-current={editing || undefined}
              className={cn(
                "group/q flex h-8 min-w-0 items-center gap-2 rounded-lg bg-card/60 pr-1 pl-3 text-sm ring-1 ring-foreground/10",
                editing && "bg-accent ring-ring",
              )}
            >
              <span className={cn("min-w-0 flex-1 truncate", editing ? "text-foreground" : "text-muted-foreground")} title={`Sent when Claude finishes this turn\n\n${q.text}`}>
                {q.text}
              </span>
              {q.attachments?.length ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground/70" aria-label={`${q.attachments.length} attached`} title={q.attachments.join("\n")}>
                  <Paperclip size={14} />
                  <span className="tabular">{q.attachments.length}</span>
                </span>
              ) : null}
              {editing ? (
                <span className="shrink-0 px-2 text-xs text-muted-foreground">Editing</span>
              ) : (
                <button
                  type="button"
                  aria-label="Edit queued message"
                  title="Edit"
                  className={ACTION}
                  onClick={() => {
                    editQueuedInBox(sessionId, q.id)
                    focusBox(sessionId)
                  }}
                >
                  <Pencil size={14} />
                </button>
              )}
              <button type="button" aria-label="Remove queued message" title="Remove" className={ACTION} onClick={() => removeQueuedMessage(sessionId, q.id)}>
                <X size={14} />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
})
