// Settings: one page, four short sections (repos, new sessions, notifications, window) and the
// open-source notices. Row layout adapted from mountain-loop/yaak@6a34d0a:
// packages/ui/src/components/settings/SettingRow.tsx (MIT) — title left, control right — and
// coollabsio/jean@1d53d3c: src/components/preferences/SettingsSection.tsx (Apache-2.0).
// Modified for session-dashboard: our tokens, a single scrolling page instead of a dialog.
import { createContext, useContext, useEffect, useId, useState, type ComponentProps, type ReactNode } from "react"
import { FolderGit2, Plus, Server, Trash2 } from "lucide-react"
import { useApp } from "@/store/app"
import { patchSettings, pushNotification, setSetting } from "@/store/actions"
import { SETTING_ROWS, type SettingRowEntry, type SettingsPage } from "@/store/settingsSchema"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { homePath } from "@/lib/format"
import { IN_TAURI } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { AddReposDialog } from "./AddReposDialog"
import { REAL } from "@/backend/mode"
import { setHooks } from "@/backend/real"
import { WorkspaceDialog } from "@/features/workspaces/WorkspaceDialog"
import { probeMachine } from "@/backend/machines"
import { pollCloud } from "@/backend/cloud"
import { Input } from "@/components/ui/input"
import { NOTICES } from "./notices"
import { PermissionsPage } from "./PermissionsPage"

/** The settings sections, in the order the dialog lists them. */
export const SECTIONS = [
  { id: "sessions", label: REAL ? "Sessions" : "Repos", Page: REAL ? SourcesPage : ReposPage },
  { id: "new", label: "New sessions", Page: ClaudePage },
  { id: "permissions", label: "Permissions", Page: PermissionsPage },
  { id: "notifications", label: "Notifications", Page: NotificationsPage },
  { id: "window", label: "Window", Page: WindowPage },
  { id: "about", label: "About", Page: AboutPage },
] as const

export default function SettingsView() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[960px] px-8 pt-10 pb-16">
        {REAL ? <SourcesPage /> : <ReposPage />}
        <ClaudePage />
        <NotificationsPage />
        <WindowPage />
        <AboutPage />
      </div>
    </div>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-sm bg-muted px-1 py-px font-mono text-xs text-muted-foreground">{children}</code>
}

/** Page heading. Long explanations live in the tooltip, not on screen. */
function PageTitle({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-2 flex h-7 items-center gap-3">
      <h2 className="text-base font-medium text-foreground" title={description}>
        {title}
      </h2>
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  )
}

function SettingsSection({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return (
    <section className="mb-10">
      {title && (
        <h3 className="border-b border-border pb-2 text-xs font-medium text-muted-foreground/70" title={description}>
          {title}
        </h3>
      )}
      <div className="[&>*:last-child]:border-b-0">{children}</div>
    </section>
  )
}

/**
 * Yaak SettingRow: label left, control right. One line at rest; the explanation is a hover card
 * on the label. `hint` = 1–3 words when it matters.
 */
/** Id of the enclosing SettingRow's title: its switch / select is named by it (aria-labelledby). */
const RowLabel = createContext<string | undefined>(undefined)

function SettingRow({ title, description, hint, children, disabled }: { title: ReactNode; description?: ReactNode; hint?: string; children: ReactNode; disabled?: boolean }) {
  const labelId = useId()
  return (
    <div className={cn("grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border py-2", disabled && "opacity-50")}>
      <div className="flex min-w-0 items-center gap-2">
        {description ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span id={labelId} className="cursor-default text-sm text-foreground decoration-input decoration-dotted underline-offset-4 hover:underline">{title}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="max-w-80 text-xs leading-relaxed">
              {description}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span id={labelId} className="text-sm text-foreground">{title}</span>
        )}
        {hint && <span className="text-xs text-muted-foreground/70">{hint}</span>}
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

function SmallSelect<T extends string>({ value, onChange, options, width = "w-44" }: { value: T; onChange: (v: T) => void; options: readonly { value: T; label: string }[]; width?: string }) {
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

/** Hover text from the registry: `text in backticks` shows as code. */
function richText(text: string): ReactNode {
  if (!text.includes("`")) return text
  return text.split("`").map((part, i) => (i % 2 ? <Code key={i}>{part}</Code> : part))
}

/** A page's plain rows, from the settings registry (store/settingsSchema.ts) in its order. */
function RegistryRows({ page }: { page: SettingsPage }) {
  return SETTING_ROWS.filter((e) => e.row.page === page).map((e) => <RegistryRow key={e.path.join(".")} entry={e} />)
}

/** One registry setting: a switch for on/off, a menu for a choice. */
function RegistryRow({ entry: { path, field, row } }: { entry: SettingRowEntry }) {
  const value = useApp((s) => {
    const v = s.settings[path[0]]
    return path[1] === undefined ? v : (v as Record<string, unknown>)[path[1]]
  })
  const off = row.unavailable?.()
  const set = (v: unknown) => setSetting(path, v)
  return (
    <SettingRow title={row.label} description={row.description && richText(row.description)} hint={off} disabled={!!off}>
      {field.type === "boolean" ? (
        <RowSwitch checked={value as boolean} onCheckedChange={set} disabled={!!off} />
      ) : field.type === "number" ? (
        <SmallSelect value={String(value)} onChange={(v) => set(Number(v))} options={(field.options ?? []).map((o) => ({ value: String(o.value), label: o.label }))} width={row.width} />
      ) : (
        <SmallSelect value={value as string} onChange={set} options={field.type === "enum" ? field.options.filter((o) => !field.offer || field.offer(o.value)) : (field.options ?? [])} width={row.width} />
      )}
    </SettingRow>
  )
}

// ---------- sections ----------
export function ReposPage() {
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
      <div className="overflow-hidden rounded-md border border-border">
        {order.map((id) => {
          const r = repos[id]
          return (
            <div
              key={id}
              className="group flex h-8 items-center gap-3 border-b border-border px-3 last:border-0 hover:bg-accent/50"
              title={`${r.language} · ${counts[id]?.length ?? 0} sessions`}
            >
              <FolderGit2 size={14} className="shrink-0 text-muted-foreground/70" />
              <span className="w-44 shrink-0 truncate text-sm text-foreground">{r.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/70">{homePath(r.rootPath)}</span>
              <button className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 outline-none group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring" title="Stop tracking (sessions are kept)" aria-label={`Stop tracking ${r.name}`}>
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
      </div>
      {adding && <AddReposDialog onClose={() => setAdding(false)} />}
      <div className="mb-10" />
      {/* the browser preview has no Sessions page: "Edit workspaces" (top-left menu) lands here */}
      <Workspace />
    </>
  )
}

/** Where sessions come from: hooks on this computer, the cloud, VPS machines over ssh. */
/**
 * Terminal sync: `claude` in your shells runs through the app's wrapper, so a session in any terminal
 * (Zed's, GNOME Terminal, …) takes replies from the app as if you typed them there.
 */
function TerminalSync() {
  const [st, setSt] = useState<{ on: boolean; files?: string[]; note?: string | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const live = IN_TAURI && REAL
  useEffect(() => {
    if (!live) return
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke<{ on: boolean; files?: string[]; note?: string | null }>("sync_status").then(setSt))
  }, [live])
  if (!live || !st) return null
  const set = (on: boolean) =>
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<{ on: boolean; files?: string[]; note?: string | null }>("sync_set", { on }))
      .then((v) => {
        setSt(v)
        setErr(null)
      })
      .catch((e) => setErr(String(e)))
  return (
    <SettingRow
      title="Sync terminal sessions"
      hint={st.on ? "on" : undefined}
      description={
        <>
          Claude Code sessions you start in any terminal (Zed, VS Code, GNOME Terminal, iTerm, Windows Terminal, …) stay in full sync with the app: replies you write here are typed into that terminal, and the terminal keeps running. It adds a small <Code>claude</Code> function to your shell's startup file (bash, zsh, fish, PowerShell, Git Bash){st.files?.length ? `: ${st.files.map((f) => f.split(/[\\/]/).pop()).join(", ")}` : ""}; turning it off removes it. Applies to terminals opened afterwards.
          {st.note && <span className="mt-1 block text-st-input-fg">{st.note}</span>}
          {err && <span className="mt-1 block text-st-error-fg">{err}</span>}
        </>
      }
    >
      <RowSwitch checked={st.on} onCheckedChange={set} />
    </SettingRow>
  )
}

/**
 * Other Claude Code config folders (a second account: `CLAUDE_CONFIG_DIR=~/.claude-work claude`).
 * Their sessions, transcripts and usage are read beside the main one; a workspace can start its new
 * sessions in one of them (Workspaces → edit).
 */
function Accounts() {
  const dirs = useApp((st) => st.settings.claudeConfigDirs ?? [])
  const [draft, setDraft] = useState("")
  const add = () => {
    const d = draft.trim().replace(/\/+$/, "")
    if (!d || dirs.includes(d) || d === "~/.claude") return
    patchSettings({ claudeConfigDirs: [...dirs, d] })
    setDraft("")
  }
  return (
    <SettingRow
      title="Other Claude accounts"
      hint={dirs.length ? `${dirs.length}` : undefined}
      description="Config folders of other Claude Code accounts (what CLAUDE_CONFIG_DIR points to, like ~/.claude-work). Their sessions and plan limits show here too, a workspace can start new sessions in one of them, and a session can continue on another account (session menu, or the usage limit card)."
    >
      <div className="flex flex-col items-end gap-1.5">
        {dirs.map((d) => (
          <span key={d} className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            {d}
            <Button size="icon-xs" variant="ghost" aria-label={`Remove ${d}`} onClick={() => patchSettings({ claudeConfigDirs: dirs.filter((x) => x !== d) })}>
              <Trash2 />
            </Button>
          </span>
        ))}
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="~/.claude-work" aria-label="Another Claude config folder" className="h-7 w-44 font-mono text-xs" spellCheck={false} autoCapitalize="off" />
          <Button size="sm" variant="outline" type="submit" disabled={!draft.trim()}>
            Add
          </Button>
        </form>
      </div>
    </SettingRow>
  )
}

const AUTO_SWITCH = [
  { value: "0", label: "Off" },
  { value: "50", label: "If under 50 %" },
  { value: "80", label: "If under 80 %" },
  { value: "95", label: "If under 95 %" },
] as const

/** At the usage limit, carry the app's sessions on with another account by themselves. */
function AutoSwitchAccount() {
  const dirs = useApp((st) => st.settings.claudeConfigDirs ?? [])
  const value = useApp((st) => st.settings.autoSwitchAccount ?? 0)
  if (!dirs.length) return null
  const shown = AUTO_SWITCH.find((o) => Number(o.value) === value)?.value ?? "0"
  return (
    <SettingRow
      title="Switch accounts at the limit"
      description="A session the app runs that stops at the usage limit continues on the other account with the most room, if that account's 5-hour window is used less than this. At most once per session in 5 hours. The old session is archived; the first message reads the conversation again on the other account."
    >
      <SmallSelect value={shown} onChange={(v) => patchSettings({ autoSwitchAccount: Number(v) })} options={AUTO_SWITCH} width="w-36" />
    </SettingRow>
  )
}

/**
 * Claude Code deletes transcripts older than cleanupPeriodDays (30 by default). The usage ledger
 * survives that, the chats themselves don't: offer a longer period, written on a click.
 */
function KeepChats() {
  const [days, setDays] = useState<number | null | undefined>(undefined)
  const [err, setErr] = useState<string | null>(null)
  const live = IN_TAURI && REAL
  useEffect(() => {
    if (!live) return
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke<number | null>("claude_user_setting", { key: "cleanupPeriodDays" }).then((v) => setDays(typeof v === "number" ? v : null)))
  }, [live])
  if (!live || days === undefined) return null
  const now = days ?? 30
  const set = (v: number) =>
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("claude_set_user_setting", { key: "cleanupPeriodDays", value: v }))
      .then(() => setDays(v))
      .catch((e) => setErr(String(e)))
  return (
    <SettingRow
      title="Keep chats for"
      hint={`${now} days${days === null ? " (default)" : ""}`}
      description={
        <>
          Claude Code deletes session transcripts older than this (<Code>cleanupPeriodDays</Code> in <Code>~/.claude/settings.json</Code>). Usage history here survives it; the chats, search and resume don't.
          {err && <span className="mt-1 block text-st-error-fg">{err}</span>}
        </>
      }
    >
      {now < 365 ? (
        <Button size="sm" variant="outline" onClick={() => set(365)}>
          Keep a year
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">{now} days</span>
      )}
    </SettingRow>
  )
}

export function SourcesPage() {
  const hooks = useApp((s) => s.hooks)
  const cloud = useApp((s) => s.settings.cloud)
  const cloudStatus = useApp((s) => s.cloudStatus)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const toggleHooks = async (on: boolean) => {
    setBusy(true)
    setErr(undefined)
    try {
      await setHooks(on)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <PageTitle title="Sessions" description="Sessions on this computer are found by themselves. Hooks make their states exact; the cloud and VPS machines add sessions that run elsewhere." />
      <Workspace />
      <SettingsSection>
        <RegistryRows page="sessions" />
        <TerminalSync />
        <KeepChats />
        <Accounts />
        <AutoSwitchAccount />
        <SettingRow
          title="Exact states from hooks"
          hint={err ? "failed" : hooks?.installed ? "on" : undefined}
          description={
            <>
              Adds a small hook to <Code>~/.claude/settings.json</Code> (the first change keeps a backup next to it). Every session then tells the dashboard what it waits for and what it runs, with the folder's git status. The hook runs in the background: Claude never waits for it. Turning this off removes it again.
              {err && <span className="mt-1 block text-st-error-fg">{err}</span>}
            </>
          }
        >
          <RowSwitch checked={!!hooks?.installed} disabled={busy} onCheckedChange={(v) => void toggleHooks(v)} />
        </SettingRow>
        <SettingRow
          title="Cloud sessions"
          hint={cloud && cloudStatus ? (cloudStatus.ok ? plural0(cloudStatus.count ?? 0, "session") : "unavailable") : undefined}
          description={
            <>
              Your sessions on claude.ai/code and Remote Control, read with your Claude Code sign-in. Messages go in from here; permission prompts in a cloud session are answered on claude.ai.
              {cloudStatus && !cloudStatus.ok && cloudStatus.message && <span className="mt-1 block text-muted-foreground/70">{cloudStatus.message}</span>}
            </>
          }
        >
          <RowSwitch
            checked={cloud}
            onCheckedChange={(v) => {
              patchSettings({ cloud: v })
              if (v) void pollCloud()
            }}
          />
        </SettingRow>
      </SettingsSection>
      <Machines />
    </>
  )
}

/** Workspaces: named sets of repositories, switched in the top bar. */
function Workspace() {
  const list = useApp((s) => s.settings.workspaces)
  const active = useApp((s) => s.settings.workspace)
  const repos = useApp((s) => s.repos)
  const [dialog, setDialog] = useState<{ edit?: (typeof list)[number] } | null>(null)
  return (
    <SettingsSection
      title="Workspaces"
      description="A workspace is a set of repositories (Work = the repos of your job). The top bar switches between them; each shows its repos' sessions wherever they run: here, on a VPS or in the cloud."
    >
      {list.map((w) => {
        const names = w.repos?.map((r) => r.name) ?? (w.folders ?? []).map((f) => `${f}/*`)
        const n = Object.values(repos).filter((r) => r.workspace === w.id).length
        return (
          <div key={w.id} className="group flex min-h-12 items-center gap-3 border-b border-border py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-foreground">{w.name}</span>
                <span className="text-xs text-muted-foreground/70">
                  {plural0(n, "repo")}
                  {w.id === active ? " · shown" : ""}
                </span>
              </div>
              <div className="truncate text-xs text-muted-foreground">{names.join(", ") || "No repositories"}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setDialog({ edit: w })}>
              Edit
            </Button>
            <button
              onClick={() => patchSettings({ workspaces: list.filter((x) => x.id !== w.id), workspace: active === w.id ? "" : active })}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 outline-none group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
              title="Delete this workspace (its sessions keep running)"
              aria-label={`Delete ${w.name}`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        )
      })}
      <div className="py-3">
        <Button size="sm" variant="outline" onClick={() => setDialog({})}>
          <Plus /> New workspace
        </Button>
      </div>
      <WorkspaceDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} edit={dialog?.edit} />
    </SettingsSection>
  )
}

const plural0 = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`

function Machines() {
  const machines = useApp((s) => s.settings.machines)
  const status = useApp((s) => s.machineStatus)
  const [host, setHost] = useState("")
  const [adding, setAdding] = useState(false)
  const [working, setWorking] = useState<string>()
  const add = async () => {
    const h = host.trim()
    if (!h || machines.some((m) => m.host === h)) return
    setAdding(true)
    const r = await probeMachine(h).catch((e) => ({ ok: false, error: String(e) }))
    setAdding(false)
    if (r.ok) {
      patchSettings({ machines: [...machines, { host: h }] })
      setHost("")
    }
  }
  const hooks = async (h: string, install: boolean) => {
    setWorking(h)
    try {
      await setHooks(install, h)
      await probeMachine(h)
    } catch (e) {
      useApp.setState((s) => ({ machineStatus: { ...s.machineStatus, [h]: { ...s.machineStatus[h], host: h, error: String(e) } } }))
    } finally {
      setWorking(undefined)
    }
  }
  const pending = host.trim() ? status[host.trim()] : undefined
  return (
    <SettingsSection title="Machines" description="A VPS or another computer where repos live. The app reaches it with your ssh (keys and ~/.ssh/config aliases; it never asks for a password), keeps a tunnel so the hook there can report, and starts sessions there.">
      {machines.map(({ host: h }) => {
        const st = status[h]
        // only what a check found: "not found" when it looked and claude was not there
        const claude = !st?.checkedAt ? "checking…" : st.claude ? (st.version ? `claude ${st.version.replace(/ \(.*\)$/, "")}` : "claude") : "claude not found"
        const line = st?.error ?? (st?.ok ? [st.hostname, claude, st.tunnel === false ? `tunnel: ${st.tunnelError ?? "down"}` : undefined].filter(Boolean).join(" · ") : "checking…")
        return (
          <div key={h} className="group flex min-h-10 items-center gap-3 border-b border-border py-1.5">
            <Server size={14} className={cn("shrink-0", st?.ok ? "text-muted-foreground" : "text-muted-foreground/70")} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs text-foreground">{h}</div>
              <div className={cn("truncate text-xs", st?.error ? "text-st-error-fg" : "text-muted-foreground/70")}>{line}</div>
            </div>
            {st?.ok && st.hooks !== undefined && (
              <Button size="sm" variant={st.hooks ? "ghost" : "default"} disabled={working === h} onClick={() => void hooks(h, !st.hooks)} title={st.hooks ? "Remove the hook from this machine's ~/.claude/settings.json" : "Add the hook to this machine's ~/.claude/settings.json (a backup is kept)"}>
                {st.hooks ? "Remove hooks" : "Install hooks"}
              </Button>
            )}
            <button
              onClick={() => patchSettings({ machines: machines.filter((m) => m.host !== h) })}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 outline-none group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
              title="Remove this machine (its sessions keep running)"
              aria-label={`Remove ${h}`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        )
      })}
      <form
        className="flex items-center gap-2 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ssh alias or user@host" className="h-8 flex-1 font-mono text-xs" aria-label="Machine to add" spellCheck={false} autoCapitalize="off" />
        <Button size="sm" variant="outline" type="submit" disabled={!host.trim() || adding}>
          {adding ? "Checking…" : "Add"}
        </Button>
      </form>
      {pending && !pending.ok && pending.error && !adding && <p className="-mt-1 pb-3 text-xs text-st-error-fg">{pending.error}</p>}
    </SettingsSection>
  )
}

export function ClaudePage() {
  return (
    <>
      <PageTitle title="New sessions" description="Defaults for new sessions. Sessions are read from the Claude Code config directory." />
      <SettingsSection>
        <RegistryRows page="new" />
      </SettingsSection>
    </>
  )
}

export function NotificationsPage() {
  const s = useApp((st) => st.settings)
  const repos = useApp((st) => st.repos)
  const order = useApp((st) => st.repoOrder)
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
      <PageTitle title="Notifications" description="Only while the window is in the background, after 10 quiet seconds, so prompts you answer elsewhere stay silent. At most 2 in 10 minutes and 6 an hour; more arrive as one summary." actions={<Button size="sm" variant="outline" onClick={() => void test()} title="Send a test notification">Test</Button>} />
      <SettingsSection title="Notify when">
        <RegistryRows page="notifications" />
      </SettingsSection>
      <SettingsSection title="Muted repos" description="No system notifications for these repos. They still count as needing you.">
        <div className="flex flex-wrap gap-1.5 py-3">
          {order.map((id) => {
            const muted = s.mutedRepos.includes(id)
            return (
              <button
                key={id}
                onClick={() => patchSettings({ mutedRepos: muted ? s.mutedRepos.filter((x) => x !== id) : [...s.mutedRepos, id] })}
                className={cn("h-6 rounded-sm border px-2 text-xs", muted ? "border-border bg-accent text-foreground" : "border-border text-muted-foreground/70 hover:text-muted-foreground")}
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

export function WindowPage() {
  return (
    <>
      <PageTitle title="Window" />
      <SettingsSection>
        <RegistryRows page="window" />
      </SettingsSection>
    </>
  )
}

export function AboutPage() {
  const [open, setOpen] = useState(false)
  return (
    <section className="mt-2 text-xs text-muted-foreground/70">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="hover:text-muted-foreground">
        Open-source notices ({NOTICES.length})
      </button>
      {open && (
        <div className="mt-3">
          {NOTICES.map((n) => (
            <div key={n.name} className="flex h-7 items-center gap-3 border-b border-border">
              <span className="w-56 shrink-0 truncate text-muted-foreground">{n.name}</span>
              <span className="w-28 shrink-0 truncate font-mono text-xs">{n.license}</span>
              <span className="truncate">{n.use}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
