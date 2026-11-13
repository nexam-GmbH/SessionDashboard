// Inspector — UI_PLAN §4.4 + Calm UI rules (§2.5): header, what it needs from you, one primary
// action (rest in a menu), key facts; everything else in a collapsed "Details" section.
// Layout after Orca right-sidebar (MIT) and Trigger.dev PropertyTable/InfoPanel (Apache-2.0).
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react"
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Bot,
  ChevronRight,
  Copy,
  FolderGit2,
  FileDiff,
  GitFork,
  MessageSquareReply,
  MoreHorizontal,
  PictureInPicture2,
  Play,
  Plus,
  Square,
  Waypoints,
  X,
} from "lucide-react"
import { getApp, useApp } from "@/store/app"
import { useRepoRollup, subagentAsStatus, useAttention, EMPTY } from "@/store/selectors"
import {
  forkSession,
  openGraph,
  openNewSession,
  openRepo,
  openReview,
  openSession,
  resumeSession,
  select,
  togglePanel,
} from "@/store/actions"
import { openPopout } from "@/app/popout"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { DiffStat, EmptyState, GitChips, Prop, PropertyTable } from "@/components/common/bits"
import { RelativeTime, useNow } from "@/components/common/RelativeTime"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { RequestInline } from "@/features/requests/RequestInline"
import { interruptSession, useDelegatedCount } from "@/features/session-view/sessionStore"
import { compact, dateTime, homePath, usd, plural } from "@/lib/format"
import { CONTROL_LABEL, PERMISSION_MODE_LABEL, STATUS_LABEL, capabilities, isWaiting, modelShort } from "@/lib/status"
import type { ID } from "@/lib/model"
import { cn } from "@/lib/utils"
import { archiveWithUndo, restoreWithUndo } from "@/features/notifications/undo"

// Session panels exported by the session view (ChangesPanel, AgentsPanel), loaded lazily.
const panelModules = import.meta.glob("../session-view/panels/*.tsx")
function panel(name: "ChangesPanel" | "AgentsPanel") {
  const loader = panelModules[`../session-view/panels/${name}.tsx`]
  if (!loader) return null
  return lazy(async () => {
    const mod = (await loader()) as Record<string, ComponentType<{ sessionId: string }>>
    return { default: mod[name] ?? mod.default }
  })
}
const ChangesPanel = panel("ChangesPanel")
const AgentsPanel = panel("AgentsPanel")

export function Inspector() {
  const sel = useApp((s) => s.selection)
  const open = useApp((s) => s.panels.inspector)
  // The inspector follows the selection (Calm UI rule 7): it opened because something was
  // selected, so it closes when the selection goes away (Esc on the map, the selected session
  // archived) instead of falling back to an "Overview" that repeats the sidebar. Opened on purpose
  // with nothing selected (Ctrl+Alt+B), it still shows the overview.
  const hadSelection = useRef(sel !== null)
  useEffect(() => {
    if (hadSelection.current && sel === null && getApp().panels.inspector) togglePanel("inspector", false)
    hadSelection.current = sel !== null
  }, [sel])
  // Esc closes the inspector (not while typing, not over dialogs/menus, not in a session tab where Esc interrupts)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
      if (document.querySelector("[role=dialog], [role=menu]")) return
      if (getApp().activeTab.startsWith("/session/")) return
      togglePanel("inspector", false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-[var(--tab-h)] shrink-0 items-center border-b border-line-subtle pr-1.5 pl-3">
        <span className="section-label">
          {sel?.kind === "session" ? "Session" : sel?.kind === "repo" ? "Repository" : sel?.kind === "subagent" ? "Subagent" : "Overview"}
        </span>
        <button
          className="ml-auto flex size-6 items-center justify-center rounded-sm text-fg-faint hover:bg-hover hover:text-fg"
          onClick={() => togglePanel("inspector", false)}
          title="Close (Esc)"
          aria-label="Close inspector"
        >
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sel?.kind === "session" ? (
          <SessionTabs key={sel.id} id={sel.id} />
        ) : sel?.kind === "repo" ? (
          <RepoInspector id={sel.id} />
        ) : sel?.kind === "subagent" ? (
          <SubagentInspector id={sel.id} />
        ) : (
          <Overview />
        )}
      </div>
    </div>
  )
}

function SessionTabs({ id }: { id: ID }) {
  const [tab, setTab] = useState<"info" | "changes" | "agents">("info")
  const subs = useApp((s) => (s.subagentIdsBySession[id] ?? EMPTY).length)
  const tabs = [
    { id: "info" as const, label: "Info" },
    ...(ChangesPanel ? [{ id: "changes" as const, label: "Changes" }] : []),
    ...(AgentsPanel && subs ? [{ id: "agents" as const, label: `Subagents ${subs}` }] : []),
  ]
  return (
    <div className="flex min-h-full flex-col">
      {tabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Session details"
          className="sticky top-0 z-10 flex h-8 shrink-0 items-stretch gap-4 border-b border-line-subtle bg-chrome px-3"
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
            const i = tabs.findIndex((t) => t.id === tab)
            const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]
            setTab(next.id)
            ;(e.currentTarget.querySelector(`[data-tab="${next.id}"]`) as HTMLElement | null)?.focus()
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              data-tab={t.id}
              role="tab"
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={cn(
                "relative text-xs transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                tab === t.id ? "text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-brand" : "text-fg-faint hover:text-fg-muted",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <Suspense fallback={null}>
        {tab === "changes" && ChangesPanel ? (
          <ChangesPanel sessionId={id} />
        ) : tab === "agents" && AgentsPanel ? (
          <AgentsPanel sessionId={id} />
        ) : (
          <SessionInspector id={id} />
        )}
      </Suspense>
    </div>
  )
}

/** Collapsible "Details" block; closed by default (details on demand). */
function Details({ children, label = "Details" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="border-b border-line-subtle">
      <button className="flex h-8 w-full items-center gap-1 px-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight size={12} className={cn("text-fg-faint transition-transform", open && "rotate-90")} />
        <span className="section-label">{label}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  )
}

function CopyButton({ text }: { text: string }) {
  return (
    <button
      className="ml-1 inline-flex size-4 items-center justify-center rounded-sm text-fg-faint hover:bg-hover hover:text-fg"
      onClick={() => void navigator.clipboard?.writeText(text)}
      title="Copy"
    >
      <Copy size={10} />
    </button>
  )
}

const SessionInspector = memo(function SessionInspector({ id }: { id: ID }) {
  const s = useApp((st) => st.sessions[id])
  const repo = useApp((st) => (s?.repoId ? st.repos[s.repoId] : undefined))
  const worktree = repo?.worktrees.find((w) => w.id === s?.worktreeId)
  const parent = useApp((st) => (s?.parent ? st.sessions[s.parent.sessionId] : undefined))
  const delegated = useDelegatedCount(id)
  if (!s) return <EmptyState>Session not found.</EmptyState>
  return (
    <div>
      <div className="border-b border-line-subtle px-3 py-3">
        <div className="flex items-start gap-2">
          <StatusGlyph status={s.status} size="md" className="mt-px" />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[13px] leading-snug font-medium text-fg">{s.title}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-faint">
              <span>{STATUS_LABEL[s.status]}</span>
              <span>·</span>
              <RelativeTime iso={s.statusObservedAt} />
            </div>
          </div>
        </div>
        {isWaiting(s.status) && <RequestInline sessionId={id} className="mt-2.5" />}
        {s.status === "error" && s.errorMessage && (
          <div className="mt-2.5 rounded-md border border-st-error/35 bg-st-error-tint px-2 py-1.5 text-xs text-st-error-fg">{s.errorMessage}</div>
        )}
        {s.activity && s.status === "working" && (
          <div className="mt-2 truncate text-xs text-fg-muted" title={s.activity}>
            {s.activity}
          </div>
        )}
        <SessionActions id={id} />
      </div>

      <section className="border-b border-line-subtle px-3 py-3">
        <PropertyTable>
          <Prop label="Repo">
            {repo ? (
              <button className="text-fg hover:underline" onClick={() => select({ kind: "repo", id: repo.id })}>
                {repo.name}
              </button>
            ) : (
              <span className="text-fg">{plural(s.additionalDirs.length, "repo")}</span>
            )}
          </Prop>
          {worktree && (
            <Prop label="Branch" mono>
              {worktree.branch}
            </Prop>
          )}
          <Prop label="Changes">
            {s.diff.filesChanged ? (
              <span className="flex items-center gap-2">
                <span className="text-fg-muted">{plural(s.diff.filesChanged, "file")}</span>
                <DiffStat added={s.diff.linesAdded} removed={s.diff.linesRemoved} />
              </span>
            ) : delegated > 0 ? (
              <button className="text-fg hover:underline" onClick={() => openReview(id)} title="Combined review">
                {plural(delegated, "delegated session")}
              </button>
            ) : (
              <span className="text-fg-faint">none</span>
            )}
          </Prop>
          {parent && (
            <Prop label={s.parent?.kind === "forked" ? "Forked from" : s.parent?.kind === "delegated" ? "From" : "Parent"}>
              <button className="text-fg hover:underline" onClick={() => select({ kind: "session", id: parent.id })}>
                {parent.role === "main" ? "Main agent" : parent.title}
              </button>
            </Prop>
          )}
        </PropertyTable>
      </section>

      <Details>
        <PropertyTable>
          <Prop label="Model">
            {modelShort(s.model)} · {s.effort}
          </Prop>
          <Prop label="Permissions">{PERMISSION_MODE_LABEL[s.permissionMode]}</Prop>
          {s.todo && (
            <Prop label="Plan">
              <span className="tabular">
                {s.todo.done}/{s.todo.total} steps
              </span>
            </Prop>
          )}
          <Prop label="Control">
            <span title={CONTROL_LABEL[s.control]}>{s.control}</span>
          </Prop>
          <Prop label="Context">
            <span className="tabular">{s.usage.contextPct}%</span>
          </Prop>
          <Prop label="Cost">
            <span className="tabular">
              {usd(s.usage.costUsd)} · {compact(s.usage.inputTokens + s.usage.outputTokens)} tokens
            </span>
          </Prop>
          {worktree?.git.pr && (
            <Prop label="PR">
              #{worktree.git.pr.number} · {worktree.git.pr.checks}
            </Prop>
          )}
          <Prop label="Created">{dateTime(s.createdAt)}</Prop>
          {s.archivedAt && <Prop label="Archived">{dateTime(s.archivedAt)}</Prop>}
          <Prop label="Session" mono>
            {s.providerSessionIds.at(-1)?.slice(0, 13)}…<CopyButton text={s.providerSessionIds.at(-1) ?? ""} />
          </Prop>
          <Prop label="Folder" mono>
            <span title={s.cwd}>{homePath(s.cwd)}</span>
          </Prop>
        </PropertyTable>
      </Details>
    </div>
  )
})

/**
 * One primary action per state (§2.5): Restore (archived) · Resume (history) · Answer / Review plan
 * (question, plan) · Open. Open is dropped while that session's tab is the one you're looking at,
 * Interrupt shows while it runs (same label as the session header), the rest is in "⋯" with the
 * same labels and order as the session header and map menus.
 */
function SessionActions({ id }: { id: ID }) {
  const s = useApp((st) => st.sessions[id])
  const viewing = useApp((st) => st.activeTab === `/session/${id}`)
  const delegated = useDelegatedCount(id)
  if (!s) return null
  const caps = capabilities(s.control)
  const running = (s.status === "working" || s.status === "starting") && caps.interrupt
  const asks = s.status === "waiting_input"
  const openLabel = asks ? (s.waitingFor?.kind === "plan" ? "Review plan" : "Answer") : "Open"
  const primary = s.archived ? "restore" : s.control === "history" ? "resume" : viewing ? null : "open"
  return (
    <div className="mt-3 flex items-center gap-1">
      {primary === "restore" && (
        <Button size="sm" variant="default" onClick={() => restoreWithUndo([id])}>
          <ArchiveRestore /> Restore
        </Button>
      )}
      {primary === "resume" && (
        <Button size="sm" variant="default" onClick={() => resumeSession(id)}>
          <Play /> Resume
        </Button>
      )}
      {primary === "open" ? (
        // a pending permission is answered right above (Allow once / Deny): Open is secondary then
        <Button size="sm" variant={s.status === "waiting_permission" ? "secondary" : "default"} onClick={() => openSession(id)}>
          {asks ? <MessageSquareReply /> : <ArrowUpRight />} {openLabel}
        </Button>
      ) : (
        primary !== null &&
        !viewing && (
          <Button size="sm" variant="ghost" onClick={() => openSession(id)}>
            Open
          </Button>
        )
      )}
      {running && (
        <Button size="sm" variant="ghost" onClick={() => interruptSession(id)} title="Interrupt">
          <Square className="size-2.5 fill-current" /> Interrupt
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="More actions" title="More">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          {(s.diff.filesChanged > 0 || delegated > 0) && (
            <DropdownMenuItem onSelect={() => openReview(id)}>
              <FileDiff /> Review changes
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => forkSession(id)}>
            <GitFork /> Fork
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void openPopout(`/session/${id}`)}>
            <PictureInPicture2 /> Pop out
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(`claude --resume ${s.providerSessionIds.at(-1)}`)}>
            <Copy /> Copy resume command
          </DropdownMenuItem>
          {s.role !== "main" && (
            <>
              <DropdownMenuSeparator />
              {s.archived ? (
                <DropdownMenuItem onSelect={() => restoreWithUndo([id])}>
                  <ArchiveRestore /> Restore
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => archiveWithUndo([id])}>
                  <Archive /> Archive
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

const RepoInspector = memo(function RepoInspector({ id }: { id: ID }) {
  const repo = useApp((s) => s.repos[id])
  const rollup = useRepoRollup(id)
  const links = useApp((s) => s.links)
  const repos = useApp((s) => s.repos)
  if (!repo) return <EmptyState>Repository not found.</EmptyState>
  const main = repo.worktrees.find((w) => w.isMain)!
  const myLinks = links.filter((l) => l.from === id || l.to === id)
  const attention = (rollup.waiting_permission ?? 0) + (rollup.waiting_input ?? 0) + (rollup.error ?? 0)
  return (
    <div>
      <div className="border-b border-line-subtle px-3 py-3">
        <div className="flex items-center gap-2">
          <FolderGit2 size={15} className="text-fg-faint" />
          <span className="text-[13px] font-medium">{repo.name}</span>
        </div>
        <div className="mt-1 text-xs text-fg-faint">
          {attention ? <span className="text-st-perm-fg">{attention} need you</span> : "Nothing needs you"} · {rollup.working ?? 0} working
        </div>
        <div className="mt-3 flex items-center gap-1">
          <Button size="sm" variant="default" onClick={() => openNewSession(id)}>
            <Plus /> New session
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openRepo(id)}>
            Open
          </Button>
          {repo.graphify?.state !== "none" && (
            <Button size="sm" variant="ghost" onClick={() => openGraph(id)}>
              <Waypoints /> Graph
            </Button>
          )}
        </div>
      </div>
      <section className="border-b border-line-subtle px-3 py-3">
        <PropertyTable>
          <Prop label="Branch" mono>
            {main.branch}
          </Prop>
          <Prop label="Status">
            <GitChips git={main.git} />
          </Prop>
        </PropertyTable>
      </section>
      {myLinks.length > 0 && (
        <section className="border-b border-line-subtle px-3 py-2.5">
          <div className="section-label mb-1.5">Linked</div>
          <div className="-mx-1 flex flex-col">
            {myLinks.map((l) => {
              const other = repos[l.from === id ? l.to : l.from]
              return (
                <button key={l.id} className="flex h-6 items-center gap-2 rounded-sm px-1 text-left text-xs hover:bg-hover" onClick={() => select({ kind: "repo", id: other.id })} title={l.label}>
                  <span className="text-fg-muted">{other.name}</span>
                  <span className="ml-auto text-[11px] text-fg-faint">{l.kind.replace("-", " ")}</span>
                </button>
              )
            })}
          </div>
        </section>
      )}
      <Details>
        <PropertyTable>
          <Prop label="Folder" mono>
            <span title={repo.rootPath}>{homePath(repo.rootPath)}</span>
          </Prop>
          <Prop label="Worktrees">{repo.worktrees.length - 1}</Prop>
          <Prop label="Graph">{repo.graphify?.state === "none" || !repo.graphify ? "none" : `${repo.graphify.state} · ${compact(repo.graphify.nodes ?? 0)} nodes`}</Prop>
          <Prop label="Rules">{repo.sharedRuleFiles.length} files</Prop>
        </PropertyTable>
      </Details>
    </div>
  )
})

const SubagentInspector = memo(function SubagentInspector({ id }: { id: ID }) {
  const a = useApp((s) => s.subagents[id])
  const parent = useApp((s) => (a ? s.sessions[a.sessionId] : undefined))
  if (!a) return <EmptyState>Subagent not found.</EmptyState>
  return (
    <div>
      <div className="border-b border-line-subtle px-3 py-3">
        <div className="flex items-start gap-2">
          <Bot size={15} className="mt-px text-fg-faint" />
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{a.description}</div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-faint">
              <StatusGlyph status={subagentAsStatus(a)} size="xs" />
              <span>{a.agentType}</span>
              <span>· {a.toolCount} tools</span>
            </div>
          </div>
        </div>
        {a.summary && <div className="mt-2.5 rounded-md bg-elevated px-2 py-1.5 text-xs text-fg-muted">{a.summary}</div>}
        <div className="mt-3 flex gap-1">
          <Button size="sm" variant="default" onClick={() => parent && openSession(parent.id)}>
            <ArrowUpRight /> Open parent
          </Button>
        </div>
      </div>
      <Details>
        <PropertyTable>
          <Prop label="Parent">
            <button className="text-fg hover:underline" onClick={() => parent && select({ kind: "session", id: parent.id })}>
              {parent?.title}
            </button>
          </Prop>
          <Prop label="Last tool" mono>
            {a.lastTool}
          </Prop>
          <Prop label="Started">
            <RelativeTime iso={a.startedAt} /> ago
          </Prop>
          {a.finishedAt && <Prop label="Finished">{dateTime(a.finishedAt)}</Prop>}
          <Prop label="Background">{a.background ? "yes" : "no"}</Prop>
        </PropertyTable>
      </Details>
    </div>
  )
})

function Overview() {
  const attention = useAttention()
  const structVersion = useApp((s) => s.structVersion)
  const statusVersion = useApp((s) => s.statusVersion)
  const now = useNow()
  // spend is coarse: recompute on structure/status changes or every 15s, not on every tick
  const cost = useMemo(() => {
    let c = 0
    const all = getApp().sessions
    for (const id in all) {
      const x = all[id]
      if (!x.archived && x.control !== "history") c += x.usage.costUsd
    }
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structVersion, statusVersion, now])
  return (
    <div>
      <section className="border-b border-line-subtle px-3 py-3">
        <div className="section-label mb-2">Next up</div>
        {attention.length ? (
          <div className="-mx-1 flex flex-col">
            {attention.slice(0, 8).map((e) => (
              <AttentionMini key={`${e.kind}${e.id}`} sessionId={e.kind === "session" ? e.id : e.sessionId} />
            ))}
          </div>
        ) : (
          <div className="text-xs text-fg-faint">Nothing waiting.</div>
        )}
      </section>
      <div className="px-3 py-3 text-[11px] text-fg-faint">Live spend {usd(cost)}</div>
    </div>
  )
}

function AttentionMini({ sessionId }: { sessionId: ID }) {
  const s = useApp((st) => st.sessions[sessionId])
  if (!s) return null
  return (
    <button className="flex h-7 items-center gap-1.5 rounded-sm px-1 text-left text-xs hover:bg-hover" onClick={() => select({ kind: "session", id: sessionId })}>
      <StatusGlyph status={s.status} size="xs" />
      <span className="truncate text-fg-muted">{s.title}</span>
    </button>
  )
}
