import { type ReactNode } from "react"
import { ArrowDown, ArrowUp, CircleCheck, CircleDot, CircleX, GitPullRequest, GitPullRequestDraft, GitMerge } from "lucide-react"
import { cn } from "@/lib/utils"
import type { GitSnapshot } from "@/lib/model"

/** +added −removed, VS Code Dark Modern gutter colors. */
export function DiffStat({ added, removed, className, pill }: { added: number; removed: number; className?: string; pill?: boolean }) {
  if (!added && !removed) return null
  // pill: Claude Code desktop's green / red counts on a work summary line
  if (pill)
    return (
      <span className={cn("tabular inline-flex gap-1 font-mono text-xs", className)}>
        <span className="rounded-[5px] bg-diff-add-tint px-1 text-diff-add">+{added}</span>
        <span className="rounded-[5px] bg-diff-del-tint px-1 text-diff-del">−{removed}</span>
      </span>
    )
  return (
    <span className={cn("tabular inline-flex gap-1 font-mono text-xs", className)}>
      <span className="text-diff-add">+{added}</span>
      <span className="text-diff-del">−{removed}</span>
    </span>
  )
}

/** ↑ unpushed ↓ behind (Crystal GitStatus, MIT). */
export function AheadBehind({ ahead, behind, className }: { ahead: number; behind: number; className?: string }) {
  if (!ahead && !behind) return null
  return (
    <span className={cn("tabular inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground", className)}>
      {ahead > 0 && (
        <span className="inline-flex items-center" title={`${ahead} unpushed commit${ahead > 1 ? "s" : ""}`}>
          <ArrowUp size={11} strokeWidth={2} />
          {ahead}
        </span>
      )}
      {behind > 0 && (
        <span className="inline-flex items-center" title={`${behind} behind upstream`}>
          <ArrowDown size={11} strokeWidth={2} />
          {behind}
        </span>
      )}
    </span>
  )
}

export function PrChip({ pr }: { pr: NonNullable<GitSnapshot["pr"]> }) {
  const Icon = pr.state === "merged" ? GitMerge : pr.state === "draft" ? GitPullRequestDraft : GitPullRequest
  const check =
    pr.checks === "passing" ? (
      <CircleCheck size={11} color="var(--st-done)" />
    ) : pr.checks === "failing" ? (
      <CircleX size={11} color="var(--st-error)" />
    ) : pr.checks === "pending" ? (
      <CircleDot size={11} color="var(--st-input)" />
    ) : null
  return (
    <span
      className="tabular inline-flex items-center gap-1 font-mono text-xs text-muted-foreground"
      title={`PR #${pr.number} · ${pr.state} · checks ${pr.checks}`}
    >
      <Icon size={11} className={pr.state === "merged" ? "text-[#8e4ec6]" : undefined} />#{pr.number}
      {check}
    </span>
  )
}

export function GitChips({ git, className }: { git: GitSnapshot; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <AheadBehind ahead={git.unpushed} behind={git.behind} />
      <DiffStat added={git.linesAdded} removed={git.linesRemoved} />
      {git.pr && <PrChip pr={git.pr} />}
      {git.state === "clean" && !git.unpushed && !git.behind && !git.pr && (
        <span className="text-xs text-muted-foreground/70">clean</span>
      )}
    </span>
  )
}

/** VS Code style panel header: 28px, 11px uppercase label, actions on the right. */
export function PanelHeader({
  label,
  count,
  actions,
  className,
  onClick,
}: {
  label: ReactNode
  count?: number
  actions?: ReactNode
  className?: string
  onClick?: () => void
}) {
  return (
    <div
      className={cn("group/ph flex h-7 shrink-0 items-center gap-1.5 pr-1.5 pl-3", onClick && "cursor-default", className)}
      onClick={onClick}
    >
      <span className="text-xs font-medium text-muted-foreground truncate">{label}</span>
      {count !== undefined && <span className="tabular text-xs text-muted-foreground/70">{count}</span>}
      <span className="ml-auto flex items-center gap-0.5">{actions}</span>
    </div>
  )
}

// Adapted from triggerdotdev/trigger.dev@2fbd5c7:apps/webapp/app/components/primitives/PropertyTable.tsx
// (Apache-2.0). Modified: horizontal label/value grid at IDE density.
export function PropertyTable({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-[minmax(84px,auto)_1fr] gap-x-3 gap-y-1.5 text-xs", className)}>{children}</div>
}
export function Prop({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <div className="truncate text-muted-foreground/70">{label}</div>
      <div className={cn("min-w-0 truncate text-muted-foreground", mono && "font-mono text-xs")}>{children}</div>
    </>
  )
}

// Adapted from mountain-loop/yaak@6a34d0a:packages/ui/src/components/EmptyStateText.tsx (MIT).
// Modified: no italics/dashed box by default; one sentence + optional action.
export function EmptyState({
  children,
  action,
  className,
  boxed,
}: {
  children: ReactNode
  action?: ReactNode
  className?: string
  boxed?: boolean
}) {
  return (
    <div className={cn("flex h-full w-full items-center justify-center p-4", className)}>
      <div
        className={cn(
          "flex max-w-sm flex-col items-center gap-2 text-center text-xs text-muted-foreground/70",
          boxed && "rounded-md border border-dashed border-border px-6 py-5",
        )}
      >
        <div>{children}</div>
        {action}
      </div>
    </div>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-border bg-muted px-1 font-sans text-xs leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  )
}

export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent)
export const MOD = isMac ? "⌘" : "Ctrl"

export function Shortcut({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((k, i) => (
        <Kbd key={i}>{k === "mod" ? MOD : k}</Kbd>
      ))}
    </span>
  )
}

export function Divider({ vertical, className }: { vertical?: boolean; className?: string }) {
  return <div className={cn(vertical ? "mx-1 h-4 w-px bg-border" : "h-px w-full bg-border", className)} />
}
