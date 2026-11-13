// Adapted from argoproj/argo-cd@ae2e784:ui/src/app/applications/components/application-resource-tree/application-resource-tree.tsx (Apache-2.0). Modified for session-dashboard.
// Adapted from dagster-io/dagster@56029e3:js_modules/ui-core/src/asset-graph/AssetNode.tsx (Apache-2.0). Modified for session-dashboard.
// Session card — UI_PLAN §5.1 "Session", reshaped by the Calm UI rules (§2.5).
// At rest a card is status glyph + title (≤ 2 lines) + small age, plus one context line only when
// it carries signal: the waiting request with its inline Allow once / Deny or Answer, the error,
// or what a working session is doing. Branch, model, mode, ctx %, cost, diff and todo progress
// move to the hover glance and the inspector. Anatomy after Argo CD's resource-tree node and
// Dagster's asset node (name + one status line), on top of React Flow UI's base-node (MIT).
// Structure-only node: everything live is read from the store by id, so a status tick re-renders
// this one card and never re-runs the layout. The card's height is planned by the layout (title
// lines + a context row frozen per repo), and the card derives its variant from that height.
import { memo, useState } from "react"
import { NodeToolbar, Position, useStore, type NodeProps } from "@xyflow/react"
import { GitBranch, Timer } from "lucide-react"
import { useApp } from "@/store/app"
import { useSession } from "@/store/selectors"
import { openSession } from "@/store/actions"
import { resolveRequest } from "@/features/session-view/sessionStore"
import { BaseNode } from "@/components/flow/base-node"
import { NodeStatusIndicator } from "@/components/flow/node-status-indicator"
import { NodeTooltipContent } from "@/components/flow/node-tooltip"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { ControlTag } from "@/components/common/bits"
import { RelativeTime } from "@/components/common/RelativeTime"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { plural, usd } from "@/lib/format"
import { capabilities, modelShort, PERMISSION_MODE_LABEL } from "@/lib/status"
import type { Session } from "@/lib/model"
import { useLodTier } from "../lod"
import { CARD_W, hasContextLine, SESSION_MIN_H, sessionVariant, type MapNode } from "../layout"
import { SessionToolbar } from "../NodeActions"
import { CompactGlyph, MapHandles, StatusFlash, useIsSelected, useSpin } from "./shared"

export const SessionNode = memo(function SessionNode({ id, height }: NodeProps<MapNode>) {
  const tier = useLodTier()
  const s = useSession(id)
  const selected = useIsSelected("session", id)
  const spin = useSpin(id, s?.status ?? "idle", tier)
  if (!s) return null
  const h = height ?? SESSION_MIN_H
  return (
    <>
      <MapHandles />
      {selected && (
        <NodeToolbar isVisible position={Position.Top} offset={6}>
          <SessionToolbar id={id} />
        </NodeToolbar>
      )}
      {tier === "full" ? <FullCard s={s} selected={selected} spin={spin} h={h} /> : <CompactCard s={s} selected={selected} h={h} />}
    </>
  )
})

const stop = (e: React.SyntheticEvent) => e.stopPropagation()

/**
 * The calm card. Content is vertically centered, so a card whose status changed since the layout
 * reserved its rows (e.g. working → finished) just gains a little air instead of a hole.
 */
export const FullCard = memo(function FullCard({ s, selected, spin, h }: { s: Session; selected: boolean; spin: boolean; h: number }) {
  const v = sessionVariant(h)
  const history = s.control === "history"
  const quiet = history || s.status === "idle" || s.status === "stopped"
  const wantCtx = !history && hasContextLine(s)
  // the layout froze this card without a context row but its status now has one: on a two-line
  // card the title gives up its second line; on a one-line card only the answer buttons remain
  const squeezed = wantCtx && !v.ctx
  const inlineOnly = squeezed && v.lines === 1
  const oneLine = v.lines === 1 || squeezed
  return (
    <BaseNode data-selected={selected || undefined} className={cn("flex h-full w-full flex-col justify-center px-3", history && "bg-chrome")}>
      <StatusFlash status={s.status} />
      <NodeStatusIndicator status={s.status} variant="border">
        <div className="flex min-w-0 items-start gap-2">
          <StatusGlyph status={s.status} size="sm" animate={spin} className="mt-[1.5px]" />
          <h3
            className={cn("min-w-0 flex-1 text-[13px] leading-[17px] font-medium select-none", quiet ? "text-fg-muted" : "text-fg", oneLine ? "truncate" : "line-clamp-2")}
            title={s.title}
          >
            {s.title}
          </h3>
          {inlineOnly && s.waitingFor ? (
            <RequestLine s={s} buttonsOnly />
          ) : (
            <RelativeTime
              iso={history ? s.updatedAt : s.statusObservedAt}
              // w-[26px] = AGE_W in layout.ts (the title width the layout measures against)
              className="tabular w-[26px] shrink-0 text-right text-[11px] leading-[17px] text-fg-faint"
            />
          )}
        </div>
        {wantCtx && !inlineOnly && (
          <div className={cn("pl-[22px]", squeezed ? "mt-0.5" : "mt-1.5")}>
            <ContextLine s={s} />
          </div>
        )}
      </NodeStatusIndicator>
    </BaseNode>
  )
})

/** The one context line: waiting request, error, current activity, or a running background shell. */
export function ContextLine({ s }: { s: Session }) {
  if ((s.status === "waiting_permission" || s.status === "waiting_input") && s.waitingFor) return <RequestLine s={s} />
  if (s.status === "error") {
    const msg = s.errorMessage ?? "Stopped with an error"
    return (
      <div className="flex h-5 min-w-0 items-center">
        <span className="truncate text-xs text-st-error-fg" title={msg}>
          {msg}
        </span>
      </div>
    )
  }
  if (s.status === "idle") {
    return (
      <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-fg-faint" title="A background shell is still running">
        <Timer size={12} className="shrink-0" />
        <span className="truncate">{plural(s.backgroundTasks, "background task")}</span>
      </div>
    )
  }
  const line = s.activity ?? (s.status === "starting" ? "Starting…" : "Working…")
  return (
    <div className="flex h-5 min-w-0 items-center">
      <span className="truncate text-xs text-fg-muted" title={line}>
        {line}
      </span>
    </div>
  )
}

/**
 * Waiting request on one line: what is asked (attention color) + the *once* answers (UI_PLAN
 * §12.6). Always-allow and deny-with-feedback stay in the session view and the inspector.
 */
function RequestLine({ s, buttonsOnly }: { s: Session; buttonsOnly?: boolean }) {
  const req = useApp((st) => {
    const rid = st.sessions[s.id]?.waitingFor?.requestId
    return rid ? st.requests[rid] : undefined
  })
  const [busy, setBusy] = useState(false)
  const w = s.waitingFor
  if (!w) return null
  const perm = w.kind === "permission"
  const pending = req && req.type === "permission" && req.state === "pending" ? req : undefined
  const allow = pending?.options.find((o) => o.kind === "allow_once")
  const deny = pending?.options.find((o) => o.kind === "reject_once")
  const subject = pending?.subject
  const text = subject?.type === "command" ? subject.command : w.summary
  const canApprove = capabilities(s.control).approve
  return (
    <div className={cn("nodrag nopan flex h-5 min-w-0 items-center gap-1", buttonsOnly ? "shrink-0" : "w-full")} onClick={stop} onDoubleClick={stop}>
      {!buttonsOnly && (
        <span
          className={cn("min-w-0 flex-1 truncate", subject ? "font-mono text-[11px]" : "text-xs", perm ? "text-st-perm-fg" : "text-st-input-fg")}
          title={w.summary}
        >
          {text}
        </span>
      )}
      {perm && pending && allow && deny && canApprove ? (
        <>
          <Button
            size="xs"
            variant="perm"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              resolveRequest(pending, allow.id)
            }}
          >
            Allow once
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              resolveRequest(pending, deny.id)
            }}
          >
            Deny
          </Button>
        </>
      ) : perm ? (
        <span className="shrink-0 text-[11px] text-fg-faint" title="Approve in the terminal where it runs">
          In terminal
        </span>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          className="text-st-input-fg hover:text-st-input-fg"
          onClick={() => openSession(s.id)}
          title="Open the session to answer"
        >
          {w.kind === "plan" ? "Review plan" : "Answer"}
        </Button>
      )}
    </div>
  )
}

/** Compact LOD: the minimal card (Dagster `AssetNodeMinimal` idea): status bar, glyph, title in large type. */
function CompactCard({ s, selected, h }: { s: Session; selected: boolean; h: number }) {
  const history = s.control === "history"
  return (
    <BaseNode data-selected={selected || undefined} className={cn("flex h-full w-full items-center gap-4 overflow-hidden pr-4 pl-5", history && "bg-chrome")}>
      <StatusFlash status={s.status} />
      <NodeStatusIndicator status={s.status} variant="bar">
        <CompactGlyph status={s.status} />
        <span
          className={cn("min-w-0 flex-1 text-[26px] leading-[32px] font-medium", h >= 76 ? "line-clamp-2" : "truncate", history || s.status === "idle" ? "text-fg-muted" : "text-fg")}
        >
          {s.title}
        </span>
      </NodeStatusIndicator>
    </BaseNode>
  )
}

function useBranch(s: Session) {
  return useApp((st) => {
    if (!s.repoId) return undefined
    const repo = st.repos[s.repoId]
    return repo?.worktrees.find((w) => w.id === s.worktreeId)?.branch ?? repo?.defaultBranch
  })
}

const Dot = () => <span className="shrink-0 text-fg-faint/70">·</span>

/** Details on demand (Calm UI rule 2): branch, model, mode, control, diff, plan, agents, ctx, cost. */
export const SessionMeta = memo(function SessionMeta({ s }: { s: Session }) {
  const branch = useBranch(s)
  const agents = useApp((st) => st.subagentIdsBySession[s.id]?.length ?? 0)
  const d = s.diff
  return (
    <div className="flex flex-col gap-1 text-[11px] leading-4 text-fg-faint">
      <div className="flex min-w-0 items-center gap-1.5">
        <GitBranch size={11} className="shrink-0" />
        <span className="min-w-0 truncate font-mono">{branch ?? "no branch"}</span>
        <ControlTag mode={s.control} className="ml-auto" />
      </div>
      <div className="tabular flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        <span className="text-fg-muted">{modelShort(s.model)}</span>
        {s.permissionMode !== "default" && (
          <>
            <Dot />
            <span>{PERMISSION_MODE_LABEL[s.permissionMode]}</span>
          </>
        )}
        <Dot />
        <span>ctx {s.usage.contextPct}%</span>
        <Dot />
        <span>{usd(s.usage.costUsd)}</span>
      </div>
      <div className="tabular flex min-w-0 flex-wrap items-center gap-x-1.5 whitespace-nowrap">
        <span>{d.filesChanged ? `+${d.linesAdded} −${d.linesRemoved} · ${plural(d.filesChanged, "file")}` : "No changes"}</span>
        {d.unpushed > 0 && (
          <>
            <Dot />
            <span>↑{d.unpushed}</span>
          </>
        )}
        {s.todo && (
          <>
            <Dot />
            <span>
              plan {s.todo.done}/{s.todo.total}
            </span>
          </>
        )}
        {agents > 0 && (
          <>
            <Dot />
            <span>{plural(agents, "agent")}</span>
          </>
        )}
      </div>
    </div>
  )
})

/**
 * Hover glance (UI_PLAN §5.1, Headlamp's 450ms glance): one shared floating layer for the hovered
 * session, rendered by the canvas, so cards carry no tooltip state. At full LOD it is the details
 * line under the card; at compact LOD it is the readable card plus those details.
 */
export const SessionGlance = memo(function SessionGlance({ id, mode }: { id: string; mode: "meta" | "card" }) {
  const s = useSession(id)
  // the compact glance opens toward the roomier side of the canvas so it is never clipped
  const left = useStore((st) => {
    const n = st.nodeLookup.get(id)
    if (!n) return false
    const sx = n.internals.positionAbsolute.x * st.transform[2] + st.transform[0]
    return sx > st.width / 2
  })
  if (!s) return null
  if (mode === "meta") {
    return (
      // beside the card (roomier side), so it never hides the next card in the same repo
      <NodeTooltipContent nodeId={id} isVisible position={left ? Position.Left : Position.Right} offset={10} className="px-3 py-2" style={{ width: CARD_W }}>
        <SessionMeta s={s} />
      </NodeTooltipContent>
    )
  }
  const ctx = s.control !== "history" && hasContextLine(s)
  return (
    <NodeTooltipContent nodeId={id} isVisible position={left ? Position.Left : Position.Right} offset={10} style={{ width: CARD_W }}>
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <div className="flex min-w-0 items-start gap-2">
          <StatusGlyph status={s.status} size="sm" animate={false} className="mt-[1.5px]" />
          <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-[17px] font-medium text-fg">{s.title}</span>
          <RelativeTime iso={s.statusObservedAt} className="tabular shrink-0 text-[11px] leading-[17px] text-fg-faint" />
        </div>
        {ctx && (
          <div className="pl-[22px]">
            <ContextLine s={s} />
          </div>
        )}
      </div>
      <div className="border-t border-line-subtle px-3 py-2">
        <SessionMeta s={s} />
      </div>
    </NodeTooltipContent>
  )
})
