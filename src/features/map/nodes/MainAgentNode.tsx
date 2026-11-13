// Main agent card (top center) — UI_PLAN §5.1 "Main agent", reshaped by the Calm UI rules (§2.5):
// status glyph + title, one line (what it is doing or waits on, or "3 of 4 repos done"), and the
// delegated repos as compact rows (glyph + repo name). Open / Cross-repo task live in the
// selection toolbar and the context menu; control mode, age details and scope in the inspector.
import { memo } from "react"
import { NodeToolbar, Position, type NodeProps } from "@xyflow/react"
import { useApp, type AppState } from "@/store/app"
import { useSession } from "@/store/selectors"
import { openSession, select } from "@/store/actions"
import { BaseNode } from "@/components/flow/base-node"
import { NodeStatusIndicator } from "@/components/flow/node-status-indicator"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { RelativeTime } from "@/components/common/RelativeTime"
import { cn } from "@/lib/utils"
import { plural } from "@/lib/format"
import { STATUS_TIER } from "@/lib/status"
import type { ID } from "@/lib/model"
import { useLodTier } from "../lod"
import type { MapNode } from "../layout"
import { SessionToolbar } from "../NodeActions"
import { CompactGlyph, MapHandles, StatusFlash, useIsSelected, useSpin } from "./shared"
import { ContextLine } from "./SessionNode"

/** Delegated children of the main agent; recomputed only on structural change. */
const selectDelegated = (() => {
  let v = -1
  let cached: ID[] = []
  return (s: AppState) => {
    if (s.structVersion !== v) {
      v = s.structVersion
      cached = Object.values(s.sessions)
        .filter((x) => !x.archived && x.parent?.sessionId === s.mainSessionId && x.parent.kind === "delegated")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((x) => x.id)
    }
    return cached
  }
})()

export const MainAgentNode = memo(function MainAgentNode({ id }: NodeProps<MapNode>) {
  const tier = useLodTier()
  const s = useSession(id)
  const selected = useIsSelected("session", id)
  const spin = useSpin(id, s?.status ?? "idle", tier)
  const delegated = useApp(selectDelegated)
  const done = useApp((st) => delegated.filter((d) => st.sessions[d]?.status === "done_unseen" || st.sessions[d]?.status === "idle").length)
  const pending = useApp(
    (st) => delegated.filter((d) => STATUS_TIER[st.sessions[d]?.status ?? "idle"] === 0).length + (st.sessions[id] && STATUS_TIER[st.sessions[id].status] === 0 ? 1 : 0),
  )
  if (!s) return null

  if (tier !== "full") {
    return (
      <BaseNode
        data-selected={selected || undefined}
        className="flex h-full w-full flex-col justify-center gap-2 overflow-hidden px-6 whitespace-nowrap"
        // one size at compact and overview: the card is only MAIN_H tall, so "Main agent" stays on one
        // line and the status line still fits under it
        style={{ fontSize: 38 }}
      >
        <MapHandles />
        <NodeStatusIndicator status={s.status} variant="bar">
          <div className="flex items-center gap-4">
            <CompactGlyph status={s.status} size={36} />
            <span className="text-[1em] leading-[1.2] font-semibold text-fg">Main agent</span>
          </div>
          <div className="truncate text-[0.75em] leading-[1.2] text-fg-muted">
            {pending > 0 ? <span className="text-st-perm-fg">{pending} waiting</span> : `${done} of ${delegated.length} done`}
          </div>
        </NodeStatusIndicator>
      </BaseNode>
    )
  }

  const waiting = s.status === "waiting_permission" || s.status === "waiting_input"
  const speaks = waiting || s.status === "error" || ((s.status === "working" || s.status === "starting") && !!s.activity)
  const shown = delegated.length > 4 ? delegated.slice(0, 3) : delegated
  return (
    <>
      <MapHandles />
      {selected && (
        <NodeToolbar isVisible position={Position.Top} offset={6}>
          <SessionToolbar id={id} />
        </NodeToolbar>
      )}
      <BaseNode data-selected={selected || undefined} className="flex h-full w-full flex-col justify-center px-3">
        <StatusFlash status={s.status} />
        <NodeStatusIndicator status={s.status} variant="border">
          <div className="flex min-w-0 items-start gap-2">
            <StatusGlyph status={s.status} size="sm" animate={spin} className="mt-[1.5px]" />
            <h3 className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-[17px] font-semibold text-fg select-none" title={`Main agent: ${s.title}`}>
              {s.title}
            </h3>
            <RelativeTime iso={s.statusObservedAt} className="tabular w-[26px] shrink-0 text-right text-[11px] leading-[17px] text-fg-faint" />
          </div>
          <div className="mt-1 pl-[22px]">
            {speaks ? (
              <ContextLine s={s} />
            ) : (
              <div className="flex h-5 items-center text-xs text-fg-muted">
                {delegated.length ? `${done} of ${plural(delegated.length, "repo")} done` : "No delegated tasks"}
              </div>
            )}
          </div>
          {delegated.length > 0 && (
            <div className="mt-2 grid grid-cols-2 gap-x-2 pl-4">
              {shown.map((d) => (
                <DelegatedRow key={d} id={d} />
              ))}
              {delegated.length > 4 && <div className="flex h-[22px] items-center px-1.5 text-xs text-fg-faint">+{delegated.length - 3} more</div>}
            </div>
          )}
        </NodeStatusIndicator>
      </BaseNode>
    </>
  )
})

/** A delegated task as a compact row: glyph + repo name (the task title is in the tooltip). */
function DelegatedRow({ id }: { id: ID }) {
  const s = useSession(id)
  const repoName = useApp((st) => (s?.repoId ? st.repos[s.repoId]?.name : undefined))
  const selected = useIsSelected("session", id)
  if (!s) return null
  return (
    <button
      className={cn(
        "nodrag nopan flex h-[22px] min-w-0 items-center gap-2 rounded-sm px-1.5 text-left hover:bg-hover",
        selected && "bg-selected",
      )}
      onClick={(e) => {
        e.stopPropagation()
        select({ kind: "session", id })
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        openSession(id)
      }}
      title={`${repoName}: ${s.title}`}
    >
      <StatusGlyph status={s.status} size="xs" animate={false} title={null} />
      <span className="min-w-0 truncate text-xs text-fg-muted">{repoName ?? s.title}</span>
    </button>
  )
}
