// Small shared pieces of the chat: a tool's icon and status, the disclosure chevron, clickable file
// paths and the mono output block. Status idea from BloopAI/vibe-kanban@5f06193:
// packages/ui/src/components/ToolStatusDot.tsx (Apache-2.0); here a finished call shows nothing,
// and failed / denied / waiting a word in its tone (Claude Code desktop; never color alone).
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
  return <Icon size={16} strokeWidth={1.75} aria-hidden className={cn("shrink-0 text-cc-fg3", className)} />
}

/** After a step that did not simply work: a word in its tone (danger for failed and denied). */
export const ToolStatus = memo(function ToolStatus({ display, asks }: { display: ToolCall["display"]; asks?: boolean }) {
  const word = { awaiting_permission: asks ? "Waiting for you" : "Needs approval", failed: "Failed", rejected: "Denied", cancelled: "Stopped" }[display as string]
  if (!word) return null
  return <span className={cn("shrink-0", display === "failed" || display === "rejected" ? "text-cc-danger" : "text-cc-fg2")}>{word}</span>
})

/** The caret after a step's label: right, turning down while open. */
export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return <ChevronRight size={14} strokeWidth={2} aria-hidden className={cn("shrink-0 text-cc-fg3 transition-transform duration-200", open && "rotate-90", className)} />
}

/** Mono block for tool output: the code wash, 13/19 code type. */
export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre className={cn("overflow-auto rounded-lg bg-cc-wash px-3 py-2 font-mono text-[13px] leading-[19px] whitespace-pre text-cc-fg2 select-text", className)}>{children}</pre>
  )
}

/** Small sub-label above a block ("Input", "Output"). */
export function MicroLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-1 text-sm text-cc-fg3", className)}>{children}</div>
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
      {slash > 0 && <span className="text-cc-fg2">{shown.slice(0, slash + 1)}</span>}
      <span>{shown.slice(slash + 1)}</span>
    </>
  )
  if (!changed && !local)
    return (
      <span title={path} className={cn("min-w-0 truncate", className)}>
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
        "relative z-10 min-w-0 truncate rounded-sm text-left decoration-transparent underline-offset-[3px] outline-none transition-colors duration-[60ms] hover:underline hover:decoration-current/40 focus-visible:ring-1 focus-visible:ring-cc-accent",
        className,
      )}
    >
      {label}
    </button>
  )
})
