// Messages you sent while Claude works that it has not read yet, at the end of the chat (Claude
// Code desktop): "Claude reads this message at its next step", with Send now (stops the current
// step so it is read next), Edit (back into the prompt box) and Remove. Once Claude takes one in
// it becomes an ordinary message of the turn.
import { memo, useState } from "react"
import { Paperclip, Pencil, SendHorizontal, X } from "lucide-react"
import type { ID } from "@/lib/model"
import { removeWaiting, sendWaitingNow, takeBackWaiting, useWaiting } from "../sessionStore"

const ACTION =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"

export const WaitingMessages = memo(function WaitingMessages({ sessionId }: { sessionId: ID }) {
  const items = useWaiting(sessionId)
  if (!items.length) return null
  return (
    <ul aria-label="Waiting for Claude to read them" className="flex flex-col">
      {items.map((q) => (
        <Waiting key={q.id} sessionId={sessionId} id={q.id} text={q.text} attachments={q.attachments?.length ?? 0} />
      ))}
    </ul>
  )
})

function Waiting({ sessionId, id, text, attachments }: { sessionId: ID; id: ID; text: string; attachments: number }) {
  const [sending, setSending] = useState(false)
  return (
    <li className="flex flex-col items-end pt-4 pb-2">
      <div className="max-w-[85%] min-w-0 rounded-2xl border border-dashed border-border bg-muted/40 px-4 py-2.5">
        <div className="line-clamp-6 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground select-text">{text}</div>
        {attachments > 0 && (
          <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground/70">
            <Paperclip size={11} /> {attachments}
          </span>
        )}
      </div>
      <div className="mt-1 flex h-6 items-center gap-0.5">
        <span className="mr-1 text-xs text-muted-foreground/70">{sending ? "Stopping the current step…" : "Claude reads this message at its next step"}</span>
        <button
          type="button"
          disabled={sending}
          title="Stops Claude's current step so it reads this message next"
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          onClick={() => {
            setSending(true)
            sendWaitingNow(sessionId, id)
          }}
        >
          <SendHorizontal size={13} /> Send now
        </button>
        <button type="button" aria-label="Edit in the message box" title="Back into the message box · Esc" className={ACTION} onClick={() => takeBackWaiting(sessionId, id)}>
          <Pencil size={13} />
        </button>
        <button type="button" aria-label="Remove" title="Remove: Claude never reads it" className={ACTION} onClick={() => removeWaiting(sessionId, id)}>
          <X size={14} />
        </button>
      </div>
    </li>
  )
}
