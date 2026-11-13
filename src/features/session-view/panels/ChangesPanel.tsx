// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-changes.tsx (AgentChangedFile row; Apache-2.0). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/views/chat/changes-panel.tsx (Apache-2.0).
// Changes panel for the right inspector (UI_PLAN §5.3): a dense file list (name, dir, ±,
// pending marker) derived from the transcript's FileChanges, "Review all" → the Review
// tab; no inline diffs here (Review owns them).
import { memo, useEffect } from "react"
import { FileCode2, FileDiff, FilePlus2 } from "lucide-react"
import type { ID } from "@/lib/model"
import { openReview } from "@/store/actions"
import { DiffStat, EmptyState } from "@/components/common/bits"
import { Button } from "@/components/ui/button"
import { ensureTranscript } from "@/mocks/transcript"
import { plural } from "@/lib/format"
import { useChangedFiles } from "../sessionStore"

export const ChangesPanel = memo(function ChangesPanel({ sessionId }: { sessionId: ID }) {
  useEffect(() => {
    ensureTranscript(sessionId)
  }, [sessionId])
  const files = useChangedFiles(sessionId)
  if (!files.length) return <EmptyState>No file changes in this session yet.</EmptyState>
  const added = files.reduce((a, f) => a + f.added, 0)
  const removed = files.reduce((a, f) => a + f.removed, 0)
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 px-3 text-[11px] text-fg-faint">
        <span>{plural(files.length, "file")}</span>
        <DiffStat added={added} removed={removed} />
        <Button size="xs" variant="secondary" className="ml-auto" onClick={() => openReview(sessionId)}>
          <FileDiff /> Review all
        </Button>
      </div>
      <div className="flex flex-col px-1 pb-2">
        {files.map((f) => {
          const slash = f.path.lastIndexOf("/")
          const Icon = f.op === "add" ? FilePlus2 : FileCode2
          return (
            <button
              key={f.path}
              type="button"
              title={`${f.path} · ${plural(f.edits, "edit")}${f.pending ? " · waiting for approval" : ""}`}
              onClick={() => openReview(sessionId)}
              className="group/f flex h-6 min-w-0 items-center gap-1.5 rounded-[3px] px-2 text-left text-[12px] hover:bg-hover"
            >
              <Icon size={12} className="shrink-0 text-fg-faint" />
              <span className="shrink-0 truncate text-fg-muted group-hover/f:text-fg">{f.path.slice(slash + 1)}</span>
              <span className="min-w-0 truncate font-mono text-[10.5px] text-fg-faint">{slash > 0 ? f.path.slice(0, slash) : ""}</span>
              {f.pending && <span className="ml-1 size-1.5 shrink-0 rotate-45 bg-st-perm" title="Pending approval" />}
              <DiffStat added={f.added} removed={f.removed} className="ml-auto shrink-0" />
            </button>
          )
        })}
      </div>
    </div>
  )
})
