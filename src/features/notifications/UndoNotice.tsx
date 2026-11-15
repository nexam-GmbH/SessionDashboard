// "Archived · <title> · Undo" in the middle of the top bar, which is otherwise empty: feedback for
// a reversible action without anything floating over the content (PRODUCT.md: nothing stacked).
// Gone after 6 s; the timer pauses while the pointer or keyboard focus is on it.
import { useEffect, useState } from "react"
import { Archive, ArchiveRestore, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { clearUndo, useUndo } from "./undo"

const BTN = "outline-none focus-visible:ring-1 focus-visible:ring-ring"

/** Always mounted as a polite live region, so a notice added later is announced. */
export function UndoNotice() {
  const undo = useUndo((s) => !!s.undo)
  return (
    <div role="region" aria-label="Notifications" aria-live="polite" aria-relevant="additions" className="flex min-w-0 justify-center">
      {undo && <Notice />}
    </div>
  )
}

function Notice() {
  const { seq, label, detail, undo } = useUndo()
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (held) return
    const id = setTimeout(clearUndo, 6000)
    return () => clearTimeout(id)
  }, [seq, held])
  if (!undo) return null
  const Icon = label === "Restored" ? ArchiveRestore : Archive
  return (
    <div
      role="status"
      aria-atomic="true"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHeld(false)}
      className="flex h-7 max-w-[460px] min-w-0 animate-in items-center gap-2 rounded-md bg-muted pr-1 pl-2.5 duration-150 fade-in"
    >
      <Icon size={13} className="shrink-0 text-muted-foreground/70" aria-hidden />
      <span className="shrink-0 text-xs text-foreground">{label}</span>
      <span className="min-w-0 truncate text-xs text-muted-foreground" title={detail}>
        {detail}
      </span>
      <button
        className={cn("h-5 shrink-0 rounded-md px-1.5 text-xs font-medium text-link hover:bg-accent", BTN)}
        onClick={() => {
          undo()
          clearUndo()
        }}
      >
        Undo
      </button>
      <button className={cn("flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground", BTN)} onClick={clearUndo} aria-label="Dismiss">
        <X size={12} />
      </button>
    </div>
  )
}
