// Adapted from argoproj/argo-cd@ae2e784:ui/src/app/applications/components/application-resource-tree/application-resource-tree.tsx (Apache-2.0). Modified for session-dashboard.
// Adapted from kubernetes-sigs/headlamp@e16a575:frontend/src/components/resourceMap/nodes/KubeObjectNode.tsx (Apache-2.0). Modified for session-dashboard.
// Collapsed stack of idle/history sessions — UI_PLAN §5.1 "Collapsed stack"; Calm UI (§2.5): one
// short line, "N idle", plus a glyph only when a member changed status since it was collapsed.
// "N collapsed" sibling grouping from Argo CD's resource tree (argoproj/argo-cd@ae2e784,
// application-resource-tree.tsx `renderGroupedNodes`, Apache-2.0), drawn as stacked cards like
// Headlamp's collapsed group (`::before`/`::after` layers only when count > 1 / > 2) and
// Dagster's CollapsedGroupNode stack lines (narrower slivers under the box). Click expands.
import { memo } from "react"
import type { NodeProps } from "@xyflow/react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useApp } from "@/store/app"
import { toggleStack } from "@/store/actions"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { cn } from "@/lib/utils"
import { relTime } from "@/lib/format"
import { STATUS_TIER } from "@/lib/status"
import type { ID, SessionStatus } from "@/lib/model"
import { useLodTier } from "../lod"
import { useMapLocal, type StackMeta } from "../mapStore"
import type { MapNode } from "../layout"
import { CompactGlyph, MapHandles } from "./shared"

const EMPTY: ID[] = []

export const StackNode = memo(function StackNode({ data }: NodeProps<MapNode>) {
  const repoId = data.id
  const tier = useLodTier()
  const meta = useMapLocal((s) => s.stacks[repoId]) as StackMeta | undefined
  const idle = meta?.idle ?? EMPTY
  // members are frozen until the next structural change; surface any that changed status since
  const changed = useApp((s) => {
    let best: SessionStatus | null = null
    let n = 0
    for (const id of idle) {
      const st = s.sessions[id]?.status
      if (!st || st === "idle" || st === "stopped") continue
      n++
      if (!best || STATUS_TIER[st] < STATUS_TIER[best]) best = st
    }
    return best ? `${best}:${n}` : ""
  })
  const last = useApp((s) => {
    let max = ""
    for (const id of idle) {
      const u = s.sessions[id]?.updatedAt ?? ""
      if (u > max) max = u
    }
    return max
  })
  if (!meta) return null
  const total = idle.length + meta.history.length
  const count = idle.length + meta.historyTotal
  const [changedStatus, changedN] = changed ? (changed.split(":") as [SessionStatus, string]) : [null, "0"]

  const label = [idle.length > 0 && `${idle.length} idle`, meta.historyTotal > 0 && `${meta.historyTotal} history`].filter(Boolean).join(" · ")
  const tip = `${label}${last ? ` · last active ${relTime(last)} ago` : ""}${meta.historyTotal > meta.history.length ? ` · showing ${meta.history.length} from history` : ""}`

  if (meta.expanded) {
    return (
      <>
        <MapHandles />
        <button
          className="flex h-full w-full items-center gap-1.5 rounded-md border border-dashed border-line-subtle px-3 text-left text-xs text-fg-faint hover:border-line hover:text-fg-muted"
          onClick={(e) => {
            e.stopPropagation()
            toggleStack(repoId)
          }}
          title={`${tip} · collapse (Space)`}
        >
          <ChevronDown size={12} className="shrink-0" />
          <span className={cn("truncate", tier !== "full" && "text-[20px]")}>{label}</span>
        </button>
      </>
    )
  }

  return (
    <div className="relative h-full w-full">
      <MapHandles />
      {total > 2 && <div aria-hidden className="absolute inset-x-3 -bottom-2 h-2 rounded-b-md border border-t-0 border-line-subtle bg-chrome" />}
      {total > 1 && <div aria-hidden className="absolute inset-x-1.5 -bottom-1 h-1.5 rounded-b-md border border-t-0 border-line-subtle bg-elevated" />}
      <div
        className="group/stack relative flex h-full w-full cursor-pointer items-center gap-2 rounded-md border border-line-subtle bg-elevated px-3 hover:border-line"
        title={`${tip} · expand (Space)`}
      >
        {tier === "full" ? (
          <>
            <span className="tabular min-w-0 truncate text-xs text-fg-muted">{label}</span>
            {changedStatus && (
              <span className="tabular inline-flex shrink-0 items-center gap-1 text-[11px] text-fg-muted" title="Changed since collapsed">
                <StatusGlyph status={changedStatus} size="xs" animate={false} title={null} />
                {changedN}
              </span>
            )}
            <ChevronRight size={12} className="ml-auto shrink-0 text-fg-faint opacity-0 group-hover/stack:opacity-100" />
          </>
        ) : (
          <>
            <span className="tabular truncate text-[24px] leading-[30px] text-fg-muted">{count} idle</span>
            {changedStatus && (
              <span className="ml-auto">
                <CompactGlyph status={changedStatus} size={22} />
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
})
