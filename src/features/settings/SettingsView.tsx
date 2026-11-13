// Settings — UI_PLAN §5.11. Layout adapted from mountain-loop/yaak@6a34d0a:
// packages/ui/src/components/settings/{SettingsDialog,SettingRow}.tsx (MIT) — left section
// list, rows with title/description left and control right — and coollabsio/jean@1d53d3c:
// src/components/preferences/SettingsSection.tsx (Apache-2.0). Modified: our tokens/density,
// rendered as a tab instead of a dialog.
import { createContext, useContext, useId, useMemo, useState, type ComponentProps, type ReactNode } from "react"
import {
  Bell,
  Check,
  FolderGit2,
  Info,
  Keyboard,
  LayoutTemplate,
  Palette,
  Plus,
  Search,
  Terminal,
  Trash2,
  Waypoints,
} from "lucide-react"
import { useApp } from "@/store/app"
import { patchSettings, pushNotification, setLayoutPreset } from "@/store/actions"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Shortcut } from "@/components/common/bits"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { COMMANDS } from "@/features/palette/commands"
import { homePath, compact } from "@/lib/format"
import { IN_TAURI, OS } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { AddReposDialog } from "./AddReposDialog"
import { NOTICES } from "./notices"

type Page = "repos" | "claude" | "appearance" | "notifications" | "keys" | "graphify" | "layouts" | "about"

const PAGES: { id: Page; label: string; icon: typeof FolderGit2 }[] = [
  { id: "repos", label: "Repos", icon: FolderGit2 },
  { id: "claude", label: "Claude Code", icon: Terminal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "keys", label: "Keybindings", icon: Keyboard },
  { id: "graphify", label: "Graphify", icon: Waypoints },
  { id: "layouts", label: "Layouts", icon: LayoutTemplate },
  { id: "about", label: "About", icon: Info },
]

export default function SettingsView() {
  const [page, setPage] = useState<Page>("repos")
  return (
    <div className="flex h-full min-h-0 bg-canvas">
      <nav
        className="w-52 shrink-0 border-r border-line-subtle bg-chrome py-2"
        aria-label="Settings sections"
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
          e.preventDefault()
          const i = PAGES.findIndex((p) => p.id === page)
          const next = PAGES[(i + (e.key === "ArrowDown" ? 1 : PAGES.length - 1)) % PAGES.length]
          setPage(next.id)
          ;(e.currentTarget.querySelector(`[data-page="${next.id}"]`) as HTMLElement | null)?.focus()
        }}
      >
        <div className="section-label px-4 pb-2">Settings</div>
        {PAGES.map((p) => (
          <button
            key={p.id}
            data-page={p.id}
            aria-current={page === p.id ? "page" : undefined}
            onClick={() => setPage(p.id)}
            className={cn(
              "flex h-7 w-full items-center gap-2 px-4 text-left text-[12.5px] transition-colors",
              page === p.id ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
            )}
          >
            <p.icon size={14} className="text-fg-faint" />
            {p.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-8 py-6">
          {page === "repos" && <ReposPage />}
          {page === "claude" && <ClaudePage />}
          {page === "appearance" && <AppearancePage />}
          {page === "notifications" && <NotificationsPage />}
          {page === "keys" && <KeysPage />}
          {page === "graphify" && <GraphifyPage />}
          {page === "layouts" && <LayoutsPage />}
          {page === "about" && <AboutPage />}
        </div>
      </div>
    </div>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-sm bg-elevated px-1 py-px font-mono text-[11px] text-fg-muted">{children}</code>
}

/** Page heading. Long explanations live in the tooltip, not on screen (§2.5 copy budget). */
function PageTitle({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex h-7 items-center gap-3">
      <h2 className="text-base font-semibold text-fg" title={description}>
        {title}
      </h2>
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  )
}

function SettingsSection({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      {title && (
        <div className="border-b border-line-subtle pb-2">
          <span className="section-label" title={description}>
            {title}
          </span>
        </div>
      )}
      <div className="[&>*:last-child]:border-b-0">{children}</div>
    </section>
  )
}

/**
 * Yaak SettingRow: label left, control right. One line at rest; the explanation is a hover card
 * on the label (§2.5: no explanatory sentences on screen). `hint` = 1–3 words when it matters.
 */
/** Id of the enclosing SettingRow's title: its switch / select is named by it (aria-labelledby). */
const RowLabel = createContext<string | undefined>(undefined)

function SettingRow({ title, description, hint, children, disabled }: { title: ReactNode; description?: ReactNode; hint?: string; children: ReactNode; disabled?: boolean }) {
  const labelId = useId()
  return (
    <div className={cn("grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-line-subtle py-1.5", disabled && "opacity-50")}>
      <div className="flex min-w-0 items-center gap-2">
        {description ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span id={labelId} className="cursor-default text-[13px] text-fg decoration-line-strong decoration-dotted underline-offset-4 hover:underline">{title}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="max-w-80 text-xs leading-relaxed">
              {description}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span id={labelId} className="text-[13px] text-fg">{title}</span>
        )}
        {hint && <span className="text-[11px] text-fg-faint">{hint}</span>}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-2">
        <RowLabel.Provider value={labelId}>{children}</RowLabel.Provider>
      </div>
    </div>
  )
}

/** Switch named by its row's title. */
function RowSwitch(props: ComponentProps<typeof Switch>) {
  const labelledBy = useContext(RowLabel)
  return <Switch aria-labelledby={labelledBy} {...props} />
}

function SmallSelect<T extends string>({ value, onChange, options, width = "w-44" }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; width?: string }) {
  const labelledBy = useContext(RowLabel)
  const selfId = useId()
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      {/* name = row title + current value ("Density Compact") */}
      <SelectTrigger id={selfId} aria-labelledby={labelledBy ? `${labelledBy} ${selfId}` : undefined} size="sm" className={cn("h-7 text-xs", width)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------- pages ----------
function ReposPage() {
  const order = useApp((s) => s.repoOrder)
  const repos = useApp((s) => s.repos)
  const counts = useApp((s) => s.sessionIdsByRepo)
  const [adding, setAdding] = useState(false)
  return (
    <>
      <PageTitle
        title="Repos"
        description="Repos the dashboard tracks. Sessions are discovered from ~/.claude/projects by matching each session's cwd to these paths."
        actions={
          <Button size="sm" variant="default" onClick={() => setAdding(true)} title="Add a folder and import its repos">
            <Plus /> Add
          </Button>
        }
      />
      <div className="overflow-hidden rounded-md border border-line-subtle">
        {order.map((id) => {
          const r = repos[id]
          return (
            <div
              key={id}
              className="group flex h-8 items-center gap-3 border-b border-line-subtle px-3 last:border-0 hover:bg-hover/50"
              title={`${r.language} · ${counts[id]?.length ?? 0} sessions`}
            >
              <FolderGit2 size={14} className="shrink-0 text-fg-faint" />
              <span className="w-44 shrink-0 truncate text-[13px] text-fg">{r.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-faint">{homePath(r.rootPath)}</span>
              <button className="flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-faint opacity-0 outline-none group-hover:opacity-100 hover:bg-selected hover:text-fg focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring" title="Stop tracking (sessions are kept)" aria-label={`Stop tracking ${r.name}`}>
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
      </div>
      {adding && <AddReposDialog onClose={() => setAdding(false)} />}
    </>
  )
}

function ClaudePage() {
  const settings = useApp((s) => s.settings)
  const d = settings.defaults
  const setD = (patch: Partial<typeof d>) => patchSettings({ defaults: { ...d, ...patch } })
  return (
    <>
      <PageTitle title="Claude Code" description="Where sessions are read from and the defaults for new sessions." />
      <SettingsSection title="Installation">
        <SettingRow title="Binary" description="The real claude CLI is driven directly (stream-json or PTY), so subscription logins work.">
          <span className="font-mono text-xs text-fg-muted">claude · 2.1.330</span>
        </SettingRow>
        <SettingRow title="Config directory" description={<><Code>CLAUDE_CONFIG_DIR</Code>. Transcripts live in <Code>&lt;dir&gt;/projects/&lt;slug&gt;/&lt;session&gt;.jsonl</Code>.</>}>
          <span className="font-mono text-xs text-fg-muted">{settings.claudeConfigDir}</span>
        </SettingRow>
        <SettingRow title="Status source" description={<>Live status comes from <Code>claude agents --json</Code>, falling back to <Code>~/.claude/sessions/&lt;pid&gt;.json</Code> and global hooks.</>}>
          <span className="text-xs text-fg-muted">Connected</span>
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Defaults" description="Defaults for new sessions">
        <SettingRow title="Model">
          <SmallSelect value={d.model} onChange={(v) => setD({ model: v })} options={[{ value: "claude-opus-5-5", label: "Opus 5.5" }, { value: "claude-sonnet-5-5", label: "Sonnet 5.5" }, { value: "claude-haiku-5-5", label: "Haiku 5.5" }, { value: "claude-fable-5-2", label: "Fable 5.2" }]} />
        </SettingRow>
        <SettingRow title="Effort">
          <SmallSelect value={d.effort} onChange={(v) => setD({ effort: v })} options={(["low", "medium", "high", "xhigh", "max"] as const).map((v) => ({ value: v, label: v }))} />
        </SettingRow>
        <SettingRow title="Permissions" description="bypassPermissions is never used as a default.">
          <SmallSelect value={d.permissionMode} onChange={(v) => setD({ permissionMode: v })} options={[{ value: "default", label: "Default (ask)" }, { value: "acceptEdits", label: "Accept edits" }, { value: "plan", label: "Plan" }, { value: "auto", label: "Auto" }]} />
        </SettingRow>
        <SettingRow title="Worktree" description={<>Start new sessions in <Code>.claude/worktrees/&lt;name&gt;</Code> (<Code>claude --worktree</Code>).</>}>
          <RowSwitch checked={d.worktree} onCheckedChange={(v) => setD({ worktree: v })} />
        </SettingRow>
      </SettingsSection>
    </>
  )
}

function AppearancePage() {
  const s = useApp((st) => st.settings)
  return (
    <>
      <PageTitle title="Appearance" description="Dark only in this phase. Density applies to the sidebar, tables and lists." />
      <SettingsSection>
        <SettingRow title="Density">
          <SmallSelect value={s.density} onChange={(v) => patchSettings({ density: v })} options={[{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }]} />
        </SettingRow>
        <SettingRow title="Reduce motion" description="Disables the status-change flash and spinners.">
          <RowSwitch checked={s.reduceMotion} onCheckedChange={(v) => patchSettings({ reduceMotion: v })} />
        </SettingRow>
        <SettingRow title="Native title bar" description="Use the window manager's title bar (recommended on Linux)." hint={OS !== "linux" ? "Linux only" : undefined} disabled={OS !== "linux"}>
          <RowSwitch checked={s.nativeTitlebar} onCheckedChange={(v) => patchSettings({ nativeTitlebar: v })} disabled={OS !== "linux"} />
        </SettingRow>
        <SettingRow title="Map detail" description="Automatic switches between full cards, compact pills and repo-only overview by zoom.">
          <SmallSelect value={s.mapDefaultLod} onChange={(v) => patchSettings({ mapDefaultLod: v })} options={[{ value: "auto", label: "By zoom" }, { value: "full", label: "Full cards" }, { value: "compact", label: "Compact" }]} />
        </SettingRow>
      </SettingsSection>
    </>
  )
}

function NotificationsPage() {
  const s = useApp((st) => st.settings)
  const repos = useApp((st) => st.repos)
  const order = useApp((st) => st.repoOrder)
  const rule = (k: keyof typeof s.notify, title: string, description: string) => (
    <SettingRow title={title} description={description}>
      <RowSwitch checked={s.notify[k]} onCheckedChange={(v) => patchSettings({ notify: { ...s.notify, [k]: v } })} />
    </SettingRow>
  )
  const test = async () => {
    if (IN_TAURI) {
      try {
        const n = await import("@tauri-apps/plugin-notification")
        if (!(await n.isPermissionGranted())) await n.requestPermission()
        n.sendNotification({ title: "api-gateway · Fix auth retry", body: "Needs permission: Bash npm test -- retry" })
      } catch {
        /* plugin not available */
      }
    }
    pushNotification({ sessionId: "s_main", kind: "finished", title: "Test notification", body: "Notifications work.", createdAt: new Date().toISOString() })
  }
  return (
    <>
      <PageTitle title="Notifications" description="System notifications fire only when the window is unfocused or the session is not visible. In-app toasts always show." actions={<Button size="sm" onClick={() => void test()} title="Send a test notification">Test</Button>} />
      <SettingsSection title="Notify when">
        {rule("permission", "Needs permission", "A tool call is waiting for approval.")}
        {rule("question", "Asks a question", "AskUserQuestion, plan approval or idle prompt.")}
        {rule("finished", "Finishes", "Turn ended; the session is done and unseen.")}
        {rule("error", "Fails", "API errors, crashes, rate limits.")}
        {rule("sound", "Sound", "Short chime for permission and question events.")}
      </SettingsSection>
      <SettingsSection title="Muted repos" description="No toasts or system notifications for these repos. They still appear in Needs you.">
        <div className="flex flex-wrap gap-1.5 py-3">
          {order.map((id) => {
            const muted = s.mutedRepos.includes(id)
            return (
              <button
                key={id}
                onClick={() => patchSettings({ mutedRepos: muted ? s.mutedRepos.filter((x) => x !== id) : [...s.mutedRepos, id] })}
                className={cn("h-6 rounded-sm border px-2 text-xs", muted ? "border-line bg-selected text-fg" : "border-line-subtle text-fg-faint hover:text-fg-muted")}
              >
                {repos[id].name}
              </button>
            )
          })}
        </div>
      </SettingsSection>
    </>
  )
}

function KeysPage() {
  const [q, setQ] = useState("")
  const list = useMemo(() => COMMANDS.filter((c) => c.shortcut && `${c.title} ${c.group}`.toLowerCase().includes(q.toLowerCase())), [q])
  return (
    <>
      <PageTitle title="Keybindings" description="Single-key shortcuts are ignored while typing in inputs, the composer or the terminal." />
      <div className="relative mb-3 flex h-7 w-72 items-center">
        <Search size={13} className="absolute left-2 text-fg-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter shortcuts" className="h-full w-full rounded-md border border-line-subtle bg-chrome pl-7 text-xs outline-none placeholder:text-fg-faint focus:border-line-strong" />
      </div>
      <div className="overflow-hidden rounded-md border border-line-subtle">
        {list.map((c) => (
          <div key={c.id} className="flex h-7 items-center gap-3 border-b border-line-subtle px-3 text-xs last:border-0">
            <span className="truncate text-fg" title={c.group}>{c.title}</span>
            <Shortcut keys={c.shortcut!} className="ml-auto" />
          </div>
        ))}
      </div>
    </>
  )
}

function GraphifyPage() {
  const s = useApp((st) => st.settings)
  // Phase 1: not persisted (the Settings model has no field for it yet)
  const repos = useApp((st) => st.repos)
  const order = useApp((st) => st.repoOrder)
  return (
    <>
      <PageTitle title="Graphify" description="Code knowledge graphs per repo (graphify-out/graph.json) plus the global cross-repo graph used for map links. Agents query it through the Graphify MCP server." />
      <SettingsSection>
        <SettingRow title="Rebuild on commit" description="Installs Graphify's git hooks (post-commit, post-checkout, post-merge).">
          <RowSwitch checked={s.graphifyAutoBuild} onCheckedChange={(v) => patchSettings({ graphifyAutoBuild: v })} />
        </SettingRow>
        <SettingRow title="Global graph" description={<><Code>~/.graphify/global-graph.json</Code> with cross-repo calls edges.</>}>
          <span className="text-xs text-fg-muted">Fresh</span>
        </SettingRow>
        <SettingRow title="Expose to agents" description={<>Adds the graphify MCP server (<Code>query_graph</Code>, <Code>get_neighbors</Code>, <Code>shortest_path</Code>…) to new sessions.</>}>
          <RowSwitch checked={s.graphifyExposeMcp} onCheckedChange={(v) => patchSettings({ graphifyExposeMcp: v })} />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Repos">
        {order.map((id) => {
          const g = repos[id].graphify
          return (
            <div key={id} className="flex h-7 items-center gap-3 border-b border-line-subtle text-xs">
              <span className="w-40 truncate text-fg">{repos[id].name}</span>
              <span className={cn("w-16", g?.state && g.state !== "none" ? "text-fg-muted" : "text-fg-faint")}>{g?.state ?? "none"}</span>
              <span
                className="tabular ml-auto text-[11px] text-fg-faint"
                title={g?.nodes ? `${compact(g.nodes)} nodes · ${g.communities} communities · built at ${g.builtAtCommit}` : undefined}
              >
                {g?.nodes ? compact(g.nodes) : ""}
              </span>
            </div>
          )
        })}
      </SettingsSection>
    </>
  )
}

function LayoutsPage() {
  const preset = useApp((s) => s.layoutPreset)
  const items = [
    { id: "default" as const, label: "Default", description: "Sidebar, center, inspector. Bottom panel on demand." },
    { id: "focus" as const, label: "Focus", description: "Center only: for working inside one session." },
    { id: "review" as const, label: "Review", description: "Center + inspector: for reviewing changes and approvals." },
  ]
  return (
    <>
      <PageTitle title="Layouts" description="Panel sizes are saved per layout automatically." />
      <div className="overflow-hidden rounded-md border border-line-subtle">
        {items.map((it) => (
          <button
            key={it.id}
            onClick={() => setLayoutPreset(it.id)}
            title={it.description}
            aria-pressed={preset === it.id}
            className={cn("flex h-8 w-full items-center gap-3 border-b border-line-subtle px-3 text-left last:border-0", preset === it.id ? "bg-selected" : "hover:bg-hover/50")}
          >
            <LayoutTemplate size={14} className="text-fg-faint" />
            <span className="text-[13px] text-fg">{it.label}</span>
            {preset === it.id && <Check size={13} className="ml-auto text-fg-muted" aria-label="Current" />}
          </button>
        ))}
      </div>
    </>
  )
}

function AboutPage() {
  return (
    <>
      <PageTitle title="About" description="Phase 1 (UI with mock data) · Tauri 2 + React 19" actions={<span className="text-xs text-fg-faint">0.1.0</span>} />
      <SettingsSection title="Third-party" description="Code adapted from these projects keeps its license header; full texts are in THIRD_PARTY_NOTICES.md.">
        {NOTICES.map((n) => (
          <div key={n.name} className="flex h-7 items-center gap-3 border-b border-line-subtle text-xs">
            <span className="w-48 shrink-0 truncate text-fg" title={n.name}>{n.name}</span>
            <span className="w-28 shrink-0 truncate font-mono text-[11px] whitespace-nowrap text-fg-muted" title={n.license}>{n.license}</span>
            <span className="truncate text-fg-faint" title={n.use}>{n.use}</span>
          </div>
        ))}
      </SettingsSection>
    </>
  )
}
