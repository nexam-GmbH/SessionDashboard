// Rewind dialog: after Claude Code's `/rewind` picker (pick an earlier prompt, then choose what to
// restore). Calm: one list of prompts, one choice, one button. Arrows move, Enter rewinds.
import { useMemo, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useApp } from "@/store/app"
import { useRelTime } from "@/components/common/RelativeTime"
import { cn } from "@/lib/utils"
import type { ID } from "@/lib/model"
import { rewindPoints, rewindTo, type RewindPoint, type RewindScope } from "../rewind"

const SCOPES: { value: RewindScope; label: string }[] = [
  { value: "both", label: "Conversation and code" },
  { value: "conversation", label: "Conversation only" },
  { value: "code", label: "Code only" },
]

export function RewindDialog({ sessionId, open, onOpenChange }: { sessionId: ID; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px] gap-0 border-line bg-elevated p-0 sm:max-w-[560px]">
        {open && <RewindBody sessionId={sessionId} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function RewindBody({ sessionId, onDone }: { sessionId: ID; onDone: () => void }) {
  const transcript = useApp((s) => s.transcripts[sessionId])
  const points = useMemo(() => rewindPoints(transcript), [transcript])
  const [index, setIndex] = useState(0)
  const [scope, setScope] = useState<RewindScope>("both")
  const point = points[index]
  const go = () => {
    if (!point) return
    rewindTo(sessionId, point.turnId, scope)
    onDone()
  }
  return (
    <>
      <div className="border-b border-line-subtle px-4 py-3">
        <DialogTitle className="text-sm font-medium">Rewind</DialogTitle>
        <DialogDescription className="mt-0.5 text-xs text-fg-faint">Go back to before a prompt. You can undo this.</DialogDescription>
      </div>
      {points.length === 0 ? (
        <div className="px-4 py-6 text-xs text-fg-faint">No earlier prompts yet.</div>
      ) : (
        <div
          role="listbox"
          aria-label="Prompts"
          aria-activedescendant={`rw-${index}`}
          tabIndex={0}
          autoFocus
          className="max-h-[320px] overflow-y-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-inset"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setIndex((i) => Math.min(points.length - 1, i + 1))
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1))
            else if (e.key === "Enter") go()
            else return
            e.preventDefault()
          }}
        >
          {points.map((p, i) => (
            <PointRow key={p.turnId} id={`rw-${i}`} point={p} active={i === index} onClick={() => setIndex(i)} onDoubleClick={go} />
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-line-subtle px-4 py-2.5">
        <div role="group" aria-label="Restore" className="inline-flex rounded-md border border-line-subtle bg-canvas p-0.5">
          {SCOPES.map((o) => (
            <button
              key={o.value}
              aria-pressed={scope === o.value}
              onClick={() => setScope(o.value)}
              className={cn(
                "h-6 rounded-sm px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
                scope === o.value ? "bg-selected text-fg" : "text-fg-faint hover:text-fg-muted",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="default" disabled={!point} onClick={go}>
          Rewind
        </Button>
      </div>
    </>
  )
}

function PointRow({ id, point, active, onClick, onDoubleClick }: { id: string; point: RewindPoint; active: boolean; onClick: () => void; onDoubleClick: () => void }) {
  const age = useRelTime(point.at)
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn("flex h-8 cursor-default items-center gap-3 px-4 text-xs", active ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover")}
    >
      <span className="min-w-0 flex-1 truncate">{point.prompt}</span>
      {point.filesAfter > 0 && <span className="tabular shrink-0 text-[11px] text-fg-faint">{point.filesAfter === 1 ? "1 file" : `${point.filesAfter} files`}</span>}
      <span className="tabular w-8 shrink-0 text-right text-[11px] text-fg-faint">{age}</span>
    </div>
  )
}
