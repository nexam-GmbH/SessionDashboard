// full control of one session, like the Claude Code app.
// (Its header lives in the window header, app/SiteHeader.) Control banner · virtualized transcript with a live tail · activity bar ·
// attention dock · queue · composer. Each region subscribes to its own slice.
import { memo, useEffect, type ReactNode } from "react"
import type { ID } from "@/lib/model"
import { useApp } from "@/store/app"
import { EmptyState } from "@/components/common/bits"
import { ensureTranscript } from "@/backend/transcript"
import { ControlBanner } from "./banners/ControlBanner"
import { Transcript } from "./transcript/Transcript"
import { ActivityBar } from "./activity/ActivityBar"
import { AttentionDock } from "./attention/AttentionDock"
import { PromptQueue } from "./composer/PromptQueue"
import { Composer } from "./composer/Composer"
import { DiffWorkerPool } from "./tools/InlineDiff"
import { StatusAnnouncer } from "./StatusAnnouncer"
import { useUiValue } from "./sessionStore"
import { DetailsPanel } from "./details/DetailsPanel"

export default function SessionView({ sessionId }: { sessionId: string }) {
  const exists = useApp((s) => !!s.sessions[sessionId])
  useEffect(() => {
    ensureTranscript(sessionId)
  }, [sessionId])
  if (!exists) return <EmptyState>Session not found. It may have been archived.</EmptyState>
  return (
    <DiffWorkerPool>
      <SessionLayout sessionId={sessionId} />
    </DiffWorkerPool>
  )
}

const SessionLayout = memo(function SessionLayout({ sessionId }: { sessionId: ID }) {
  const details = useApp((s) => s.settings.detailsOpen)
  return (
    <div data-session-view={sessionId} data-chat className="flex h-full min-h-0 bg-background [contain:strict]">
      <div className="flex min-w-0 flex-1 flex-col">
        <StatusAnnouncer sessionId={sessionId} />
        <ControlBanner sessionId={sessionId} />
        {/* the active request takes the composer's place (Claude Code desktop); a terminal session's sits at the conversation's end */}
        <Transcript sessionId={sessionId} requests={<AttentionDock sessionId={sessionId} />} />
        <div className="@container shrink-0 pt-1.5">
          <ActivityBar sessionId={sessionId} />
          <PromptQueue sessionId={sessionId} />
          <AttentionDock sessionId={sessionId} composer={(dock, docked) => <ComposerSlot sessionId={sessionId} dock={dock} docked={docked} />} />
        </div>
      </div>
      {details && <DetailsPanel sessionId={sessionId} />}
    </div>
  )
})

/** Rewind sets a new prefill; remounting the composer with it keeps the composer free of sync effects. */
function ComposerSlot({ sessionId, dock, docked }: { sessionId: ID; dock: ReactNode; docked: boolean }) {
  const prefill = useUiValue<{ n: number } | null>(`prefill:${sessionId}`, null)
  return <Composer key={prefill?.n ?? 0} sessionId={sessionId} dock={dock} docked={docked} />
}
