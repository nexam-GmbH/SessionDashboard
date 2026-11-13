// Node actions shared by the selected-card NodeToolbar and the right-click menu — UI_PLAN §5.1
// "Toolbar: Open · Reply · Approve/Deny (if waiting) · Interrupt · Fork · Archive". Only *once*
// approvals are offered on the map (§12.6). Calm UI (§2.5 rule 3): the toolbar appears on
// selection only and does not repeat the Allow once / Deny / Answer buttons a waiting card
// already shows inline; the context menu keeps every action.
import { memo, type ReactNode } from "react"
import {
  Archive,
  ArrowUpRight,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FolderGit2,
  FolderOpen,
  GitFork,
  Network,
  MessageSquareReply,
  Play,
  Plus,
  Square,
  Waypoints,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu"
import { useApp, getApp } from "@/store/app"
import {
  archiveSession,
  forkSession,
  openCrossRepo,
  openNewSession,
  openRepo,
  openSession,
  patchMap,
  resumeSession,
  select,
  toggleRepoCollapsed,
  toggleStack,
  toggleSubagents,
} from "@/store/actions"
import { capabilities } from "@/lib/status"
import { isTauri } from "@/lib/tauri"
import type { ID, PermissionOption, PermissionRequest, Session } from "@/lib/model"
import { interruptSession, resolveRequest } from "@/features/session-view/sessionStore"

export type MapTarget = { type: "session" | "repo" | "subagent" | "stack" | "main"; id: ID }

interface Action {
  id: string
  label: string
  icon: ReactNode
  run: () => void
  primary?: boolean
  /** status tone: perm (orange) for a permission, input (amber) for a question or plan */
  tone?: "perm" | "input"
  shortcut?: string
}

function onceOptions(s: Session): { allow?: PermissionOption; deny?: PermissionOption; req?: PermissionRequest } {
  const st = getApp()
  const rid = s.waitingFor?.requestId
  const req = rid ? st.requests[rid] : undefined
  if (!req || req.type !== "permission" || req.state !== "pending") return {}
  return {
    allow: req.options.find((o) => o.kind === "allow_once"),
    deny: req.options.find((o) => o.kind === "reject_once"),
    req,
  }
}

function sessionActions(s: Session): Action[] {
  const caps = capabilities(s.control)
  const out: Action[] = [{ id: "open", label: "Open", icon: <ArrowUpRight />, run: () => openSession(s.id), primary: true, shortcut: "Enter" }]
  if (s.status === "waiting_permission" && caps.approve) {
    // resolveRequest (not the bare store action) so the transcript's awaiting tool row resolves too
    const { allow, deny, req } = onceOptions(s)
    if (allow && deny && req) {
      out.push({ id: "allow", label: "Allow once", icon: <Check />, run: () => resolveRequest(req, allow.id), tone: "perm" })
      out.push({ id: "deny", label: "Deny", icon: <X />, run: () => resolveRequest(req, deny.id) })
    }
  }
  if (s.status === "waiting_input") out.push({ id: "answer", label: s.waitingFor?.kind === "plan" ? "Review plan" : "Answer", icon: <MessageSquareReply />, run: () => openSession(s.id), tone: "input" })
  else if (caps.send) out.push({ id: "reply", label: "Reply", icon: <MessageSquareReply />, run: () => openSession(s.id) })
  if (caps.interrupt && (s.status === "working" || s.status === "starting"))
    out.push({ id: "interrupt", label: "Interrupt", icon: <Square className="size-4 fill-current p-[3px]" />, run: () => interruptSession(s.id) })
  if (caps.resume) out.push({ id: "resume", label: "Resume", icon: <Play />, run: () => resumeSession(s.id) })
  if (s.role === "main") out.push({ id: "cross", label: "Cross-repo task", icon: <Network />, run: () => openCrossRepo() })
  out.push({ id: "fork", label: "Fork", icon: <GitFork />, run: () => forkSession(s.id) })
  if (s.role !== "main") out.push({ id: "archive", label: "Archive", icon: <Archive />, run: () => archiveSession(s.id) })
  return out
}

/** Answers the card already shows inline; the floating toolbar does not repeat them. */
const INLINE_ON_CARD = new Set(["allow", "deny", "answer"])

/** Open the repo folder in the OS file manager (Tauri); in the browser, copy the path instead. */
export function openFolder(path: string) {
  if (isTauri()) void import("@tauri-apps/plugin-opener").then((m) => m.openPath(path)).catch(() => undefined)
  else void navigator.clipboard?.writeText(path)
}

/** Floating toolbar above the selected card (React Flow NodeToolbar): Open + icon actions. */
export const SessionToolbar = memo(function SessionToolbar({ id }: { id: ID }) {
  const s = useApp((st) => st.sessions[id])
  const agents = useApp((st) => st.subagentIdsBySession[id]?.length ?? 0)
  const agentsOpen = useApp((st) => !!st.map.expandedSubagents[id])
  if (!s) return null
  const actions = sessionActions(s).filter((a) => !INLINE_ON_CARD.has(a.id))
  return (
    <div
      className="nodrag nopan flex items-center gap-0.5 rounded-md border border-line bg-elevated p-0.5 shadow-md"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {actions.map((a) =>
        a.primary ? (
          <Button key={a.id} size="xs" variant="secondary" onClick={a.run} title={a.shortcut ? `${a.label} (${a.shortcut})` : a.label}>
            {a.icon}
            {a.label}
          </Button>
        ) : (
          <Button key={a.id} size="icon-xs" variant="ghost" onClick={a.run} title={a.label} aria-label={a.label}>
            {a.icon}
          </Button>
        ),
      )}
      {agents > 0 && (
        <Button
          size="icon-xs"
          variant="ghost"
          data-active={agentsOpen}
          onClick={() => toggleSubagents(id)}
          title={`${agentsOpen ? "Hide" : "Show"} ${agents} subagent${agents > 1 ? "s" : ""} (Space)`}
          aria-label={agentsOpen ? "Hide subagents" : "Show subagents"}
        >
          <Waypoints />
        </Button>
      )}
    </div>
  )
})

/** Right-click menu content for whatever node was under the pointer. */
export function MapContextMenu({ target }: { target: MapTarget | null }) {
  if (!target) return null
  return (
    <ContextMenuContent className="min-w-48" onCloseAutoFocus={(e) => e.preventDefault()}>
      <MenuBody target={target} />
    </ContextMenuContent>
  )
}

function MenuBody({ target }: { target: MapTarget }) {
  const st = getApp()
  if (target.type === "session" || target.type === "main") {
    const s = st.sessions[target.id]
    if (!s) return null
    const subs = st.subagentIdsBySession[s.id]?.length ?? 0
    return (
      <>
        <ContextMenuLabel className="max-w-64 truncate">{s.role === "main" ? "Main agent" : s.title}</ContextMenuLabel>
        {sessionActions(s).map((a, i) => (
          <MenuItem key={a.id} a={a} sepBefore={i > 0 && (a.id === "fork" || a.id === "archive")} />
        ))}
        {subs > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => toggleSubagents(s.id)}>
              <Waypoints />
              {st.map.expandedSubagents[s.id] ? "Hide subagents" : "Show subagents"}
              <ContextMenuShortcut>Space</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
      </>
    )
  }
  if (target.type === "repo") {
    const repo = st.repos[target.id]
    if (!repo) return null
    const collapsed = !!st.map.collapsedRepos[repo.id]
    return (
      <>
        <ContextMenuLabel>{repo.name}</ContextMenuLabel>
        <ContextMenuItem onSelect={() => openRepo(repo.id)}>
          <FolderGit2 /> Open repository <ContextMenuShortcut>Enter</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => openNewSession(repo.id)}>
          <Plus /> New session here
        </ContextMenuItem>
        {isTauri() && (
          <ContextMenuItem onSelect={() => openFolder(repo.rootPath)}>
            <FolderOpen /> Open folder
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => toggleRepoCollapsed(repo.id)}>
          {collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />} {collapsed ? "Expand" : "Collapse"}
          <ContextMenuShortcut>Space</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => select({ kind: "repo", id: repo.id })}>
          <Waypoints /> Show this repo's links
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => patchMap({ showLinks: !st.map.showLinks })}>
          <Waypoints /> {st.map.showLinks ? "Hide all repo links" : "Show all repo links"}
          <ContextMenuShortcut>L</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(repo.rootPath)}>
          <Copy /> Copy path
        </ContextMenuItem>
      </>
    )
  }
  if (target.type === "stack") {
    const open = !!st.map.expandedStacks[target.id]
    return (
      <ContextMenuItem onSelect={() => toggleStack(target.id)}>
        {open ? <ChevronsDownUp /> : <ChevronsUpDown />} {open ? "Collapse idle sessions" : "Expand idle sessions"}
        <ContextMenuShortcut>Space</ContextMenuShortcut>
      </ContextMenuItem>
    )
  }
  const sub = st.subagents[target.id]
  if (!sub) return null
  return (
    <>
      <ContextMenuLabel className="max-w-64 truncate">{sub.agentType} · {sub.description}</ContextMenuLabel>
      <ContextMenuItem onSelect={() => openSession(sub.sessionId)}>
        <ArrowUpRight /> Open parent session <ContextMenuShortcut>Enter</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => select({ kind: "session", id: sub.sessionId })}>
        <Waypoints /> Select parent
      </ContextMenuItem>
    </>
  )
}

function MenuItem({ a, sepBefore }: { a: Action; sepBefore?: boolean }) {
  return (
    <>
      {sepBefore && <ContextMenuSeparator />}
      <ContextMenuItem onSelect={a.run} className={a.tone === "perm" ? "text-st-perm-fg" : a.tone === "input" ? "text-st-input-fg" : undefined}>
        {a.icon}
        {a.label}
        {a.shortcut && <ContextMenuShortcut>{a.shortcut}</ContextMenuShortcut>}
      </ContextMenuItem>
    </>
  )
}
