// Cross-repo task — UI_PLAN §5.8. The main agent plans per-repo changes and
// delegates one session per repo. Patterns: Nimbalyst meta-agent (MIT), agent-deck
// conductor (MIT), Orca orchestration Run→Task→Dispatch (MIT), AoE multi-repo workspace (MIT).
// Real mechanism later: a Claude Code session with --add-dir per repo + Graphify global MCP
// + cross-session messaging (RESEARCH §1.2).
import { useMemo, useState } from "react"
import { FolderGit2, Network, Link2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { getApp, useApp } from "@/store/app"
import { createSession, openCrossRepo, openSession, sendMessage } from "@/store/actions"
import type { ID } from "@/lib/model"
import { cn } from "@/lib/utils"

export default function CrossRepoDialog() {
  const order = useApp((s) => s.repoOrder)
  const repos = useApp((s) => s.repos)
  const links = useApp((s) => s.links)
  // start from what you were looking at (a selected repo, or the repo of a selected session), not
  // from a fixed default you'd have to untick
  const [selected, setSelected] = useState<ID[]>(() => {
    const st = getApp()
    const sel = st.selection
    const id = sel?.kind === "repo" ? sel.id : sel?.kind === "session" ? st.sessions[sel.id]?.repoId : null
    return id && st.repos[id] ? [id] : []
  })
  const [task, setTask] = useState("")
  const [planFirst, setPlanFirst] = useState(true)
  const [worktrees, setWorktrees] = useState(true)

  const suggested = useMemo(() => {
    const set = new Map<ID, string>()
    for (const l of links) {
      if (selected.includes(l.from) && !selected.includes(l.to)) set.set(l.to, `${l.kind} · ${repos[l.from].name}`)
      if (selected.includes(l.to) && !selected.includes(l.from)) set.set(l.from, `${l.kind} · ${repos[l.to].name}`)
    }
    return set
  }, [links, selected, repos])

  const start = () => {
    if (!task.trim() || !selected.length) return
    const main = getApp().mainSessionId
    sendMessage(main, `Cross-repo task for ${selected.map((r) => repos[r].name).join(", ")}:\n\n${task.trim()}${planFirst ? "\n\nPlan per repo first and wait for my approval before delegating." : ""}`, "now")
    if (!planFirst) {
      for (const r of selected) {
        createSession({
          repoId: r,
          where: worktrees ? "worktree-new" : "main",
          prompt: task.trim(),
          title: `${task.trim().split(/[.\n]/)[0].slice(0, 48)} (${repos[r].name})`,
          model: getApp().settings.defaults.model,
          effort: "high",
          permissionMode: "default",
          additionalRepoIds: [],
          background: false,
          parent: { sessionId: main, kind: "delegated" },
        })
      }
    }
    openCrossRepo(false)
    openSession(main)
  }

  const toggle = (id: ID) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <Dialog open onOpenChange={(o) => !o && openCrossRepo(false)}>
      <DialogContent className="top-[10%] max-w-[720px] translate-y-0 gap-0 border-line bg-elevated p-0 shadow-[0_16px_48px_rgba(0,0,0,0.55)] sm:max-w-[720px]">
        <div className="flex items-center gap-2.5 border-b border-line-subtle px-4 py-3">
          <Network size={15} className="text-fg-faint" />
          <div>
            <DialogTitle className="text-sm font-medium" title="The main agent plans per repo, then delegates one session per repo and reports back when all are done.">
              Cross-repo task
            </DialogTitle>
            <DialogDescription className="sr-only">
              Change one shared thing in several repos. The main agent plans per repo, then delegates one session per repo and reports back when all are done.
            </DialogDescription>
          </div>
        </div>
        <div className="grid grid-cols-[260px_1fr]">
          <div className="max-h-[420px] overflow-y-auto border-r border-line-subtle py-2">
            <div className="flex h-6 items-center gap-1.5 px-3">
              <span className="section-label">Repos</span>
              <span className="tabular text-[11px] text-fg-faint">{selected.length}</span>
            </div>
            {order.map((id) => {
              const sug = suggested.get(id)
              return (
                <label key={id} className="flex h-7 cursor-default items-center gap-2 px-3 hover:bg-hover/60">
                  <Checkbox checked={selected.includes(id)} onCheckedChange={() => toggle(id)} className="size-3.5" />
                  <FolderGit2 size={13} className="text-fg-faint" />
                  <span className={cn("truncate text-xs", selected.includes(id) ? "text-fg" : "text-fg-muted")}>{repos[id].name}</span>
                  {sug && (
                    <span className="ml-auto flex shrink-0 items-center text-fg-faint" title={`Linked: ${sug}`} aria-label="Linked">
                      <Link2 size={11} />
                    </span>
                  )}
                </label>
              )
            })}
          </div>
          <div className="flex flex-col gap-3 p-4">
            <textarea
              autoFocus
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={7}
              placeholder="What should change everywhere?"
              className="w-full flex-1 resize-none rounded-md border border-line bg-canvas px-2.5 py-2 text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-faint focus:border-line-strong"
            />
            <label className="flex h-7 items-center justify-between gap-3 text-xs" title="The main agent writes a per-repo checklist first and waits for your approval">
              <span className="text-fg">Plan first</span>
              <Switch checked={planFirst} onCheckedChange={setPlanFirst} />
            </label>
            <label className="flex h-7 items-center justify-between gap-3 text-xs" title="Each delegated session works on its own branch">
              <span className="text-fg">Worktree per repo</span>
              <Switch checked={worktrees} onCheckedChange={setWorktrees} />
            </label>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-line-subtle px-4 py-2.5">
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => openCrossRepo(false)}>Cancel</Button>
          <Button size="sm" variant="default" disabled={!task.trim() || !selected.length} onClick={start} title="Runs in the main agent with --add-dir for each repo">
            {planFirst ? "Plan" : `Delegate (${selected.length})`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
