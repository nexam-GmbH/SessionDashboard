// Messages you sent while Claude works that it has not read yet, at the end of the chat: faded
// bubbles (Claude Code desktop), "Claude reads this message at its next step", with Send now (stops the current
// step so it is read next), Edit (back into the prompt box) and Remove. Once Claude takes one in
// it becomes an ordinary message of the turn.
import { memo, useState } from "react"
import { Paperclip, Pencil, SendHorizontal, X } from "lucide-react"
import type { ID } from "@/lib/model"
import { cn } from "@/lib/utils"
import { removeWaiting, sendWaitingNow, takeBackWaiting, useWaiting } from "../sessionStore"

const ACTION =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-cc-fg2 outline-none hover:bg-cc-ghost hover:text-foreground focus-visible:ring-1 focus-visible:ring-cc-accent"

export const WaitingMessages = memo(function WaitingMessages({ sessionId }: { sessionId: ID }) {
  const items = useWaiting(sessionId)
  if (!items.length) return null
  return (
    <ul aria-label="Waiting for Claude to read them" className="flex flex-col gap-6 pt-6">
      {items.map((q) => (
        <Waiting key={q.id} sessionId={sessionId} id={q.id} text={q.text} attachments={q.attachments?.length ?? 0} held={!!q.held} />
      ))}
    </ul>
  )
})

/** A normal bubble at half strength (80 % under the pointer), its actions under it (Claude Code desktop). */
function Waiting({ sessionId, id, text, attachments, held }: { sessionId: ID; id: ID; text: string; attachments: number; held: boolean }) {
  const [sending, setSending] = useState(false)
  return (
    <li className="group/wait flex flex-col items-end gap-1">
      <div
        className={cn(
          "max-w-[85%] min-w-0 rounded-xl bg-cc-wash px-4 py-3 transition-opacity duration-200",
          sending ? "opacity-60" : "opacity-50 group-hover/wait:opacity-80",
        )}
      >
        <div className="line-clamp-6 text-[15px] leading-[21px] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] select-text">{text}</div>
        {attachments > 0 && (
          <span className="mt-1 inline-flex items-center gap-1 text-[13px] text-cc-fg2">
            <Paperclip size={13} /> {attachments}
          </span>
        )}
      </div>
      <div className="flex min-h-7 items-center gap-0.5 text-[13px] text-cc-fg3">
        <span className="mr-1">
          {sending ? "Stopping the current step…" : held ? "This message waited over a day, so it's held until you send it." : "Claude reads this message at its next step"}
        </span>
        <button
          type="button"
          disabled={sending}
          title="Stops Claude's current step so it reads this message next"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm text-foreground outline-none hover:bg-cc-ghost focus-visible:ring-1 focus-visible:ring-cc-accent disabled:opacity-40"
          onClick={() => {
            setSending(true)
            sendWaitingNow(sessionId, id)
          }}
        >
          <SendHorizontal size={14} /> Send now
        </button>
        <button type="button" aria-label="Edit in the message box" title="Back into the message box · Esc" className={ACTION} onClick={() => takeBackWaiting(sessionId, id)}>
          <Pencil size={14} />
        </button>
        <button type="button" aria-label="Remove" title="Remove: Claude never reads it" className={ACTION} onClick={() => removeWaiting(sessionId, id)}>
          <X size={16} />
        </button>
      </div>
    </li>
  )
}
