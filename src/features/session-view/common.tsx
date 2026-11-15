// Small shared pieces of the chat: a tool's icon and status, the disclosure chevron, clickable file
// paths and the mono output block. Status idea from BloopAI/vibe-kanban@5f06193:
// packages/ui/src/components/ToolStatusDot.tsx (Apache-2.0); here a finished call shows nothing,
// a running one an animated spinner, and failed / denied / waiting a word (never color alone).
import { memo, type ReactNode } from "react"
import {
  Bot,
  ChevronRight,
  ClipboardList,
  FilePen,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  Network,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import type { ID, ToolCall } from "@/lib/model"
import { getApp, useApp } from "@/store/app"
import { openReview } from "@/store/actions"
import { setActive } from "@/features/review/reviewStore"
import { IN_TAURI } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { useChangedFiles } from "./sessionStore"
import { relPath, type ToolFamily } from "./tools/toolSummary"

const FAMILY_ICON: Record<ToolFamily, LucideIcon> = {
  command: SquareTerminal,
  read: FileText,
  edit: FilePen,
  search: Search,
  graph: Network,
  web: Globe,
  agent: Bot,
  todo: ListChecks,
  plan: ClipboardList,
  question: MessageCircleQuestion,
  mcp: Plug,
  other: Wrench,
}

export function ToolIcon({ family, name, className }: { family: ToolFamily; name?: string; className?: string }) {
  const Icon = name === "Write" ? FilePlus : name === "LS" ? FolderOpen : FAMILY_ICON[family]
  return <Icon size={14} strokeWidth={1.75} aria-hidden className={cn("shrink-0 text-muted-foreground/70", className)} />
}

/** The working spinner: it always turns (the owner's rule: working states animate). */
export function Spin({ size = 13, className }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} strokeWidth={2.25} aria-hidden className={cn("shrink-0 animate-spin-steps text-st-working", className)} />
}

const BADGE = "inline-flex h-[18px] shrink-0 items-center rounded-sm px-1.5 text-[11px] leading-none font-medium"

/** Right edge of a tool row: a spinner while it runs, a word when it did not go through, nothing when it did. */
export const ToolStatus = memo(function ToolStatus({ display, asks }: { display: ToolCall["display"]; asks?: boolean }) {
  switch (display) {
    case "running":
      return (
        <span title="Running" className="inline-flex size-4 shrink-0 items-center justify-center">
          <Spin />
        </span>
      )
    case "awaiting_permission":
      return <span className={cn(BADGE, asks ? "bg-st-input-tint text-st-input-fg" : "bg-st-perm-tint text-st-perm-fg")}>{asks ? "Waiting for you" : "Needs approval"}</span>
    case "failed":
      return <span className={cn(BADGE, "bg-st-error-tint text-st-error-fg")}>Failed</span>
    case "rejected":
      return <span className={cn(BADGE, "border border-border text-muted-foreground")}>Denied</span>
    case "cancelled":
      return <span className={cn(BADGE, "border border-border text-muted-foreground")}>Cancelled</span>
    default:
      return null
  }
})

export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      size={13}
      strokeWidth={2}
      aria-hidden
      className={cn("shrink-0 text-muted-foreground/70 transition-transform duration-150", open && "rotate-90", className)}
    />
  )
}

/** Small mono block for tool output. */
export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "overflow-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-xs leading-[18px] whitespace-pre text-muted-foreground select-text",
        className,
      )}
    >
      {children}
    </pre>
  )
}

/** Small sub-label above a block. */
export function MicroLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-1 text-xs font-medium text-muted-foreground", className)}>{children}</div>
}

// ---------- file paths ----------
/** The folder a session works in: paths in its chat are shown relative to it. */
export const useSessionCwd = (sessionId: ID) => useApp((s) => s.sessions[sessionId]?.cwd)

/**
 * Open a file named in the chat: a file this session changed opens in Review on that file; any other
 * file opens in its app on this computer (a session on another machine has nothing to open here).
 */
export function openChatFile(sessionId: ID, path: string, changed: boolean) {
  if (changed) {
    setActive(sessionId, `${sessionId}::${path}`)
    openReview(sessionId)
    return
  }
  if (IN_TAURI && !getApp().sessions[sessionId]?.machine)
    void import("@tauri-apps/plugin-opener").then((o) => o.openPath(path)).catch(() => undefined)
}

/** A file path in mono, relative to the session folder; a click opens it (see openChatFile). */
export const PathLink = memo(function PathLink({ sessionId, path, className }: { sessionId: ID; path: string; className?: string }) {
  const cwd = useSessionCwd(sessionId)
  const changed = useChangedFiles(sessionId).some((f) => f.path === path)
  const local = useApp((s) => IN_TAURI && !s.sessions[sessionId]?.machine)
  const shown = relPath(path, cwd)
  const slash = shown.lastIndexOf("/")
  const label = (
    <>
      {slash > 0 && <span className="text-muted-foreground/70">{shown.slice(0, slash + 1)}</span>}
      <span>{shown.slice(slash + 1)}</span>
    </>
  )
  if (!changed && !local)
    return (
      <span title={path} className={cn("min-w-0 truncate font-mono text-xs", className)}>
        {label}
      </span>
    )
  return (
    <button
      type="button"
      title={changed ? `Review ${path}` : `Open ${path}`}
      onClick={(e) => {
        e.stopPropagation()
        openChatFile(sessionId, path, changed)
      }}
      className={cn(
        "relative z-10 min-w-0 truncate rounded-sm text-left font-mono text-xs underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      {label}
    </button>
  )
})
