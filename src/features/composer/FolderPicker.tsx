// Folder control on New session (Claude Code desktop: "Recent / Open folder…").
// One searchable list: recent projects first, then any folder by path, then each VPS machine
// (Settings → Machines) with its folders and a typed path there. Picking a folder that is not a
// project yet adds it as one, so a session can start in any directory, here or on a machine.
import { useMemo, useState } from "react"
import { ChevronDown, FolderGit2, FolderOpen, Server } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { getApp, useApp } from "@/store/app"
import { repoInView } from "@/store/selectors"
import { addRepoFromPath } from "@/store/actions"
import { LOCAL_FOLDERS } from "@/mocks/catalog"
import { REAL } from "@/backend/mode"
import { recentFolders } from "@/backend/real"
import { homePath } from "@/lib/format"
import type { ID } from "@/lib/model"

export function FolderPicker({ value, onChange }: { value: ID; onChange: (id: ID) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const repos = useApp((s) => s.repos)
  const order = useApp((s) => s.repoOrder)
  const sessions = useApp((s) => s.sessions)
  const byRepo = useApp((s) => s.sessionIdsByRepo)
  // most recently used projects first (Claude Code desktop keeps 8)
  const machines = useApp((s) => s.settings.machines)
  const recent = useMemo(() => {
    const last = (id: ID) => (byRepo[id] ?? []).reduce((m, sid) => (sessions[sid]?.updatedAt > m ? sessions[sid].updatedAt : m), "")
    const st = getApp()
    return [...order].filter((id) => !repos[id].machine && repoInView(st, id)).sort((a, b) => last(b).localeCompare(last(a))).slice(0, 8)
  }, [order, byRepo, sessions, repos])
  const tracked = new Set(order.filter((id) => !repos[id].machine).map((id) => homePath(repos[id].rootPath)))
  // the desktop app offers the folders you used Claude Code in; the mock world its sample disk
  const folders = (REAL ? recentFolders().map(homePath) : LOCAL_FOLDERS).filter((f) => !tracked.has(f)).slice(0, 12)
  const typed = query.trim()
  const looksLikePath = typed.startsWith("~/") || typed.startsWith("/")
  const pick = (id: ID) => {
    onChange(id)
    setOpen(false)
    setQuery("")
  }
  const name = repos[value] ? (repos[value].machine ? `${repos[value].machine}: ${repos[value].name}` : repos[value].name) : "Choose folder"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Folder: ${name}`}
          title={repos[value] ? homePath(repos[value].rootPath) : undefined}
          className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          {repos[value]?.machine ? <Server size={13} className="shrink-0 text-muted-foreground/70" /> : <FolderGit2 size={13} className="shrink-0 text-muted-foreground/70" />}
          <span className="truncate">{name}</span>
          <ChevronDown size={12} className="shrink-0 text-muted-foreground/70" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-[320px] border border-border bg-muted p-0 shadow-[0_10px_28px_rgba(0,0,0,0.5)] ring-0">
        <Command>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Find a project or type a path" className="h-9 text-sm" />
          <CommandList className="max-h-72">
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground/70">No folder matches.</CommandEmpty>
            <CommandGroup heading="Recent">
              {recent.map((id) => (
                <CommandItem key={id} value={`${repos[id].name} ${homePath(repos[id].rootPath)}`} onSelect={() => pick(id)} className="text-sm">
                  <FolderGit2 size={14} className="text-muted-foreground/70" />
                  <span className="truncate">{repos[id].name}</span>
                  <span className="ml-auto truncate font-mono text-xs text-muted-foreground/70">{homePath(repos[id].rootPath)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Open folder">
              {looksLikePath && !tracked.has(typed) && !folders.includes(typed) && (
                <CommandItem value={`open ${typed}`} onSelect={() => pick(addRepoFromPath(typed))} className="text-sm">
                  <FolderOpen size={14} className="text-muted-foreground/70" />
                  <span className="truncate font-mono text-xs">{typed}</span>
                </CommandItem>
              )}
              {folders.map((f) => (
                <CommandItem key={f} value={`open ${f}`} onSelect={() => pick(addRepoFromPath(f))} className="text-sm">
                  <FolderOpen size={14} className="text-muted-foreground/70" />
                  <span className="truncate font-mono text-xs">{f}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {machines.map(({ host }) => {
              const there = order.filter((id) => repos[id].machine === host && repos[id].rootPath !== "~")
              return (
                <CommandGroup key={host} heading={`On ${host}`}>
                  {there.map((id) => (
                    <CommandItem key={id} value={`${host} ${repos[id].name} ${repos[id].rootPath}`} onSelect={() => pick(id)} className="text-sm">
                      <Server size={14} className="text-muted-foreground/70" />
                      <span className="truncate">{repos[id].name}</span>
                      <span className="ml-auto truncate font-mono text-xs text-muted-foreground/70">{repos[id].rootPath}</span>
                    </CommandItem>
                  ))}
                  {looksLikePath && (
                    <CommandItem value={`${host} open ${typed}`} onSelect={() => pick(addRepoFromPath(typed, host))} className="text-sm">
                      <FolderOpen size={14} className="text-muted-foreground/70" />
                      <span className="truncate font-mono text-xs">
                        {host}:{typed}
                      </span>
                    </CommandItem>
                  )}
                  {!there.length && !looksLikePath && (
                    <CommandItem value={`${host} type a path`} disabled className="text-xs text-muted-foreground/70">
                      Type a path like ~/repo to start there
                    </CommandItem>
                  )}
                </CommandGroup>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
