// New session as a screen, like the Claude Code desktop app: the prompt box is the
// main element; the row under it picks the folder (recent projects or any folder), worktree, mode,
// model and effort. More options (title, agent, MCP servers, instructions, background, the
// equivalent CLI command) fold away; past sessions of the folder can be resumed right below.
// Field set mirrors the claude flags, after coollabsio/jean@1d53d3c session
// settings (Apache-2.0, ideas).
import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Copy, GitBranch, History, Play, Search } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getApp, useApp } from "@/store/app"
import { selectNeedsYouCount, selectStatusCounts } from "@/store/selectors"
import { createSession, openPalette, openSession, resumeSession } from "@/store/actions"
import { MOD } from "@/components/common/bits"
import { relTime } from "@/lib/format"
import type { Effort, ID, PermissionMode } from "@/lib/model"
import { cn } from "@/lib/utils"
import { PromptBox } from "@/features/composer/PromptBox"
import { EffortPicker, ModePicker, ModelExtras, ModelPicker } from "@/features/composer/Pickers"
import { FolderPicker } from "@/features/composer/FolderPicker"

const AGENTS = ["none", "code-reviewer", "test-runner", "migration-writer"]
const MCP = [
  { id: "graphify", label: "graphify", note: "code graph" },
  { id: "github", label: "github", note: "PRs, issues" },
  { id: "linear", label: "linear", note: "tickets" },
]

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 4).join("-")
}

/** Default folder: the one asked for, else the project of the session last opened, else the first. */
function startRepo(repoId?: ID): ID {
  const st = getApp()
  const usable = (r?: ID | null): r is ID => !!r && !!st.repos[r] && st.repos[r].machine !== "cloud"
  if (usable(repoId)) return repoId
  const last = st.recent.map((id) => st.sessions[id]?.repoId).find(usable)
  return last ?? st.repoOrder.find(usable) ?? st.repoOrder[0]
}

/**
 * How much already waits on you. Supervising more automated tasks at once helps only while you keep up
 * with them: performance falls off once attending them fills most of your time (Cummings & Guerlain
 * 2007), so with several waiting the screen says so before you add another.
 */
function Load() {
  const waiting = useApp(selectNeedsYouCount)
  const working = useApp((s) => selectStatusCounts(s).working)
  if (waiting < 2) return null
  return (
    <p className="text-sm text-muted-foreground">
      {waiting} sessions are waiting for you{working ? ` and ${working} are working` : ""}. Answering those first (<kbd className="font-sans">{MOD}+J</kbd>) keeps them moving.
    </p>
  )
}

export default function NewSessionView({ repoId: asked }: { repoId?: ID }) {
  const defaults = useApp((s) => s.settings.defaults)
  const repos = useApp((s) => s.repos)
  const repoOrder = useApp((s) => s.repoOrder)
  const [repoId, setRepoId] = useState<ID>(() => startRepo(asked))
  const [worktree, setWorktree] = useState(defaults.worktree)
  const [model, setModel] = useState(defaults.model)
  const [effort, setEffort] = useState<Effort>(defaults.effort)
  // your claude's default permission mode wins over the app's (Settings → New sessions)
  const capsMode = useApp((s) => s.caps?.defaultMode)
  const fromCaps = (m?: string) => (m === "manual" ? "default" : (m as PermissionMode | undefined))
  const [pickedMode, setMode] = useState<PermissionMode | null>(null)
  // until you pick one, the mode follows your claude's default (which may arrive after this opens)
  const mode = pickedMode ?? fromCaps(capsMode) ?? defaults.permissionMode
  const [fast, setFast] = useState(false)
  const [ultra, setUltra] = useState(false)
  const [style, setStyle] = useState("default")
  const [addDirs, setAddDirs] = useState<ID[]>([])
  const [more, setMore] = useState(false)
  const [title, setTitle] = useState("")
  const [agent, setAgent] = useState("none")
  const [mcp, setMcp] = useState<Record<string, boolean>>({ graphify: true, github: true, linear: false })
  const [append, setAppend] = useState("")
  const [bg, setBg] = useState(false)
  const files = useApp((s) => s.repoSpecs[repoId]?.files)
  const repo = repos[repoId]
  const branchName = `wt/${slug(title) || "new-session"}`

  const cmd = useMemo(() => {
    const parts = ["claude"]
    if (bg) parts.push("--bg")
    if (worktree) parts.push(`-w ${slug(title) || "<auto>"}`)
    parts.push(`--model ${model.replace("claude-", "").replace(/-(\d)-(\d)$/, "-$1.$2")}`, `--effort ${effort}`)
    if (mode !== "default") parts.push(`--permission-mode ${mode}`)
    for (const r of addDirs) parts.push(`--add-dir ${repos[r]?.rootPath.replace(/^\/home\/[^/]+/, "~")}`)
    if (agent !== "none") parts.push(`--agent ${agent}`)
    if (append.trim()) parts.push(`--append-system-prompt "…"`)
    if (title.trim()) parts.push(`-n "${title.trim()}"`)
    return parts.join(" ")
  }, [bg, worktree, title, model, effort, mode, addDirs, agent, append, repos])

  const start = (prompt: string, attachments: string[]) => {
    const id = createSession({
      repoId,
      where: worktree && !repo?.isHome ? "worktree-new" : "main",
      worktreeName: slug(title || prompt) || "new-session",
      title: title.trim() || undefined,
      prompt: attachments.length ? `${prompt}\n\n${attachments.map((a) => `[attached: ${a}]`).join("\n")}` : prompt,
      model,
      effort,
      permissionMode: mode,
      additionalRepoIds: addDirs,
      background: bg,
      fastMode: fast,
      ultracode: ultra,
      outputStyle: style,
    })
    if (!bg) openSession(id)
  }

  return (
    <div data-new-session className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[880px] flex-col gap-8 px-6 pt-[12vh] pb-16">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-medium text-foreground">
            New session <span className="text-muted-foreground/70">in {repo?.name ?? "…"}{repo?.isHome ? " · all repos" : ""}{repo?.machine ? ` on ${repo.machine}` : ""}</span>
          </h1>
          <Load />
        </div>
        <PromptBox
          key={repoId}
          size="lg"
          autoFocus
          files={files ?? []}
          placeholder="What should Claude do?"
          keysHint="Enter starts the session, Shift+Enter adds a line. Slash for commands, at sign to mention a file."
          sendHint="Start · Enter"
          onSubmit={(text, attachments) => start(text, attachments)}
          folders={{
            candidates: repoOrder.filter((id) => id !== repoId).map((id) => ({ id, name: repos[id].name })),
            added: addDirs,
            onAdd: (id) => setAddDirs((d) => [...d, id]),
            onRemove: (id) => setAddDirs((d) => d.filter((x) => x !== id)),
          }}
          footer={
            <>
              <FolderPicker value={repoId} onChange={(id) => { setRepoId(id); setAddDirs((d) => d.filter((x) => x !== id)) }} />
              {/* a workspace's main folder is not a repository: no worktree there */}
              {!repo?.isHome && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={worktree}
                    onClick={() => setWorktree((v) => !v)}
                    className={cn(
                      "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
                      worktree ? "text-foreground" : "text-muted-foreground/70 hover:text-muted-foreground",
                    )}
                  >
                    <GitBranch size={13} className="shrink-0 text-muted-foreground/70" />
                    {worktree ? <span className="truncate font-mono text-xs">{branchName}</span> : "Worktree off"}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-72">
                  {worktree ? `Own worktree in ${repo?.name}/.claude/worktrees, so parallel sessions don't collide. Click to work in the main checkout.` : "Works in the main checkout. Click to give this session its own worktree."}
                </TooltipContent>
              </Tooltip>
              )}
              <span className="flex-1" />
              <ModelPicker
                value={model}
                onChange={setModel}
                extra={
                  <ModelExtras
                    model={model}
                    fast={fast}
                    ultra={ultra}
                    style={style}
                    onChange={(p) => {
                      if (p.fastMode !== undefined) setFast(p.fastMode)
                      if (p.ultracode !== undefined) setUltra(p.ultracode)
                      if (p.outputStyle !== undefined) setStyle(p.outputStyle)
                    }}
                  />
                }
              />
              <EffortPicker value={effort} model={model} onChange={setEffort} />
              <ModePicker value={mode} onChange={setMode} />
            </>
          }
        />

        <div className="-mt-4 flex flex-col gap-3">
          <button
            className="flex h-7 items-center gap-1 self-start rounded-md pr-2 text-xs text-muted-foreground/70 hover:text-muted-foreground"
            onClick={() => setMore((v) => !v)}
            aria-expanded={more}
          >
            {more ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            More options
          </button>
          {more && (
            <div className="grid grid-cols-[110px_1fr] items-center gap-x-4 gap-y-3 rounded-lg border border-border px-4 py-4">
              <label htmlFor="ns-title" className="text-xs text-muted-foreground">Title</label>
              <input id="ns-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Named from the prompt" className="h-8 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-input" />
              <span className="text-xs text-muted-foreground">Agent</span>
              <Select value={agent} onValueChange={setAgent}>
                <SelectTrigger size="sm" className="h-8 w-48 text-sm" aria-label="Agent"><SelectValue /></SelectTrigger>
                <SelectContent>{AGENTS.map((a) => <SelectItem key={a} value={a} className="text-sm">{a === "none" ? "None" : a}</SelectItem>)}</SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">MCP servers</span>
              <div className="flex flex-wrap gap-4">
                {MCP.map((m) => (
                  <label key={m.id} className="flex items-center gap-1.5 text-xs text-muted-foreground" title={m.note}>
                    <Switch checked={!!mcp[m.id]} onCheckedChange={(v) => setMcp({ ...mcp, [m.id]: v })} />
                    {m.label}
                  </label>
                ))}
              </div>
              <label htmlFor="ns-append" className="self-start pt-1.5 text-xs text-muted-foreground">Instructions</label>
              <textarea id="ns-append" value={append} onChange={(e) => setAppend(e.target.value)} rows={2} placeholder="Added to the system prompt" className="resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-input" />
              <span className="text-xs text-muted-foreground">Background</span>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={bg} onCheckedChange={setBg} aria-label="Run in the background" />
                Start without opening it
              </label>
              <span className="text-xs text-muted-foreground">CLI</span>
              <div className="flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded-md bg-card px-2.5 py-1.5 font-mono text-xs text-muted-foreground" title={cmd}>
                  {cmd}
                </code>
                <Button size="icon-sm" variant="ghost" aria-label="Copy command" onClick={() => void navigator.clipboard?.writeText(cmd).catch(() => undefined)}>
                  <Copy />
                </Button>
              </div>
            </div>
          )}
        </div>

        <PastSessions repoId={repoId} />
      </div>
    </div>
  )
}

/** Past sessions of the folder: Resume continues one (`claude --resume`). */
function PastSessions({ repoId }: { repoId: ID }) {
  const structVersion = useApp((s) => s.structVersion)
  const name = useApp((s) => s.repos[repoId]?.name)
  const list = useMemo(() => {
    void structVersion
    const s = getApp()
    return (s.sessionIdsByRepo[repoId] ?? [])
      .map((id) => s.sessions[id])
      .filter((x) => x && x.control === "history" && !x.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5)
  }, [repoId, structVersion])
  if (!list.length) return null
  return (
    <section className="flex flex-col gap-1" aria-label={`Past sessions in ${name}`}>
      <div className="flex items-center gap-2 pb-1">
        <History size={13} className="text-muted-foreground/70" />
        <h2 className="text-xs font-medium text-muted-foreground/70">Past sessions in {name}</h2>
        <button className="ml-auto flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-muted-foreground" onClick={() => openPalette()} title={`Search all · ${MOD}+K`}>
          <Search size={12} /> Search all
        </button>
      </div>
      {list.map((x) => (
        <div key={x.id} className="group/past flex h-9 items-center gap-3 rounded-md px-2 hover:bg-accent">
          <button onClick={() => openSession(x.id)} className="min-w-0 flex-1 truncate text-left text-sm text-muted-foreground group-hover/past:text-foreground">
            {x.title}
          </button>
          <span className="tabular shrink-0 text-xs text-muted-foreground/70">{relTime(x.updatedAt)}</span>
          <Button size="xs" variant="ghost" className="opacity-0 group-hover/past:opacity-100 focus-visible:opacity-100" onClick={() => resumeSession(x.id)}>
            <Play /> Resume
          </Button>
        </div>
      ))}
    </section>
  )
}
