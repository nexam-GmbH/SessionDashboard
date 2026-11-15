// Another live session of this repository is editing the same files: in the same folder their edits
// overwrite each other, in another worktree a merge conflict waits. Said early, while it is cheap to
// coordinate (one finishes first, or one takes the other's change).
import { memo } from "react"
import { GitMerge } from "lucide-react"
import type { ID } from "@/lib/model"
import { useApp } from "@/store/app"
import { useOverlaps } from "@/store/selectors"
import { openSession } from "@/store/actions"
import { cn } from "@/lib/utils"

const name = (p: string) => p.split("/").pop() ?? p

/** One line for a card: "Same files as <session>". */
export const OverlapLine = memo(function OverlapLine({ id, className }: { id: ID; className?: string }) {
  const list = useOverlaps(id)
  const first = list[0]
  const title = useApp((s) => (first ? s.sessions[first.other]?.title : undefined))
  if (!first || !title) return null
  const files = list.flatMap((o) => o.files)
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5 text-xs text-foreground", className)} title={`${first.sameFolder ? "Same folder" : "Another worktree"}: ${files.join(", ")}`}>
      <GitMerge size={12} className="shrink-0" />
      <span className="min-w-0 truncate">
        Same files as {title}
        {list.length > 1 && ` +${list.length - 1}`}
      </span>
    </p>
  )
})

/** The details panel's list: each other session, how it collides, and on which files. */
export const OverlapList = memo(function OverlapList({ id }: { id: ID }) {
  const list = useOverlaps(id)
  const sessions = useApp((s) => s.sessions)
  if (!list.length) return null
  return (
    <ul className="flex flex-col gap-2">
      {list.map((o) => (
        <li key={o.other} className="flex flex-col gap-0.5 text-xs">
          <button type="button" onClick={() => openSession(o.other)} className="flex min-w-0 items-center gap-1.5 text-left text-foreground hover:underline">
            <GitMerge size={12} className="shrink-0" />
            <span className="min-w-0 truncate">{sessions[o.other]?.title ?? "Another session"}</span>
          </button>
          <span className="pl-[18px] text-muted-foreground">
            {o.sameFolder ? "Same folder: edits can overwrite each other" : "Another worktree: expect a merge conflict"} ·{" "}
            <span className="font-mono" title={o.files.join("\n")}>
              {o.files.slice(0, 3).map(name).join(", ")}
              {o.files.length > 3 && ` +${o.files.length - 3}`}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
})
