// Session view — UI_PLAN §5.3: full control of one session, like the Claude Code app.
// Header · control banner · virtualized transcript with a live tail · activity bar ·
// attention dock · queue · composer. Each region subscribes to its own slice.
import { memo, useEffect } from "react"
import type { ID } from "@/lib/model"
import { useApp } from "@/store/app"
import { EmptyState } from "@/components/common/bits"
import { ensureTranscript } from "@/mocks/transcript"
import { SessionHeader } from "./header/SessionHeader"
import { ControlBanner } from "./banners/ControlBanner"
import { Transcript } from "./transcript/Transcript"
import { ActivityBar } from "./activity/ActivityBar"
import { AttentionDock } from "./attention/AttentionDock"
import { PromptQueue } from "./composer/PromptQueue"
import { Composer } from "./composer/Composer"
import { DiffWorkerPool } from "./tools/InlineDiff"

export default function SessionView({ sessionId, popout }: { sessionId: string; popout?: boolean }) {
  const exists = useApp((s) => !!s.sessions[sessionId])
  useEffect(() => {
    ensureTranscript(sessionId)
  }, [sessionId])
  if (!exists) return <EmptyState>Session not found. It may have been archived.</EmptyState>
  return (
    <DiffWorkerPool>
      <SessionLayout sessionId={sessionId} popout={popout} />
    </DiffWorkerPool>
  )
}

const SessionLayout = memo(function SessionLayout({ sessionId, popout }: { sessionId: ID; popout?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas contain-strict">
      <SessionHeader sessionId={sessionId} popout={popout} />
      <ControlBanner sessionId={sessionId} />
      <Transcript sessionId={sessionId} />
      <div className="shrink-0 pt-1.5">
        <ActivityBar sessionId={sessionId} />
        <AttentionDock sessionId={sessionId} />
        <PromptQueue sessionId={sessionId} />
        <Composer sessionId={sessionId} />
      </div>
    </div>
  )
})
