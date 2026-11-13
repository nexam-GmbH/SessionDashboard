// Session header (UI_PLAN §5.3, calm rules §2.5): one row — status glyph · title · muted
// repo — and on the right a compact "Opus" settings menu, naming effort and permission mode only when they differ from the defaults (model,
// effort, permission mode, plus context, cost and branch as details on demand),
// Interrupt only while working, Review only when there are changes, and a "⋯" menu
// for everything else. Layout ideas from Cline session-status.tsx and the Vibe Kanban
// session header (no code copied). Settings are disabled (never hidden) when the
// control mode can't change them.
import { memo, useEffect, useRef, useState, type ReactNode } from "react"
import { RewindDialog } from "./RewindDialog"
import {
  Archive,
  ChevronDown,
  Copy,
  Ellipsis,
  FileDiff,
  GitFork,
  History,
  Pencil,
  PictureInPicture2,
  Square,
  SquareTerminal,
} from "lucide-react"
import type { Effort, ID, PermissionMode, Session } from "@/lib/model"
import { useApp } from "@/store/app"
import { forkSession, openRepo, openReview, renameSession, setBottomTab, setSessionSettings } from "@/store/actions"
import { openPopout } from "@/app/popout"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PERMISSION_MODE_LABEL, STATUS_LABEL, capabilities } from "@/lib/status"
import { compact, homePath, plural, usd } from "@/lib/format"
import { cn } from "@/lib/utils"
import { interruptSession, useChangedFiles, useDelegatedCount } from "../sessionStore"
import { archiveWithUndo } from "@/features/notifications/undo"

export const MODELS = [
  { value: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5" },
  { value: "claude-fable-5-2", label: "Fable 5.2" },
]
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"]
const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]

export function modelLabel(model: string) {
  return MODELS.find((m) => m.value === model)?.label ?? model
}

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
        className="h-6 min-w-[200px] flex-1 rounded-[3px] border border-brand/60 bg-elevated px-1.5 text-[13px] font-medium text-fg outline-none"
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
      className="-mx-1 min-w-0 truncate rounded-[3px] px-1 text-left text-[13px] font-medium text-fg hover:bg-hover"
    >
      {session.title}
    </button>
  )
}

// ---------- settings: "Opus · high · default" ----------
function SettingSub<T extends string>({
  label,
  value,
  display,
  options,
  disabled,
  onChange,
  render,
}: {
  label: string
  value: T
  display: string
  options: readonly T[]
  disabled: boolean
  onChange: (v: T) => void
  render: (v: T) => string
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled} className="text-[12px] data-disabled:opacity-50 [&>svg]:size-3 [&>svg]:text-fg-faint">
        <span className="flex-1 text-fg-muted">{label}</span>
        <span className="text-fg">{display}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-40">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o} value={o} className="text-[12px]">
              {render(o)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-2 px-1.5 text-[12px]">
      <span className="w-14 shrink-0 text-fg-muted">{label}</span>
      <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-fg">{children}</span>
    </div>
  )
}

const SettingsMenu = memo(function SettingsMenu({ session: s, branch }: { session: Session; branch?: string }) {
  const lock = !capabilities(s.control).changeSettings
  const pct = s.usage.contextPct
  const ctxTone = pct >= 90 ? "bg-st-error" : pct >= 75 ? "bg-st-input" : "bg-fg-faint"
  const short = modelLabel(s.model).split(" ")[0]
  const defaultEffort = useApp((st) => st.settings.defaults.effort)
  // calm rule: the trigger names the model and only the settings that differ from the defaults
  const extras = [s.effort !== defaultEffort && s.effort, s.permissionMode !== "default" && PERMISSION_MODE_LABEL[s.permissionMode].toLowerCase()].filter(Boolean)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Model, effort, permissions"
          className="inline-flex h-6 min-w-0 items-center gap-1 rounded-[3px] px-1.5 text-[12px] text-fg-muted hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg"
        >
          <span className="truncate">
            {[short, ...extras].join(" · ")}
          </span>
          {pct >= 80 && <span className={cn("tabular shrink-0", pct >= 90 ? "text-st-input-fg" : "text-fg-faint")}>· {pct}%</span>}
          <ChevronDown size={11} className="shrink-0 text-fg-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <SettingSub
          label="Model"
          value={s.model}
          display={modelLabel(s.model)}
          options={MODELS.map((m) => m.value)}
          render={modelLabel}
          disabled={lock}
          onChange={(model) => setSessionSettings(s.id, { model })}
        />
        <SettingSub
          label="Effort"
          value={s.effort}
          display={s.effort}
          options={EFFORTS}
          render={(e) => e}
          disabled={lock}
          onChange={(effort) => setSessionSettings(s.id, { effort })}
        />
        <SettingSub
          label="Mode"
          value={s.permissionMode}
          display={PERMISSION_MODE_LABEL[s.permissionMode]}
          options={MODES}
          render={(m) => PERMISSION_MODE_LABEL[m]}
          disabled={lock}
          onChange={(permissionMode) => setSessionSettings(s.id, { permissionMode })}
        />
        {lock && <div className="px-1.5 pb-1 text-[11px] text-fg-faint">Locked: {s.control === "history" ? "not running" : "runs in your terminal"}</div>}
        <DropdownMenuSeparator />
        <InfoRow label="Context">
          <span className="relative h-1.5 w-20 overflow-hidden rounded-[2px] bg-hover">
            <span className={cn("absolute inset-y-0 left-0", ctxTone)} style={{ width: `${Math.min(100, pct)}%` }} />
          </span>
          <span className="tabular w-8 text-right">{pct}%</span>
        </InfoRow>
        <InfoRow label="Cost">
          <span className="tabular text-fg-faint">
            {compact(s.usage.inputTokens)} in · {compact(s.usage.outputTokens)} out
          </span>
          <span className="tabular">{usd(s.usage.costUsd)}</span>
        </InfoRow>
        {branch && (
          <InfoRow label="Branch">
            <span className="truncate font-mono text-[11px] text-fg-muted" title={homePath(s.cwd)}>
              {branch}
            </span>
          </InfoRow>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

// ---------- header ----------
export const SessionHeader = memo(function SessionHeader({ sessionId, popout }: { sessionId: ID; popout?: boolean }) {
  const s = useApp((st) => st.sessions[sessionId])
  const repo = useApp((st) => (s?.repoId ? st.repos[s.repoId] : undefined))
  const files = useChangedFiles(sessionId)
  // the main agent has no edits of its own; its Review is the combined review of its delegated sessions
  const delegated = useDelegatedCount(sessionId)
  const [editing, setEditing] = useState(false)
  // "Rename" from the menu: start editing once the menu has closed and returned focus.
  const renameNext = useRef(false)
  const rewindNext = useRef(false)
  const [rewindOpen, setRewindOpen] = useState(false)
  // Esc Esc in an empty composer and the palette open Rewind for this session
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<ID>).detail === sessionId) setRewindOpen(true)
    }
    window.addEventListener("sd:rewind", on)
    return () => window.removeEventListener("sd:rewind", on)
  }, [sessionId])
  if (!s) return null
  const worktree = repo?.worktrees.find((w) => w.id === s.worktreeId)
  const branch = worktree?.branch ?? repo?.defaultBranch
  const caps = capabilities(s.control)
  const running = s.status === "working" || s.status === "starting"
  const changed = files.length || s.diff.filesChanged
  const added = files.length ? files.reduce((a, f) => a + f.added, 0) : s.diff.linesAdded
  const removed = files.length ? files.reduce((a, f) => a + f.removed, 0) : s.diff.linesRemoved
  return (
    <div className="flex h-10 shrink-0 min-w-0 items-center gap-2 border-b border-line-subtle bg-chrome pr-2 pl-3">
      <StatusGlyph status={s.status} size="md" title={s.activity ? `${STATUS_LABEL[s.status]}: ${s.activity}` : undefined} />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <Title session={s} editing={editing} setEditing={setEditing} />
        {!editing &&
          (repo ? (
            <button
              type="button"
              onClick={() => openRepo(repo.id)}
              title={branch ? `${branch} · ${homePath(s.cwd)}` : homePath(s.cwd)}
              className="shrink-0 text-[12px] text-fg-faint hover:text-fg-muted"
            >
              {repo.name}
            </button>
          ) : (
            <span className="shrink-0 text-[12px] text-fg-faint">main agent</span>
          ))}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <SettingsMenu session={s} branch={branch} />
        {running && caps.interrupt && (
          <Hint label="Interrupt · Esc in an empty composer">
            <Button size="sm" variant="ghost" onClick={() => interruptSession(sessionId)}>
              <Square className="size-2.5 fill-current" /> Interrupt
            </Button>
          </Hint>
        )}
        {(changed > 0 || delegated > 0) && (
          <Hint label={changed > 0 ? `${plural(changed, "file")} · +${added} −${removed}` : `Changes across ${plural(delegated, "delegated session")}`}>
            <Button size="sm" variant="ghost" onClick={() => openReview(sessionId)}>
              <FileDiff /> Review
            </Button>
          </Hint>
        )}
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
                setRewindOpen(true)
                return
              }
              if (!renameNext.current) return
              renameNext.current = false
              e.preventDefault()
              setEditing(true)
            }}
          >
            <DropdownMenuItem className="text-[12px]" onSelect={() => forkSession(sessionId)}>
              <GitFork /> Fork
            </DropdownMenuItem>
            {!popout && (
              <DropdownMenuItem className="text-[12px]" onSelect={() => void openPopout(`/session/${sessionId}`)}>
                <PictureInPicture2 /> Pop out
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="text-[12px]" onSelect={() => (renameNext.current = true)}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem className="text-[12px]" disabled={!caps.changeSettings} onSelect={() => (rewindNext.current = true)}>
              <History /> Rewind…
              <DropdownMenuShortcut>Esc Esc</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-[12px]" onSelect={() => setBottomTab("terminal")}>
              <SquareTerminal /> Open in terminal
            </DropdownMenuItem>
            <DropdownMenuItem className="text-[12px]" onSelect={() => void navigator.clipboard?.writeText(resumeCommand(s))}>
              <Copy /> Copy resume command
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-[12px]" disabled={s.role === "main"} onSelect={() => archiveWithUndo([sessionId])}>
              <Archive /> Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <RewindDialog sessionId={sessionId} open={rewindOpen} onOpenChange={setRewindOpen} />
    </div>
  )
})
