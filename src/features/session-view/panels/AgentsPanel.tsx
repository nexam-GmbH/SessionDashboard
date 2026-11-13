// Agents panel for the right inspector — UI_PLAN §5.3 "Inspector tabs": the subagent tree with status.
// Row fields after agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/subagents/model.ts (MIT):
// type, description, status, tool count, last tool, elapsed. Modified for session-dashboard: tree by
// parentSubagentId, status glyphs (UI_PLAN §2.3), click selects the subagent (inspector detail).
import { memo, useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import type { ID, Subagent } from "@/lib/model"
import { useApp } from "@/store/app"
import { select } from "@/store/actions"
import { subagentAsStatus, useSubagentIds } from "@/store/selectors"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { EmptyState } from "@/components/common/bits"
import { useNow } from "@/components/common/RelativeTime"
import { duration } from "@/lib/format"
import { cn } from "@/lib/utils"

const LABEL: Record<Subagent["status"], string> = {
  running: "running",
  waiting_permission: "needs permission",
  completed: "done",
  failed: "failed",
  stopped: "stopped",
}

function flatten(subs: Subagent[]) {
  const byParent = new Map<string, Subagent[]>()
  for (const s of subs) {
    const k = s.parentSubagentId ?? ""
    byParent.set(k, [...(byParent.get(k) ?? []), s])
  }
  const out: { sub: Subagent; depth: number }[] = []
  const walk = (k: string, depth: number) => {
    for (const s of (byParent.get(k) ?? []).sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      out.push({ sub: s, depth })
      walk(s.id, depth + 1)
    }
  }
  walk("", 0)
  // orphans whose parent isn't in this session
  for (const s of subs) if (!out.some((o) => o.sub === s)) out.push({ sub: s, depth: 0 })
  return out
}

export const AgentsPanel = memo(function AgentsPanel({ sessionId }: { sessionId: ID }) {
  const ids = useSubagentIds(sessionId)
  const subs = useApp(useShallow((s) => ids.map((id) => s.subagents[id]).filter(Boolean)))
  const selected = useApp((s) => (s.selection?.kind === "subagent" ? s.selection.id : null))
  const now = useNow()
  const rows = useMemo(() => flatten(subs), [subs])
  if (!rows.length) return <EmptyState>No subagents in this session.</EmptyState>
  return (
    <div className="flex flex-col px-1 py-1">
      {rows.map(({ sub, depth }) => {
        const live = sub.status === "running" || sub.status === "waiting_permission"
        const elapsed = (sub.finishedAt ? Date.parse(sub.finishedAt) : now) - Date.parse(sub.startedAt)
        return (
          <button
            key={sub.id}
            type="button"
            onClick={() => select({ kind: "subagent", id: sub.id })}
            className={cn(
              "flex min-w-0 flex-col gap-0.5 rounded-[3px] px-2 py-1 text-left hover:bg-hover",
              selected === sub.id && "bg-selected",
            )}
            style={{ paddingLeft: 8 + depth * 14 }}
          >
            <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
              <StatusGlyph status={subagentAsStatus(sub)} size="xs" animate={live} />
              <span className="shrink-0 font-mono text-[11px] text-fg-faint">{sub.agentType}</span>
              <span className="min-w-0 truncate text-fg-muted">{sub.description}</span>
              {sub.background && <span className="shrink-0 rounded-[2px] border border-line-subtle px-1 text-[10px] text-fg-faint">bg</span>}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 pl-[18px] text-[11px] text-fg-faint">
              <span className={cn(sub.status === "waiting_permission" && "text-st-perm-fg", sub.status === "failed" && "text-st-error-fg")}>{LABEL[sub.status]}</span>
              <span className="tabular">· {sub.toolCount} tools</span>
              {sub.lastTool && live && <span className="truncate">· {sub.lastTool}</span>}
              <span className="tabular ml-auto shrink-0">{duration(Math.max(0, elapsed))}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
})
