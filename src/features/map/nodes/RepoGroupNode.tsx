// Adapted from kubernetes-sigs/headlamp@e16a575:frontend/src/components/resourceMap/nodes/GroupNode.tsx (Apache-2.0). Modified for session-dashboard.
// Adapted from dagster-io/dagster@56029e3:js_modules/ui-core/src/asset-graph/CollapsedGroupNode.tsx (Apache-2.0). Modified for session-dashboard.
// Repo group — UI_PLAN §5.1 "Repo group", reshaped by the Calm UI rules (§2.5). A labeled group
// (React Flow UI labeled-group-node, MIT) whose header at rest is just the repo name, one
// attention badge (most severe glyph + count of what needs you) and a working spinner with its
// count. Branch, git chips and the Graphify state appear on hover together with the actions.
// Roll-up badge idea from Headlamp's GroupNode/KubeObjectNode (kubernetes-sigs/headlamp@e16a575,
// Apache-2.0: a group surfaces its children's errors).
// At overview LOD the sessions are hidden and the header is redrawn large inside the group box
// (Dagster's groups-only mode, dagster-io/dagster@56029e3 CollapsedGroupNode.tsx, Apache-2.0).
import { memo } from "react"
import type { NodeProps } from "@xyflow/react"
import { ArrowUpRight, ChevronDown, ChevronRight, GitBranch, Plus, Waypoints } from "lucide-react"
import { useApp } from "@/store/app"
import { useRepo, useRepoRollup, type Rollup } from "@/store/selectors"
import { openNewSession, openRepo, toggleRepoCollapsed } from "@/store/actions"
import { GroupNode } from "@/components/flow/labeled-group-node"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { GitChips } from "@/components/common/bits"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { relTime } from "@/lib/format"
import type { Repo, SessionStatus } from "@/lib/model"
import { STATUS_LABEL } from "@/lib/status"
import { useLodTier } from "../lod"
import { GROUP_W, HEADER_H, type MapNode } from "../layout"
import { useMapLocal } from "../mapStore"
import { CompactGlyph, MapHandles, useIsSelected } from "./shared"

/** Statuses that count as "needs you" for the header badge, most severe first. */
const ATTENTION: SessionStatus[] = ["waiting_permission", "waiting_input", "error", "done_unseen"]

/** One attention badge + the working count: the whole roll-up at rest. */
function badges(rollup: Rollup) {
  const top = ATTENTION.find((st) => (rollup[st] ?? 0) > 0)
  // finished-unseen only speaks for itself; waiting and errors are counted together
  const attention = top === "done_unseen" ? (rollup.done_unseen ?? 0) : ATTENTION.slice(0, 3).reduce((n, st) => n + (rollup[st] ?? 0), 0)
  const working = (rollup.working ?? 0) + (rollup.starting ?? 0)
  return { top, attention, working }
}

function rollupTitle(rollup: Rollup) {
  const parts = (Object.keys(STATUS_LABEL) as SessionStatus[]).filter((st) => (rollup[st] ?? 0) > 0).map((st) => `${rollup[st]} ${STATUS_LABEL[st].toLowerCase()}`)
  return parts.length ? parts.join(" · ") : "No live sessions"
}

export const RepoGroupNode = memo(function RepoGroupNode({ id, width, height }: NodeProps<MapNode>) {
  const tier = useLodTier()
  const repo = useRepo(id)
  const rollup = useRepoRollup(id)
  const selected = useIsSelected("repo", id)
  const collapsed = useApp((s) => !!s.map.collapsedRepos[id])
  const hasStack = useMapLocal((s) => !!s.stacks[id])
  if (!repo) return null
  const empty = rollup.total === 0 && !hasStack

  if (tier === "overview") {
    const b = badges(rollup)
    return (
      <GroupNode selected={selected} className="overflow-hidden">
        <MapHandles />
        {/* --map-zoom is set on the canvas only below 0.3 zoom, so this label keeps a readable
            on-screen size without re-rendering on every wheel frame */}
        <OverviewLabel name={repo.name} width={width ?? GROUP_W} height={height ?? HEADER_H} collapsed={collapsed}>
          {!collapsed && (b.top || b.working > 0) && <OverviewRollup rollup={rollup} />}
        </OverviewLabel>
      </GroupNode>
    )
  }

  return (
    <GroupNode
      selected={selected}
      className="group/repo"
      label={tier === "full" ? <FullHeader repo={repo} rollup={rollup} collapsed={collapsed} /> : <CompactHeader repo={repo} rollup={rollup} />}
    >
      <MapHandles />
      {empty && !collapsed && tier === "full" && (
        <div className="flex h-9 items-center gap-2 px-3 text-xs text-fg-faint">
          No sessions
          <Button
            size="xs"
            variant="ghost"
            className="nodrag nopan ml-auto hidden group-hover/repo:inline-flex"
            onClick={(e) => {
              e.stopPropagation()
              openNewSession(repo.id)
            }}
          >
            <Plus /> New
          </Button>
        </div>
      )}
    </GroupNode>
  )
})

function FullHeader({ repo, rollup, collapsed }: { repo: Repo; rollup: Rollup; collapsed: boolean }) {
  const main = repo.worktrees.find((w) => w.isMain) ?? repo.worktrees[0]
  return (
    <div className="flex min-w-0 items-center gap-1.5 pr-2 pl-2" style={{ height: HEADER_H - 1 }}>
      <button
        className="nodrag nopan flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-faint hover:bg-hover hover:text-fg"
        onClick={(e) => {
          e.stopPropagation()
          toggleRepoCollapsed(repo.id)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        title={collapsed ? "Expand (Space)" : "Collapse (Space)"}
        aria-label={collapsed ? "Expand repository" : "Collapse repository"}
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
      </button>
      <span className="max-w-[65%] min-w-0 shrink-0 truncate text-[13px] font-semibold text-fg" title={repo.rootPath}>
        {repo.name}
      </span>
      {/* at rest: the badges; on hover: branch, git state, graph state and the actions */}
      <span className="ml-auto flex shrink-0 items-center group-hover/repo:hidden" title={rollupTitle(rollup)}>
        <Badges rollup={rollup} />
      </span>
      <span
        className="nodrag nopan ml-auto hidden min-w-0 items-center gap-2 group-hover/repo:flex"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-fg-faint" title={`Branch ${main?.branch ?? repo.defaultBranch}`}>
          <GitBranch size={11} className="shrink-0" />
          <span className="truncate font-mono">{main?.branch ?? repo.defaultBranch}</span>
        </span>
        {main && <GitChips git={main.git} className="shrink-0 [&_.text-diff-add]:text-fg-faint [&_.text-diff-del]:text-fg-faint" />}
        <GraphifyState repo={repo} />
        <span className="flex shrink-0 items-center">
          <Button size="icon-xs" variant="ghost" title="New session in this repo" aria-label="New session" onClick={() => openNewSession(repo.id)}>
            <Plus />
          </Button>
          <Button size="icon-xs" variant="ghost" title="Open repository view" aria-label="Open repository view" onClick={() => openRepo(repo.id)}>
            <ArrowUpRight />
          </Button>
        </span>
      </span>
    </div>
  )
}

/** Most severe attention glyph + count, then a working spinner + count; nothing when all is quiet. */
function Badges({ rollup }: { rollup: Rollup }) {
  const { top, attention, working } = badges(rollup)
  return (
    <span className="tabular flex items-center gap-2.5 text-[12px] text-fg-muted">
      {top && (
        <span className="inline-flex items-center gap-1">
          <StatusGlyph status={top} size="xs" animate={false} title={null} />
          {attention}
        </span>
      )}
      {working > 0 && (
        <span className="inline-flex items-center gap-1">
          <StatusGlyph status="working" size="xs" animate={false} title={null} />
          {working}
        </span>
      )}
    </span>
  )
}

function CompactHeader({ repo, rollup }: { repo: Repo; rollup: Rollup }) {
  // only the most urgent state competes with the name for width at this zoom
  const { top, attention, working } = badges(rollup)
  const glyph = top ?? (working > 0 ? "working" : undefined)
  return (
    <div className="flex items-center gap-3 px-3" style={{ height: HEADER_H - 1 }}>
      <span className="min-w-0 flex-1 truncate text-[28px] leading-[34px] font-semibold text-fg">{repo.name}</span>
      {glyph && (
        <span className="tabular flex shrink-0 items-center gap-2.5 text-[26px] text-fg-muted">
          <CompactGlyph status={glyph} size={24} />
          {top ? attention : working}
        </span>
      )}
    </div>
  )
}

/**
 * Overview label: the repo name drawn large inside the group box. Names break only after a
 * hyphen or underscore (never mid-word): the segments are packed into 1–3 lines, choosing the
 * split that allows the largest font for this group's width and height; a name that still
 * doesn't fit ellipsizes (full name in the tooltip).
 */
const OVERVIEW_PAD_X = 32
const OVERVIEW_PAD_Y = 24
/** average advance of IBM Plex Sans semibold lowercase is ~0.46em (measured); 0.52 leaves room for wide glyphs */
const CHAR_EM = 0.52
const LINE_EM = 1.15
/** roll-up row (0.8em) plus the 0.3em gap above it */
const ROLLUP_EM = 1.1
const MAX_FONT = 64
const MIN_FONT = 24

/** All ways to cut `segs` into `k` contiguous lines (k ≤ 3, a handful of segments). */
function partitions(segs: string[], k: number): string[][] {
  if (k === 1) return [[segs.join("")]]
  const out: string[][] = []
  for (let i = 1; i <= segs.length - k + 1; i++) {
    const head = segs.slice(0, i).join("")
    for (const rest of partitions(segs.slice(i), k - 1)) out.push([head, ...rest])
  }
  return out
}

function overviewLayout(name: string, width: number, height: number, rollup: boolean): { lines: string[]; font: number } {
  const segs = name.split(/(?<=[-_])/)
  const textW = width - OVERVIEW_PAD_X
  let best = { lines: [name], font: 0 }
  for (let k = 1; k <= Math.min(3, segs.length); k++) {
    const heightCap = (height - OVERVIEW_PAD_Y) / (k * LINE_EM + (rollup ? ROLLUP_EM : 0))
    for (const lines of partitions(segs, k)) {
      const longest = Math.max(...lines.map((l) => l.length))
      const font = Math.min(MAX_FONT, textW / (longest * CHAR_EM), heightCap)
      // prefer fewer lines unless more lines buy a clearly larger font
      if (font > best.font * 1.08) best = { lines, font }
    }
  }
  return { lines: best.lines, font: Math.max(MIN_FONT, Math.floor(best.font)) }
}

function OverviewLabel({
  name,
  width,
  height,
  collapsed,
  children,
}: {
  name: string
  width: number
  height: number
  collapsed: boolean
  children?: React.ReactNode
}) {
  const { lines, font } = collapsed ? { lines: [name], font: Math.min(MAX_FONT, Math.floor((height - OVERVIEW_PAD_Y) / LINE_EM)) } : overviewLayout(name, width, height, !!children)
  return (
    <div
      className="flex flex-col gap-[0.3em] px-4 py-3"
      // --map-zoom is set on the canvas only below 0.3 zoom, so the label keeps a readable on-screen
      // size without re-rendering on every wheel frame; `font` caps it to what fits this group
      style={{ fontSize: `min(clamp(30px, calc(12.5px / var(--map-zoom, 0.25)), ${MAX_FONT}px), ${font}px)` }}
      title={name}
    >
      <div className="leading-[1.15] font-semibold text-fg">
        {lines.map((l, i) => (
          <div key={i} className="truncate">
            {l}
          </div>
        ))}
      </div>
      {children}
    </div>
  )
}

/** Overview roll-up: the same two badges as the header, sized relative to the label. */
function OverviewRollup({ rollup }: { rollup: Rollup }) {
  const { top, attention, working } = badges(rollup)
  const items: [SessionStatus, number][] = []
  if (top) items.push([top, attention])
  if (working > 0) items.push(["working", working])
  if (!items.length) return null
  return (
    <span className="tabular flex flex-wrap items-center gap-x-[0.6em] text-[0.8em] leading-none text-fg-muted">
      {items.map(([st, n]) => (
        <span key={st} className="inline-flex items-center gap-[0.3em]">
          <span className="inline-flex size-[1em] items-center justify-center [&_svg]:size-[0.9em]">
            <StatusGlyph status={st} size="md" animate={false} title={null} className="size-[1em]" />
          </span>
          {n}
        </span>
      ))}
    </span>
  )
}

/** Graph state on hover: an icon only, faint; stale or indexing reads slightly brighter. */
function GraphifyState({ repo }: { repo: Repo }) {
  const g = repo.graphify
  if (!g || g.state === "none") return null
  return (
    <span
      className={cn("flex shrink-0 items-center", g.state === "fresh" ? "text-fg-faint" : "text-fg-muted")}
      title={`Graph ${g.state}${g.nodes ? ` · ${g.nodes.toLocaleString()} nodes · ${g.edges?.toLocaleString()} edges` : ""}${g.builtAt ? ` · built ${relTime(g.builtAt)} ago` : ""}`}
    >
      <Waypoints size={11} />
    </span>
  )
}
