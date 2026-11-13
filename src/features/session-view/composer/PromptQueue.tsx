// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-prompt-queue.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from vercel/ai-elements@ca8be60:packages/elements/src/queue.tsx (Apache-2.0): hover-revealed item actions.
// Changes: lucide icons, our store actions (edit / send now / remove), dense rows; no
// header line (calm rules §2.5): the clock glyph and its tooltip say "queued".
import { memo, useState } from "react"
import { Check, Clock3, CornerDownLeft, Paperclip, Pencil, X } from "lucide-react"
import type { ID } from "@/lib/model"
import { removeQueued } from "@/store/actions"
import { cn } from "@/lib/utils"
import { editQueued, sendQueuedNow, useQueued } from "../sessionStore"

const ACTION = "inline-flex size-5 items-center justify-center rounded-[3px] text-fg-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-ring"

export const PromptQueue = memo(function PromptQueue({ sessionId }: { sessionId: ID }) {
  const items = useQueued(sessionId)
  const [editingId, setEditingId] = useState<ID | null>(null)
  const [draft, setDraft] = useState("")
  if (!items.length) return null
  const save = (id: ID) => {
    if (draft.trim()) editQueued(sessionId, id, draft.trim())
    setEditingId(null)
  }
  return (
    <div className="mx-auto w-full max-w-[860px] px-5 pb-1.5">
      <ul className="flex flex-col gap-px" aria-label="Queued messages">
        {items.map((q) => {
          const editing = editingId === q.id
          return (
            <li
              key={q.id}
              className={cn(
                "group/q flex min-h-7 min-w-0 items-center gap-2 rounded-[4px] border border-line-subtle bg-chrome px-2 text-[12.5px]",
                editing && "border-brand/50",
              )}
            >
              <Clock3 size={12} className="shrink-0 text-fg-faint" aria-label="Queued" />
              {editing ? (
                <textarea
                  autoFocus
                  rows={1}
                  value={draft}
                  aria-label="Edit queued message"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault()
                      setEditingId(null)
                    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      save(q.id)
                    }
                  }}
                  className="my-1 min-w-0 flex-1 resize-none bg-transparent text-[12.5px] leading-[18px] text-fg outline-none"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-fg-muted" title={`Queued: sent after this turn\n${q.text}${q.attachments?.length ? `\n${q.attachments.join(", ")}` : ""}`}>
                  {q.text}
                </span>
              )}
              {!editing && q.attachments?.length ? (
                <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-fg-faint" aria-label={`${q.attachments.length} attached`}>
                  <Paperclip size={11} />
                  <span className="tabular">{q.attachments.length}</span>
                </span>
              ) : null}
              <span className={cn("flex shrink-0 items-center gap-0.5", !editing && "opacity-0 group-hover/q:opacity-100 focus-within:opacity-100")}>
                {editing ? (
                  <>
                    <button type="button" aria-label="Save queued message" className={ACTION} onClick={() => save(q.id)}>
                      <Check size={12} />
                    </button>
                    <button type="button" aria-label="Cancel editing" className={ACTION} onClick={() => setEditingId(null)}>
                      <X size={12} />
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" aria-label="Send now" title="Send now" className={ACTION} onClick={() => sendQueuedNow(sessionId, q.id)}>
                      <CornerDownLeft size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label="Edit queued message"
                      title="Edit"
                      className={ACTION}
                      onClick={() => {
                        setDraft(q.text)
                        setEditingId(q.id)
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                    <button type="button" aria-label="Remove queued message" title="Remove" className={ACTION} onClick={() => removeQueued(sessionId, q.id)}>
                      <X size={12} />
                    </button>
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
})
