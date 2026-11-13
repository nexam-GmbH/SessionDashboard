// Command palette — UI_PLAN §5.9. shadcn Command (cmdk, MIT); structure after
// Yaak CommandPaletteDialog.tsx (MIT) and Orca's worktree-jump palette (MIT):
// recents on top, groups, prefix modes (> commands, @ sessions, # repos), own fuzzy
// search with shouldFilter={false} so thousands of sessions stay fast.
import { useDeferredValue, useMemo, useState } from "react"
import { Command as Cmdk } from "cmdk"
import { FolderGit2, Search, CornerDownLeft, ArrowUpDown } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { getApp, useApp } from "@/store/app"
import { closePalette, openRepo, openSession } from "@/store/actions"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { Kbd, Shortcut } from "@/components/common/bits"
import { STATUS_TIER } from "@/lib/status"
import { relTime } from "@/lib/format"
import { prepareQuery, scoreSession } from "@/features/sessions/search"
import type { Session } from "@/lib/model"
import { COMMANDS, fuzzyScore } from "./commands"

export default function CommandPalette() {
  const prefix = useApp((s) => s.palettePrefix)
  const [raw, setRaw] = useState(prefix)
  const mode = raw.startsWith(">") ? "commands" : raw.startsWith("@") ? "sessions" : raw.startsWith("#") ? "repos" : "all"
  const query = mode === "all" ? raw.trim() : raw.slice(1).trim()

  // Deferred so typing never waits for the 5k-session scan (stress fixture).
  const deferred = useDeferredValue(query)
  const { sessions, repos, commands } = useMemo(() => {
    const s = getApp()
    const q = deferred
    const cmds = COMMANDS.filter((c) => !c.when || c.when())
      .map((c) => ({ c, score: fuzzyScore(q, `${c.title} ${c.keywords ?? ""} ${c.group}`) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c)
    // top-k without sorting every match: keep a small sorted buffer
    const limit = q ? 12 : 8
    const pq = prepareQuery(q)
    const top: { x: Session; repo: string; rank: number }[] = []
    for (const id in s.sessions) {
      const x = s.sessions[id]
      if (!q && (x.control === "history" || x.archived)) continue
      const repo = x.repoId ? (s.repos[x.repoId]?.name ?? "") : "main"
      let rank: number
      if (q) {
        const score = scoreSession(pq, x, repo)
        if (!score) continue
        // live sessions above history, archived last; recency breaks ties
        rank = score + (x.archived ? -60 : x.control === "history" ? -20 : 0) + Date.parse(x.updatedAt) / 1e13
      } else {
        rank = -STATUS_TIER[x.status] * 1e3 + Date.parse(x.updatedAt) / 1e10
      }
      if (top.length === limit && rank <= top[limit - 1].rank) continue
      top.push({ x, repo, rank })
      top.sort((a, b) => b.rank - a.rank)
      if (top.length > limit) top.pop()
    }
    const rps = s.repoOrder
      .map((id) => ({ r: s.repos[id], score: fuzzyScore(q, s.repos[id].name) }))
      .filter((v) => v.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, q ? 6 : 5)
    return { sessions: top, repos: rps, commands: cmds.slice(0, q ? 12 : 8) }
  }, [deferred])

  const run = (fn: () => void) => {
    closePalette()
    fn()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && closePalette()}>
      <DialogContent
        showCloseButton={false}
        className="top-[14%] max-w-[640px] translate-y-0 gap-0 overflow-hidden border-line bg-elevated p-0 shadow-[0_16px_48px_rgba(0,0,0,0.55)] sm:max-w-[640px]"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Cmdk shouldFilter={false} loop className="flex flex-col" label="Command palette">
          <div className="flex h-10 items-center gap-2 border-b border-line-subtle px-3">
            <Search size={14} className="shrink-0 text-fg-faint" />
            <Cmdk.Input
              autoFocus
              value={raw}
              onValueChange={setRaw}
              placeholder="Search sessions and repos"
              title="> commands · @ sessions · # repos"
              className="h-full flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint"
            />
          </div>
          <Cmdk.List className="max-h-[min(440px,60vh)] overflow-y-auto p-1">
            <Cmdk.Empty className="px-3 py-6 text-center text-xs text-fg-faint">No results.</Cmdk.Empty>
            {(mode === "all" || mode === "sessions") && sessions.length > 0 && (
              <Group heading={query ? "Sessions" : "Recent"}>
                {sessions.map(({ x, repo }) => (
                  <Item key={x.id} value={`s:${x.id}`} onSelect={() => run(() => openSession(x.id))}>
                    <StatusGlyph status={x.status} size="sm" animate={false} />
                    <span className="truncate text-fg">{x.title}</span>
                    <span className="shrink-0 text-[11px] text-fg-faint">{repo}</span>
                    {x.archived && <span className="shrink-0 rounded-sm border border-line-subtle px-1 text-[10px] text-fg-faint">archived</span>}
                    <span className="tabular ml-auto shrink-0 text-[11px] text-fg-faint">{relTime(x.updatedAt)}</span>
                  </Item>
                ))}
              </Group>
            )}
            {(mode === "all" || mode === "commands") && commands.length > 0 && (
              <Group heading="Commands">
                {commands.map((c) => (
                  <Item key={c.id} value={`c:${c.id}`} onSelect={() => run(c.run)}>
                    <span className="truncate text-fg">{c.title}</span>
                    {c.shortcut && <Shortcut keys={c.shortcut} className="ml-auto" />}
                  </Item>
                ))}
              </Group>
            )}
            {(mode === "all" || mode === "repos") && repos.length > 0 && (
              <Group heading="Repos">
                {repos.map(({ r }) => (
                  <Item key={r.id} value={`r:${r.id}`} onSelect={() => run(() => openRepo(r.id))}>
                    <FolderGit2 size={14} className="text-fg-faint" />
                    <span className="truncate text-fg">{r.name}</span>
                    <span className="ml-auto truncate font-mono text-[11px] text-fg-faint">{r.rootPath.replace(/^\/home\/[^/]+/, "~")}</span>
                  </Item>
                ))}
              </Group>
            )}
          </Cmdk.List>
          {/* §2.5: at most 3 hints */}
          <div className="flex h-7 items-center gap-3 border-t border-line-subtle px-3 text-[11px] text-fg-faint" title="@ sessions · # repos · Esc close">
            <span className="flex items-center gap-1"><Kbd><ArrowUpDown size={10} /></Kbd> navigate</span>
            <span className="flex items-center gap-1"><Kbd><CornerDownLeft size={10} /></Kbd> open</span>
            <span className="flex items-center gap-1"><Kbd>&gt;</Kbd> commands</span>
          </div>
        </Cmdk>
      </DialogContent>
    </Dialog>
  )
}

function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Cmdk.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:section-label pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1"
    >
      {children}
    </Cmdk.Group>
  )
}

function Item({ value, onSelect, children }: { value: string; onSelect: () => void; children: React.ReactNode }) {
  return (
    <Cmdk.Item
      value={value}
      onSelect={onSelect}
      className="flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[12.5px] data-[selected=true]:bg-selected"
    >
      {children}
    </Cmdk.Item>
  )
}
