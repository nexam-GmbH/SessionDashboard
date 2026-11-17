// The session's part of the window header (app/SiteHeader): status glyph, title (click to rename),
// project and branch; on the right the changes as "+N −M" (opens Review) and a "⋯" menu (Rename,
// Fork, Rewind, Copy resume command, Archive). Model, effort, permission mode and Stop live in the prompt box, as in
// the Claude Code desktop app. Layout ideas from Cline session-status.tsx and the
// Vibe Kanban session header (no code copied).
import { memo, useEffect, useRef, useState, type ReactNode } from "react"
import { RewindDialog } from "./RewindDialog"
import { AppWindow, Archive, Copy, Ellipsis, FileDiff, GitBranch, GitFork, History, PanelRight, Pencil, Rows3 } from "lucide-react"
import { IN_TAURI } from "@/lib/platform"
import { POPOUT } from "@/backend/mode"
import type { ID, Session } from "@/lib/model"
import { useApp } from "@/store/app"
import { forkSession, openReview, renameSession } from "@/store/actions"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TRANSCRIPT_VIEWS, setTranscriptView } from "../transcript/view"
import type { TranscriptView } from "../transcript/rowModel"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { STATUS_LABEL, capabilities } from "@/lib/status"
import { homePath, plural } from "@/lib/format"
import { useChangedFiles, useDelegatedCount, useStopping } from "../sessionStore"
import { archiveWithUndo } from "@/features/notifications/undo"

/** Tooltip that also works on disabled controls (disabled buttons emit no pointer events). */
export function Hint({ label, children, side = "bottom" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" }) {
  if (!label) return <>{children}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={-1}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[280px]">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function resumeCommand(s: Session) {
  return `cd ${s.cwd} && claude --resume ${s.providerSessionIds.at(-1)}`
}

function Title({ session, editing, setEditing }: { session: Session; editing: boolean; setEditing: (v: boolean) => void }) {
  const [draft, setDraft] = useState(session.title)
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (draft.trim()) renameSession(session.id, draft.trim())
            setEditing(false)
          } else if (e.key === "Escape") setEditing(false)
        }}
        className="h-7 min-w-[200px] flex-1 rounded-md border border-input bg-transparent px-2 text-sm font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
    )
  }
  return (
    <button
      type="button"
      title={`${session.title} · click to rename`}
      onClick={() => {
        setDraft(session.title)
        setEditing(true)
      }}
      className="-mx-1.5 min-w-0 truncate rounded-md px-1.5 py-0.5 text-left text-sm font-medium text-foreground hover:bg-accent"
    >
      {session.title}
    </button>
  )
}

// ---------- header ----------
export const SessionHeader = memo(function SessionHeader({ sessionId }: { sessionId: ID }) {
  const s = useApp((st) => st.sessions[sessionId])
  const repo = useApp((st) => (s?.repoId ? st.repos[s.repoId] : undefined))
  const files = useChangedFiles(sessionId)
  const stopping = useStopping(sessionId) > 0
  // the main agent has no edits of its own; its Review is the combined review of its delegated sessions
  const delegated = useDelegatedCount(sessionId)
  const [editing, setEditing] = useState(false)
  // "Rename" from the menu: start editing once the menu has closed and returned focus.
  const renameNext = useRef(false)
  const rewindNext = useRef(false)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [rewindTurn, setRewindTurn] = useState<ID | undefined>(undefined)
  // Esc Esc in an empty composer and the palette open Rewind for this session
  useEffect(() => {
    const on = (e: Event) => {
      // detail: the session id (menu, palette, Esc Esc) or { sessionId, turnId } ("Rewind to here")
      const d = (e as CustomEvent<ID | { sessionId: ID; turnId: ID }>).detail
      const target = typeof d === "string" ? { sessionId: d, turnId: undefined } : d
      if (target.sessionId !== sessionId) return
      setRewindTurn(target.turnId)
      setRewindOpen(true)
    }
    window.addEventListener("sd:rewind", on)
    return () => window.removeEventListener("sd:rewind", on)
  }, [sessionId])
  if (!s) return null
  const worktree = repo?.worktrees.find((w) => w.id === s.worktreeId)
  const branch = worktree?.branch ?? repo?.defaultBranch
  const caps = capabilities(s.control)
  const changed = files.length || s.diff.filesChanged
  const added = files.length ? files.reduce((a, f) => a + f.added, 0) : s.diff.linesAdded
  const removed = files.length ? files.reduce((a, f) => a + f.removed, 0) : s.diff.linesRemoved
  return (
    <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
      <StatusGlyph status={s.status} size="md" animate title={stopping ? "Claude is stopping" : s.activity ? `${STATUS_LABEL[s.status]}: ${s.activity}` : undefined} />
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-baseline gap-2">
        <Title session={s} editing={editing} setEditing={setEditing} />
        {!editing && (
          <span className="flex min-w-0 shrink items-center gap-1.5 text-xs text-muted-foreground/70" title={homePath(s.cwd)}>
            <span className="shrink-0">
              {s.machine && s.machine !== "cloud" && <span className="text-muted-foreground/70">{s.machine}: </span>}
              {repo ? repo.name : "main agent"}
            </span>
            {branch && repo && (
              <>
                <GitBranch size={11} className="shrink-0" />
                <span className="truncate font-mono text-xs">{branch}</span>
              </>
            )}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* model, effort, permission mode and Stop live in the prompt box (Claude Code desktop) */}
        {(changed > 0 || delegated > 0) && (
          <Hint label={changed > 0 ? `Review ${plural(changed, "changed file")}` : `Changes across ${plural(delegated, "delegated session")}`}>
            <Button size="sm" variant="ghost" onClick={() => openReview(sessionId)} aria-label="Review changes">
              <FileDiff />
              {changed > 0 ? (
                <span className="tabular font-mono text-xs">
                  <span className="text-diff-add">+{added}</span> <span className="text-diff-del">−{removed}</span>
                </span>
              ) : (
                "Review"
              )}
            </Button>
          </Hint>
        )}
        <DetailsToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="More actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-52"
            onCloseAutoFocus={(e) => {
              if (rewindNext.current) {
                rewindNext.current = false
                e.preventDefault()
                setRewindTurn(undefined)
                setRewindOpen(true)
                return
              }
              if (!renameNext.current) return
              renameNext.current = false
              e.preventDefault()
              setEditing(true)
            }}
          >
            <DropdownMenuItem onSelect={() => forkSession(sessionId)}>
              <GitFork /> Fork
            </DropdownMenuItem>
            {IN_TAURI && !POPOUT && (
              <DropdownMenuItem onSelect={() => void import("@/app/popout").then((p) => p.openSessionWindow(sessionId))}>
                <AppWindow /> Open in new window
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => (renameNext.current = true)}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!caps.changeSettings} onSelect={() => (rewindNext.current = true)}>
              <History /> Rewind…
              <DropdownMenuShortcut>Esc Esc</DropdownMenuShortcut>
            </DropdownMenuItem>
            <TranscriptViewMenu />
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(resumeCommand(s))}>
              <Copy /> Copy resume command
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={s.role === "main"} onSelect={() => archiveWithUndo([sessionId])}>
              <Archive /> Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <RewindDialog sessionId={sessionId} open={rewindOpen} onOpenChange={setRewindOpen} turnId={rewindTurn} />
    </div>
  )
})

/** Transcript view (Claude Code desktop): how much of the work the chat shows; Ctrl+O cycles. */
function TranscriptViewMenu() {
  const view = useApp((s) => s.settings.transcriptView ?? "normal")
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Rows3 /> Transcript view
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <DropdownMenuRadioGroup value={view} onValueChange={(v) => setTranscriptView(v as TranscriptView)}>
          {TRANSCRIPT_VIEWS.map((v) => (
            <DropdownMenuRadioItem key={v.id} value={v.id} className="flex-col items-start gap-0">
              <span>{v.label}</span>
              <span className="text-xs text-muted-foreground">{v.hint}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center justify-between text-xs font-normal text-muted-foreground">
          Cycle the views <DropdownMenuShortcut>Ctrl+O</DropdownMenuShortcut>
        </DropdownMenuLabel>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Show or hide the session rail beside the chat (environment, context, changes, checks). */
function DetailsToggle() {
  const open = useApp((s) => s.settings.detailsOpen)
  return (
    <Hint label={`${open ? "Hide session rail" : "Show session rail"} · Ctrl+.`}>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Session details"
        aria-pressed={open}
        className={open ? "bg-muted text-foreground" : undefined}
        onClick={() => useApp.setState((s) => ({ settings: { ...s.settings, detailsOpen: !s.settings.detailsOpen } }))}
      >
        <PanelRight />
      </Button>
    </Hint>
  )
}
