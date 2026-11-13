// New session / Resume — UI_PLAN §5.7. Fields mirror Claude Code flags (RESEARCH §1.5):
// --worktree, --model, --effort, --permission-mode, --add-dir, --agent, --mcp-config,
// --append-system-prompt, --bg, --resume / --fork-session. Field set after
// coollabsio/jean@1d53d3c session settings (Apache-2.0); dialog chrome is shadcn (MIT).
import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Copy, FolderGit2, GitBranch, Link2, Play, Search, GitFork, Terminal } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { getApp, useApp } from "@/store/app"
import { closeNewSession, createSession, forkSession, openSession, resumeSession } from "@/store/actions"
import { Shortcut } from "@/components/common/bits"
import { relTime } from "@/lib/format"
import { prepareQuery, scoreSession } from "@/features/sessions/search"
import type { Effort, ID, PermissionMode } from "@/lib/model"
import { cn } from "@/lib/utils"
import { cmpIso } from "@/features/sessions/search"
import { clearNewSessionPrefill, peekNewSessionPrefill } from "./prefill"

const MODELS = [
  { value: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5" },
  { value: "claude-fable-5-2", label: "Fable 5.2" },
]
const AGENTS = ["none", "code-reviewer", "test-runner", "migration-writer"]
const MCP = [
  { id: "graphify", label: "graphify", note: "code graph" },
  { id: "github", label: "github", note: "PRs, issues" },
  { id: "linear", label: "linear", note: "tickets" },
]

export default function NewSessionDialog() {
  const ns = useApp((s) => s.newSession)!
  const [tab, setTab] = useState<"new" | "resume">(ns.tab)
  return (
    <Dialog open onOpenChange={(o) => !o && closeNewSession()}>
      <DialogContent showCloseButton={false} className="top-[10%] max-w-[680px] translate-y-0 gap-0 border-line bg-elevated p-0 shadow-[0_16px_48px_rgba(0,0,0,0.55)] sm:max-w-[680px]">
        <div className="flex h-10 items-center gap-1 border-b border-line-subtle px-2">
          <DialogTitle className="sr-only">New session</DialogTitle>
          {(["new", "resume"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn("h-7 rounded-md px-2.5 text-xs", tab === t ? "bg-selected text-fg" : "text-fg-faint hover:text-fg-muted")}
            >
              {t === "new" ? "New session" : "Resume"}
            </button>
          ))}
        </div>
        {tab === "new" ? <NewForm initialRepo={ns.repoId} /> : <ResumeList initialRepo={ns.repoId} />}
      </DialogContent>
    </Dialog>
  )
}

function RepoPicker({ value, onChange }: { value: ID; onChange: (id: ID) => void }) {
  const order = useApp((s) => s.repoOrder)
  const repos = useApp((s) => s.repos)
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex h-7 w-full items-center gap-2 rounded-md border border-line bg-canvas px-2 text-left text-xs text-fg hover:border-line-strong">
          <FolderGit2 size={13} className="text-fg-faint" />
          {repos[value]?.name ?? "Choose repository"}
          <ChevronDown size={12} className="ml-auto text-fg-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Find repository…" className="h-8 text-xs" />
          <CommandList className="max-h-64">
            <CommandEmpty className="py-4 text-center text-xs text-fg-faint">No repository.</CommandEmpty>
            <CommandGroup>
              {order.map((id) => (
                <CommandItem key={id} value={repos[id].name} onSelect={() => { onChange(id); setOpen(false) }} className="text-xs">
                  <FolderGit2 size={13} />
                  {repos[id].name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Label column + control. Flag names and explanations are tooltips (§2.5 copy budget). */
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="grid grid-cols-[96px_1fr] items-start gap-3">
      <div className="pt-1.5 text-xs text-fg-muted" title={hint}>
        {label}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-md border border-line-subtle bg-canvas p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className={cn("h-6 rounded-sm px-2 text-xs", value === o.value ? "bg-selected text-fg" : "text-fg-faint hover:text-fg-muted")}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Repo to preselect when the dialog is opened without one (Ctrl+N, palette): the repo you are
 * looking at (session / repo / graph tab), else the selected repo or session, else the first.
 */
function contextRepo(): ID {
  const st = getApp()
  const [, kind, ref] = st.activeTab.split("/")
  const fromTab = kind === "session" || kind === "review" ? st.sessions[ref]?.repoId : kind === "repo" || kind === "graph" ? ref : null
  const sel = st.selection
  const fromSel = sel?.kind === "repo" ? sel.id : sel?.kind === "session" ? st.sessions[sel.id]?.repoId : sel?.kind === "subagent" ? st.sessions[st.subagents[sel.id]?.sessionId]?.repoId : null
  const id = [fromTab, fromSel].find((r) => r && st.repos[r])
  return id ?? st.repoOrder[0]
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 4).join("-")
}

function NewForm({ initialRepo }: { initialRepo?: ID }) {
  const defaults = useApp((s) => s.settings.defaults)
  const repoOrder = useApp((s) => s.repoOrder)
  const repos = useApp((s) => s.repos)
  const [repoId, setRepoId] = useState<ID>(() => initialRepo ?? contextRepo())
  const [where, setWhere] = useState<"worktree-new" | "main">(defaults.worktree ? "worktree-new" : "main")
  // "Ask a session" from the code graph prefills the symbol reference (read here, cleared after mount)
  const [prompt, setPrompt] = useState(() => peekNewSessionPrefill() ?? "")
  const [title, setTitle] = useState("")
  const [wtName, setWtName] = useState("")
  const [model, setModel] = useState(defaults.model)
  const [effort, setEffort] = useState<Effort>(defaults.effort)
  const [perm, setPerm] = useState<PermissionMode>(defaults.permissionMode)
  const [addDirs, setAddDirs] = useState<ID[]>([])
  const [agent, setAgent] = useState("none")
  const [mcp, setMcp] = useState<Record<string, boolean>>({ graphify: true, github: true, linear: false })
  const [append, setAppend] = useState("")
  const [bg, setBg] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [showCli, setShowCli] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (peekNewSessionPrefill() === null) return
    clearNewSessionPrefill()
    // caret after the reference, ready for the question
    const t = promptRef.current
    t?.setSelectionRange(t.value.length, t.value.length)
  }, [])

  const autoName = wtName || slug(title || prompt) || "new-session"
  const repo = repos[repoId]
  const cmd = useMemo(() => {
    const parts = ["claude"]
    if (bg) parts.push("--bg")
    if (where === "worktree-new") parts.push(`-w ${autoName}`)
    parts.push(`--model ${model.replace("claude-", "").replace(/-(\d)-(\d)$/, "-$1.$2")}`)
    parts.push(`--effort ${effort}`)
    if (perm !== "default") parts.push(`--permission-mode ${perm}`)
    for (const r of addDirs) parts.push(`--add-dir ../${repos[r].name}`)
    if (agent !== "none") parts.push(`--agent ${agent}`)
    if (append.trim()) parts.push(`--append-system-prompt "…"`)
    if (title.trim()) parts.push(`-n "${title.trim()}"`)
    return parts.join(" ")
  }, [bg, where, autoName, model, effort, perm, addDirs, agent, append, title, repos])

  const links = useApp((s) => s.links)
  const linked = useMemo(() => links.filter((l) => l.from === repoId || l.to === repoId).map((l) => (l.from === repoId ? l.to : l.from)), [links, repoId])

  const submit = () => {
    if (!prompt.trim()) {
      promptRef.current?.focus()
      return
    }
    const id = createSession({
      repoId,
      where,
      worktreeName: autoName,
      title: title.trim() || undefined,
      prompt: prompt.trim(),
      model,
      effort,
      permissionMode: perm,
      additionalRepoIds: addDirs,
      background: bg,
    })
    closeNewSession()
    if (!bg) openSession(id)
  }

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          submit()
        }
      }}
    >
      <div className="flex max-h-[calc(100vh-200px)] flex-col gap-3 overflow-y-auto px-4 py-4">
        <Field label="Repo">
          <RepoPicker value={repoId} onChange={setRepoId} />
        </Field>
        <Field label="Where">
          <div className="flex items-center gap-2">
            <Seg value={where} onChange={setWhere} options={[{ value: "worktree-new", label: "New worktree" }, { value: "main", label: "Main checkout" }]} />
            {where === "worktree-new" && (
              <div
                className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-line-subtle bg-canvas px-2 focus-within:border-line-strong"
                title={`${repo?.rootPath.replace(/^\/home\/[^/]+/, "~")}/.claude/worktrees/${autoName}`}
              >
                <GitBranch size={12} className="mr-1.5 shrink-0 text-fg-faint" />
                <span className="shrink-0 font-mono text-[11px] text-fg-faint">wt/</span>
                <input value={wtName} onChange={(e) => setWtName(e.target.value)} placeholder={autoName} aria-label="Worktree name" className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-fg outline-none placeholder:text-fg-faint" />
              </div>
            )}
          </div>
        </Field>
        <Field label="Prompt">
          <textarea
            ref={promptRef}
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder="Describe the task"
            title="/ for commands, @ to mention files, Ctrl+Enter to start"
            className="w-full resize-none rounded-md border border-line bg-canvas px-2.5 py-2 text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-faint focus:border-line-strong"
          />
        </Field>
        <Field label="Model" hint="--model, --effort">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger size="sm" className="h-7 w-32 text-xs" aria-label="Model"><SelectValue /></SelectTrigger>
              <SelectContent>{MODELS.map((m) => <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>)}</SelectContent>
            </Select>
            <Seg value={effort} onChange={setEffort} options={(["low", "medium", "high", "xhigh", "max"] as const).map((v) => ({ value: v, label: v }))} />
          </div>
        </Field>

        <button
          className="flex h-6 items-center gap-1 self-start rounded-sm pr-1.5 text-xs text-fg-faint hover:text-fg-muted"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          title="Title, permissions, other repos, agent, MCP, system prompt, background"
        >
          {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Options
        </button>
        {advanced && (
          <div className="flex flex-col gap-3">
            <Field label="Title" hint="Optional; auto-named otherwise">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Auto" className="h-7 w-full rounded-md border border-line-subtle bg-canvas px-2 text-xs text-fg outline-none placeholder:text-fg-faint focus:border-line-strong" />
            </Field>
            <Field label="Permissions" hint="--permission-mode">
              <Select value={perm} onValueChange={(v) => setPerm(v as PermissionMode)}>
                <SelectTrigger size="sm" className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default" className="text-xs">Ask</SelectItem>
                  <SelectItem value="acceptEdits" className="text-xs">Accept edits</SelectItem>
                  <SelectItem value="plan" className="text-xs">Plan first</SelectItem>
                  <SelectItem value="auto" className="text-xs">Auto</SelectItem>
                  <SelectItem value="dontAsk" className="text-xs">Don&apos;t ask</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Other repos" hint="--add-dir">
              <div className="flex flex-wrap gap-1">
                {repoOrder
                  .filter((r) => r !== repoId)
                  .sort((a, b) => Number(linked.includes(b)) - Number(linked.includes(a)))
                  .slice(0, 12)
                  .map((r) => {
                    const on = addDirs.includes(r)
                    return (
                      <button
                        key={r}
                        onClick={() => setAddDirs(on ? addDirs.filter((x) => x !== r) : [...addDirs, r])}
                        aria-pressed={on}
                        title={linked.includes(r) ? "Linked repo" : undefined}
                        className={cn("flex h-6 items-center gap-1 rounded-sm border px-1.5 text-[11px]", on ? "border-line bg-selected text-fg" : "border-line-subtle text-fg-faint hover:text-fg-muted")}
                      >
                        {linked.includes(r) && <Link2 size={10} className="shrink-0" />}
                        {repos[r].name}
                      </button>
                    )
                  })}
              </div>
            </Field>
            <Field label="Agent" hint="--agent (.claude/agents)">
              <Select value={agent} onValueChange={setAgent}>
                <SelectTrigger size="sm" className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{AGENTS.map((a) => <SelectItem key={a} value={a} className="text-xs">{a === "none" ? "None" : a}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="MCP" hint="MCP servers for this session">
              <div className="flex flex-wrap gap-3 pt-1">
                {MCP.map((m) => (
                  <label key={m.id} className="flex items-center gap-1.5 text-xs text-fg-muted" title={m.note}>
                    <Switch checked={!!mcp[m.id]} onCheckedChange={(v) => setMcp({ ...mcp, [m.id]: v })} />
                    {m.label}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Instructions" hint="--append-system-prompt">
              <textarea value={append} onChange={(e) => setAppend(e.target.value)} rows={2} placeholder="Appended to the system prompt" className="w-full resize-none rounded-md border border-line-subtle bg-canvas px-2 py-1.5 text-xs text-fg outline-none placeholder:text-fg-faint focus:border-line-strong" />
            </Field>
            <Field label="Background" hint="claude --bg">
              <div className="pt-1">
                <Switch checked={bg} onCheckedChange={setBg} />
              </div>
            </Field>
          </div>
        )}
      </div>
      {showCli && (
        <div className="flex items-center gap-2 border-t border-line-subtle bg-canvas px-4 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted ui-selectable" title={cmd}>
            {cmd}
          </code>
          <Button size="icon-xs" variant="ghost" onClick={() => void navigator.clipboard?.writeText(cmd)} title="Copy" aria-label="Copy command">
            <Copy />
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-line-subtle px-4 py-2.5">
        <Button size="xs" variant="ghost" data-active={showCli} onClick={() => setShowCli((v) => !v)} title="Show the equivalent claude command">
          <Terminal /> CLI
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={closeNewSession}>Cancel</Button>
        <Button size="sm" variant="default" onClick={submit}>
          Start <Shortcut keys={["mod", "⏎"]} className="ml-1 [&_kbd]:border-white/25 [&_kbd]:bg-white/15 [&_kbd]:text-white" />
        </Button>
      </div>
    </div>
  )
}

function ResumeList({ initialRepo }: { initialRepo?: ID }) {
  const [repoId, setRepoId] = useState<ID>(() => initialRepo ?? contextRepo())
  const [q, setQ] = useState("")
  const [fork, setFork] = useState(false)
  const sessions = useApp((s) => s.sessions)
  const structVersion = useApp((s) => s.structVersion)
  const repos = useApp((s) => s.repos)
  const list = useMemo(() => {
    const pq = prepareQuery(q)
    const repoName = repos[repoId]?.name ?? ""
    return (getApp().sessionIdsByRepo[repoId] ?? [])
      .map((id) => sessions[id])
      .filter((s) => s && (s.control === "history" || s.status === "idle"))
      .map((s) => ({ s, score: scoreSession(pq, s, repoName) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => (pq.tokens.length ? b.score - a.score : 0) || cmpIso(b.s.updatedAt, a.s.updatedAt))
      .slice(0, 80)
      .map((x) => x.s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, q, structVersion])
  const branchOf = (s: (typeof list)[number]) => repos[repoId]?.worktrees.find((w) => w.id === s.worktreeId)?.branch ?? repos[repoId]?.defaultBranch
  const [sel, setSel] = useState(0)
  const go = (id: ID) => {
    closeNewSession()
    if (fork) forkSession(id)
    else resumeSession(id)
  }
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-2.5">
        <div className="w-48"><RepoPicker value={repoId} onChange={setRepoId} /></div>
        <div className="relative flex h-7 flex-1 items-center">
          <Search size={13} className="absolute left-2 text-fg-faint" />
          <input
            autoFocus
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0) }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(list.length - 1, i + 1)) }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)) }
              if (e.key === "Enter" && list[sel]) go(list[sel].id)
            }}
            placeholder="Search"
            title="Title, prompt or branch"
            className="h-full w-full rounded-md border border-line-subtle bg-canvas pl-7 text-xs text-fg outline-none placeholder:text-fg-faint focus:border-line-strong"
          />
        </div>
      </div>
      <div className="max-h-[380px] overflow-y-auto py-1">
        {list.length === 0 && <div className="px-4 py-8 text-center text-xs text-fg-faint">No past sessions.</div>}
        {list.map((s, i) => (
          <button key={s.id} ref={i === sel ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined} onMouseEnter={() => setSel(i)} onClick={() => go(s.id)} className={cn("flex w-full items-start gap-3 px-4 py-1.5 text-left", i === sel && "bg-selected")}>
            <div className="min-w-0 flex-1" title={`${s.title}\n${branchOf(s)}`}>
              <div className="flex items-center gap-2">
                <span className="truncate text-[12.5px] text-fg">{s.title}</span>
                {s.archived && <span className="shrink-0 rounded-sm border border-line-subtle px-1 text-[10px] text-fg-faint">archived</span>}
              </div>
              {i === sel && <div className="truncate text-[11px] text-fg-faint">{s.firstPrompt}</div>}
            </div>
            <span className="tabular shrink-0 pt-px text-[11px] text-fg-faint">{relTime(s.updatedAt)}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line-subtle px-4 py-2.5">
        <label className="flex items-center gap-1.5 text-xs text-fg-muted" title="Fork instead of resume (--fork-session)">
          <Switch checked={fork} onCheckedChange={setFork} />
          Fork
        </label>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={closeNewSession}>Cancel</Button>
        <Button size="sm" variant="default" disabled={!list[sel]} onClick={() => list[sel] && go(list[sel].id)}>
          {fork ? <GitFork /> : <Play />} {fork ? "Fork" : "Resume"}
        </Button>
      </div>
    </div>
  )
}
