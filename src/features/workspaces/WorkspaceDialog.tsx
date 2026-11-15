// A workspace is a set of repositories ("Work" = the four repos of the day job). This dialog picks
// them: every repository you have sessions in is listed, here or in the cloud, one row per
// repository however many checkouts and worktrees it has; "Add folder" lists the repos inside a
// folder you name. Sessions of a picked repo show in the workspace wherever they run.
import { useMemo, useState } from "react"
import { Check, Cloud, FolderGit2, FolderPlus, Layers, Search, Server } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getApp, useApp, type Workspace } from "@/store/app"
import { patchSettings } from "@/store/actions"
import { folderKey, gitByFolder } from "@/backend/ext"
import { readGit } from "@/backend/git"
import { homePath } from "@/lib/format"
import { cn } from "@/lib/utils"

interface Candidate {
  key: string
  name: string
  /** "owner/name" as GitHub spells it */
  slug?: string
  /** an "every repo of this owner" row: how many of its repos are known */
  owner?: number
  /** a checkout on this computer */
  path?: string
  machine?: string
  sessions: number
}

function useCandidates(extra: Candidate[]) {
  const repos = useApp((s) => s.repos)
  const byRepo = useApp((s) => s.sessionIdsByRepo)
  return useMemo(() => {
    const out = new Map<string, Candidate>()
    for (const r of Object.values(repos)) {
      if (!r.id.startsWith("repo:")) continue
      const key = r.id.slice(5)
      out.set(key, { key, name: r.name, slug: r.slug, path: r.machine ? undefined : r.rootPath, machine: r.machine, sessions: byRepo[r.id]?.length ?? 0 })
    }
    for (const c of extra) if (!out.has(c.key)) out.set(c.key, c)
    const list = [...out.values()].sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name))
    // every repo of an owner (an account or an org): new repos and cloud sessions join by themselves
    const owners = new Map<string, { n: number; name: string }>()
    for (const c of list) {
      const m = /^(github\.com\/[^/]+)\//.exec(c.key)
      if (!m) continue
      const o = owners.get(m[1]) ?? { n: 0, name: m[1].split("/")[1] }
      o.n++
      // GitHub's spelling of the owner ("acme"), when a repo knows it
      if (c.slug?.includes("/")) o.name = c.slug.split("/")[0]
      owners.set(m[1], o)
    }
    const ownerRows: Candidate[] = [...owners.entries()]
      .filter(([, o]) => o.n >= 2)
      .map(([k, o]) => ({ key: `${k}/*`, name: `Every repo of ${o.name}`, slug: `${o.name}/*`, sessions: 0, owner: o.n }))
    return [...ownerRows, ...list]
  }, [repos, byRepo, extra])
}

export function WorkspaceDialog({ open, onOpenChange, edit }: { open: boolean; onOpenChange: (o: boolean) => void; edit?: Workspace }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px] gap-0 border-border bg-muted p-0 sm:max-w-[600px]">
        <DialogTitle className="px-5 pt-4 pb-3 text-sm">{edit ? `Edit ${edit.name}` : "New workspace"}</DialogTitle>
        {open && <Editor edit={edit} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function Editor({ edit, onDone }: { edit?: Workspace; onDone: () => void }) {
  const [name, setName] = useState(edit?.name ?? "")
  const [picked, setPicked] = useState<Set<string>>(() => new Set((edit?.repos ?? []).map((r) => r.key)))
  const [query, setQuery] = useState("")
  const [extra, setExtra] = useState<Candidate[]>(() => (edit?.repos ?? []).map((r) => ({ key: r.key, name: r.name, path: r.path, sessions: 0 })))
  const [folder, setFolder] = useState("")
  const [adding, setAdding] = useState(false)
  const [note, setNote] = useState<string>()
  const all = useCandidates(extra)
  // the main folder: one agent for all the repos (empty = the folder that holds them)
  const [homeDir, setHomeDir] = useState(edit?.home ?? "")
  const derivedHome = useMemo(() => {
    const paths = all.filter((c) => picked.has(c.key) && c.path).map((c) => homePath(c.path!).split("/"))
    if (paths.length < 2) return undefined
    const out: string[] = []
    for (let i = 0; i < paths[0].length; i++) {
      if (paths.every((p) => p[i] === paths[0][i])) out.push(paths[0][i])
      else break
    }
    const dir = out.join("/")
    return dir && dir !== "~" ? dir : undefined
  }, [all, picked])
  const q = query.trim().toLowerCase()
  const shown = q ? all.filter((c) => `${c.name} ${c.key} ${c.path ?? ""}`.toLowerCase().includes(q)) : all

  const toggle = (key: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  /** The repositories inside a folder: listed and picked. */
  const addFolder = async () => {
    const path = folder.trim()
    if (!path) return
    setAdding(true)
    setNote(undefined)
    try {
      const paths = await invoke<string[]>("workspace_repos", { roots: [path] })
      if (!paths.length) {
        setNote("No git repositories in that folder.")
        return
      }
      await readGit(paths)
      const found: Candidate[] = paths.map((p) => {
        const g = gitByFolder.get(folderKey(undefined, p))
        const key = g?.remote ?? `path:${g?.root ?? p}`
        return { key, name: g?.remoteName ?? p.split("/").pop() ?? p, path: g?.root ?? p, sessions: 0 }
      })
      setExtra((e) => [...e, ...found])
      setPicked((s) => new Set([...s, ...found.map((f) => f.key)]))
      setFolder("")
    } catch (e) {
      setNote(String(e))
    } finally {
      setAdding(false)
    }
  }

  const save = () => {
    const nm = name.trim()
    if (!nm || !picked.size) return
    const byKey = new Map(all.map((c) => [c.key, c]))
    const repos = [...picked].map((key) => {
      const c = byKey.get(key)
      return { key, name: c?.name ?? key.split("/").pop() ?? key, ...(c?.path ? { path: homePath(c.path) } : {}) }
    })
    const st = getApp().settings
    if (edit) {
      patchSettings({ workspaces: st.workspaces.map((w) => (w.id === edit.id ? { ...w, name: nm, repos, folders: undefined, home: homeDir.trim() || undefined } : w)) })
    } else {
      const id = `${nm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ws"}-${Date.now().toString(36).slice(-4)}`
      patchSettings({ workspaces: [...st.workspaces, { id, name: nm, repos, ...(homeDir.trim() ? { home: homeDir.trim() } : {}) }], workspace: id })
    }
    onDone()
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pb-3">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, like Work" className="h-9 text-sm" aria-label="Workspace name" />
      </div>
      <div className="border-y border-border">
        <div className="flex items-center gap-2 px-5 py-2">
          <Search size={13} className="shrink-0 text-muted-foreground/70" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a repository" className="h-7 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70" aria-label="Find a repository" />
          <span className="tabular shrink-0 text-xs text-muted-foreground/70">{picked.size} picked</span>
        </div>
        <ul className="max-h-[320px] overflow-y-auto px-2 pb-2" aria-label="Repositories">
          {shown.map((c) => {
            const on = picked.has(c.key)
            const Icon = c.machine === "cloud" ? Cloud : c.machine ? Server : FolderGit2
            return (
              <li key={c.key}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(c.key)}
                  className={cn("flex h-10 w-full min-w-0 items-center gap-3 rounded-md px-3 text-left outline-none hover:bg-accent focus-visible:bg-accent", on && "bg-accent/60")}
                >
                  <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-md border", on ? "border-foreground bg-foreground text-background" : "border-input")}>{on && <Check size={11} strokeWidth={3} />}</span>
                  <Icon size={14} className="shrink-0 text-muted-foreground/70" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{c.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground/70">{c.key.startsWith("path:") ? homePath(c.key.slice(5)) : c.slug ? `github.com/${c.slug}` : c.key}</span>
                  </span>
                  {c.owner ? <span className="tabular shrink-0 text-xs text-muted-foreground/70">{c.owner} repos and new ones</span> : c.sessions > 0 && <span className="tabular shrink-0 text-xs text-muted-foreground/70">{c.sessions} sessions</span>}
                </button>
              </li>
            )
          })}
          {!shown.length && <li className="px-3 py-6 text-center text-xs text-muted-foreground/70">{q ? "No repository matches." : "No repositories yet: add a folder below."}</li>}
        </ul>
      </div>
      <form
        className="flex items-center gap-2 px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          void addFolder()
        }}
      >
        <FolderPlus size={14} className="shrink-0 text-muted-foreground/70" />
        <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Add the repos in a folder, like ~/work" className="h-8 flex-1 font-mono text-xs placeholder:font-sans" aria-label="Folder with repositories" spellCheck={false} autoCapitalize="off" />
        <Button size="sm" variant="outline" type="submit" disabled={!folder.trim() || adding}>
          {adding ? "Looking…" : "Add"}
        </Button>
      </form>
      {note && <p className="-mt-1 px-5 pb-2 text-xs text-muted-foreground/70">{note}</p>}
      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <Layers size={14} className="shrink-0 text-muted-foreground/70" />
        <label htmlFor="ws-home" className="shrink-0 text-xs text-muted-foreground" title="Sessions started in this folder work across all the workspace's repos at once">
          Main folder
        </label>
        <Input id="ws-home" value={homeDir} onChange={(e) => setHomeDir(e.target.value)} placeholder={derivedHome ?? "the folder that holds the repos"} className="h-8 flex-1 font-mono text-xs placeholder:font-sans" spellCheck={false} autoCapitalize="off" />
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={!name.trim() || !picked.size}>
          {edit ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  )
}
