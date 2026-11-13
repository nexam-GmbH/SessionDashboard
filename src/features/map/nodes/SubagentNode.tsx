// Adapted from dagster-io/dagster@56029e3:js_modules/ui-core/src/asset-graph/AssetNode.tsx (Apache-2.0). Modified for session-dashboard.
// Subagent card — UI_PLAN §5.1 "Subagent", Calm UI (§2.5): one line, glyph + type + short
// description. Last tool, tool count, duration and the background flag are in the tooltip and the
// inspector. Compact LOD: glyph + type in large type.
import { memo } from "react"
import type { NodeProps } from "@xyflow/react"
import { useSubagent, subagentAsStatus } from "@/store/selectors"
import { BaseNode } from "@/components/flow/base-node"
import { NodeStatusIndicator } from "@/components/flow/node-status-indicator"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { duration } from "@/lib/format"
import { cn } from "@/lib/utils"
import { STATUS_LABEL } from "@/lib/status"
import type { Subagent } from "@/lib/model"
import { useLodTier } from "../lod"
import type { MapNode } from "../layout"
import { CompactGlyph, MapHandles, StatusFlash, useIsSelected, useSpin } from "./shared"

export const SubagentNode = memo(function SubagentNode({ id }: NodeProps<MapNode>) {
  const tier = useLodTier()
  const a = useSubagent(id)
  const selected = useIsSelected("subagent", id)
  const status = a ? subagentAsStatus(a) : "idle"
  const spin = useSpin(id, status, tier)
  if (!a) return null
  const quiet = status === "idle" || status === "stopped"
  return (
    <>
      <MapHandles />
      {tier === "full" ? (
        <BaseNode data-selected={selected || undefined} className="flex h-full w-full items-center gap-2 px-3" title={glanceText(a)}>
          <StatusFlash status={status} />
          <NodeStatusIndicator status={status} variant="border">
            <StatusGlyph status={status} size="xs" animate={spin} title={null} />
            <span className="shrink-0 text-xs text-fg-faint">{a.agentType}</span>
            <span className={cn("min-w-0 flex-1 truncate text-xs", quiet ? "text-fg-muted" : "text-fg")}>{a.description}</span>
          </NodeStatusIndicator>
        </BaseNode>
      ) : (
        <BaseNode data-selected={selected || undefined} className="flex h-full w-full items-center gap-3 overflow-hidden pr-3 pl-4">
          <NodeStatusIndicator status={status} variant="bar">
            <CompactGlyph status={status} size={20} />
            <span className="truncate text-[22px] leading-[28px] text-fg-muted">{a.agentType}</span>
          </NodeStatusIndicator>
        </BaseNode>
      )}
    </>
  )
})

/** Details on demand: status, last tool, tool count, duration, background flag. */
function glanceText(a: Subagent) {
  const ms = Date.parse(a.finishedAt ?? new Date().toISOString()) - Date.parse(a.startedAt)
  return [
    `${a.agentType}: ${a.description}`,
    `${STATUS_LABEL[subagentAsStatus(a)]} · ${a.toolCount} tools${a.lastTool ? ` · last ${a.lastTool}` : ""} · ${duration(Math.max(0, ms))}${a.background ? " · background" : ""}`,
  ].join("\n")
}
