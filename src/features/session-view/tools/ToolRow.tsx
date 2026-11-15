// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-chat/index.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from BloopAI/vibe-kanban@5f06193:packages/ui/src/components/ChatToolSummary.tsx (Apache-2.0).
// Changes: one tool call is one line as in Claude Code desktop: kind icon, a verb and its target
// ("Ran `npm test`", "Edited src/auth/retry.ts"), a status only when it did not simply work. Every
// row starts collapsed; a click opens the call's details. Selects only its own item from the store;
// disclosure state survives virtualization.
import { memo } from "react"
import type { ID, ToolCall } from "@/lib/model"
import { duration } from "@/lib/format"
import { useExpanded, useItem } from "../sessionStore"
import { buildToolSummary, toolDurationMs } from "./toolSummary"
import { ToolBody } from "./ToolBodies"
import { PlanCard, SubagentCard } from "./CardTools"
import { ToolLine } from "./ToolLine"

export const ToolRow = memo(function ToolRow({ sessionId, itemId }: { sessionId: ID; itemId: ID }) {
  const item = useItem(sessionId, itemId)
  if (item?.type !== "tool_call") return null
  return <ToolRowInner sessionId={sessionId} call={item.call} itemId={itemId} />
})

const ToolRowInner = memo(function ToolRowInner({ sessionId, call, itemId }: { sessionId: ID; call: ToolCall; itemId: ID }) {
  const summary = buildToolSummary(call)
  // Inputs and outputs are one click away: every row starts collapsed.
  const [open, setOpen] = useExpanded(`tool:${itemId}`, false)
  if (summary.family === "agent") return <SubagentCard sessionId={sessionId} call={call} itemId={itemId} />
  if (summary.family === "plan") return <PlanCard sessionId={sessionId} call={call} itemId={itemId} />
  const ms = toolDurationMs(call)
  return (
    <ToolLine
      sessionId={sessionId}
      summary={summary}
      name={call.name}
      display={call.display}
      asks={summary.family === "question"}
      open={open}
      onToggle={() => setOpen(!open)}
      trailing={ms !== undefined && ms >= 1000 ? duration(ms) : undefined}
    >
      <ToolBody call={call} family={summary.family} />
    </ToolLine>
  )
})
