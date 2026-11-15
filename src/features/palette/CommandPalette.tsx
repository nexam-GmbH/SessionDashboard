// Search (Ctrl+K). shadcn Command (cmdk, MIT); structure after Orca's worktree-jump palette (MIT,
// ideas): with an empty query it lists live sessions ranked by attention (needs you, then
// finished unseen, then recently opened), so Ctrl+K ⏎ goes where you are needed. Typing searches
// live sessions first, then a short group of past ones, then repos (new session there) and a few
// commands.
import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { Command as Cmdk } from "cmdk"
import { ArrowUpDown, CornerDownLeft, Plus, Search } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { getApp } from "@/store/app"
import { selectNeedsYou, selectSessionOrder, useShownStatus } from "@/store/selectors"
import { closePalette, openNewSession, openSession, takePaletteTypeAhead } from "@/store/actions"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { Kbd, Shortcut } from "@/components/common/bits"
import { relTime } from "@/lib/format"
import { matchScore } from "@/lib/match"
import { prepareQuery, scoreSession } from "@/lib/sessionSearch"
import type { Session } from "@/lib/model"
import { COMMANDS } from "./commands"

type Hit = { x: Session; repo: string }

export default function CommandPalette() {
  const [raw, setRaw] = useState("")
  // keys typed before the input had focus (see openPalette)
  useEffect(() => {
    const early = takePaletteTypeAhead()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time merge of buffered keystrokes on mount
    if (early) setRaw((r) => r + early)
  }, [])
  const query = useDeferredValue(raw.trim())

  const { live, past, repos, commands } = useMemo(() => {
    const s = getApp()
    const repoName = (x: Session) => (x.repoId ? (s.repos[x.repoId]?.name ?? "") : "main agent")
    const order = selectSessionOrder(s)
    let live: Hit[]
    let past: Hit[] = []
    if (!query) {
      // attention first, then what you had open most recently, then the rest in list order
      const needs = selectNeedsYou(s)
      const unseen = order.filter((id) => s.sessions[id].status === "done_unseen")
      const ranked = [...new Set([...needs, ...unseen, ...s.recent.filter((id) => order.includes(id)), ...order])]
      live = ranked.slice(0, 8).map((id) => ({ x: s.sessions[id], repo: repoName(s.sessions[id]) }))
    } else {
      const pq = prepareQuery(query)
      const scored = (ids: string[]) =>
        ids
          .map((id) => s.sessions[id])
          .map((x) => ({ x, repo: repoName(x), score: scoreSession(pq, x, repoName(x)) }))
          .filter((h) => h.score > 0)
          .sort((a, b) => b.score - a.score || b.x.updatedAt.localeCompare(a.x.updatedAt))
      live = scored(order).slice(0, 10)
      const pastIds = Object.keys(s.sessions).filter((id) => s.sessions[id].archived || s.sessions[id].control === "history")
      past = scored(pastIds).slice(0, 4)
    }
    const repos = query
      ? s.repoOrder
          .map((id) => s.repos[id])
          .filter((r) => matchScore(query, r.name) > 0)
          .slice(0, 3)
      : []
    const commands = COMMANDS.filter((c) => !c.when || c.when())
      .map((c) => ({ c, score: matchScore(query, `${c.title} ${c.keywords ?? ""}`) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query ? 6 : 4)
      .map((x) => x.c)
    return { live, past, repos, commands }
  }, [query])

  // Controlled selection: results arrive one render late (deferred query); fall back to the first
  // visible item whenever the selected one is gone, so Enter always does something.
  const [value, setValue] = useState("")
  const values = [
    ...live.map(({ x }) => `s:${x.id}`),
    ...past.map(({ x }) => `s:${x.id}`),
    ...repos.map((r) => `r:${r.id}`),
    ...commands.map((c) => `c:${c.id}`),
  ]
  const selected = values.includes(value) ? value : (values[0] ?? "")

  const run = (fn: () => void) => {
    closePalette()
    fn()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && closePalette()}>
      <DialogContent
        showCloseButton={false}
        className="top-[14%] bottom-auto max-w-[600px] translate-y-0 gap-0 overflow-hidden rounded-xl border-border bg-muted p-0 shadow-[0_16px_48px_rgba(0,0,0,0.55)] sm:max-w-[600px]"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <Cmdk shouldFilter={false} loop value={selected} onValueChange={setValue} className="flex flex-col" label="Search">
          <div className="flex h-11 items-center gap-2.5 border-b border-border px-3.5">
            <Search size={15} className="shrink-0 text-muted-foreground/70" />
            <Cmdk.Input
              autoFocus
              value={raw}
              onValueChange={setRaw}
              placeholder="Go to a session, repo or command"
              className="h-full flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <Cmdk.List className="max-h-[min(460px,60vh)] overflow-y-auto p-1.5">
            <Cmdk.Empty className="px-3 py-6 text-center text-xs text-muted-foreground/70">Nothing matches.</Cmdk.Empty>
            {live.length > 0 && (
              <Group heading={query ? "Sessions" : "Sessions, most urgent first"}>
                {live.map(({ x, repo }) => (
                  <SessionItem key={x.id} x={x} repo={repo} onSelect={() => run(() => openSession(x.id))} />
                ))}
              </Group>
            )}
            {past.length > 0 && (
              <Group heading="Past and archived">
                {past.map(({ x, repo }) => (
                  <SessionItem key={x.id} x={x} repo={repo} past onSelect={() => run(() => openSession(x.id))} />
                ))}
              </Group>
            )}
            {repos.length > 0 && (
              <Group heading="Repos">
                {repos.map((r) => (
                  <Item key={r.id} value={`r:${r.id}`} onSelect={() => run(() => openNewSession(r.id))}>
                    <Plus size={14} className="text-muted-foreground/70" />
                    <span className="truncate text-foreground">New session in {r.name}</span>
                  </Item>
                ))}
              </Group>
            )}
            {commands.length > 0 && (
              <Group heading="Commands">
                {commands.map((c) => (
                  <Item key={c.id} value={`c:${c.id}`} onSelect={() => run(c.run)}>
                    <span className="truncate text-foreground">{c.title}</span>
                    {c.shortcut && <Shortcut keys={c.shortcut} className="ml-auto" />}
                  </Item>
                ))}
              </Group>
            )}
          </Cmdk.List>
          <div className="flex h-8 items-center gap-3 border-t border-border px-3.5 text-xs text-muted-foreground/70">
            <span className="flex items-center gap-1">
              <Kbd>
                <ArrowUpDown size={10} />
              </Kbd>
              move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>
                <CornerDownLeft size={10} />
              </Kbd>
              open
            </span>
          </div>
        </Cmdk>
      </DialogContent>
    </Dialog>
  )
}

function SessionItem({ x, repo, past, onSelect }: { x: Session; repo: string; past?: boolean; onSelect: () => void }) {
  const status = useShownStatus(x.id)
  return (
    <Item value={`s:${x.id}`} onSelect={onSelect}>
      <StatusGlyph status={status} size="sm" animate={false} title={null} />
      <span className={past ? "truncate text-muted-foreground" : "truncate text-foreground"}>{x.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground/70">{repo}</span>
      <span className="tabular ml-auto shrink-0 text-xs text-muted-foreground/70">{x.archived ? "archived" : relTime(x.updatedAt)}</span>
    </Item>
  )
}

function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Cmdk.Group
      heading={heading}
      className="pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/70"
    >
      {children}
    </Cmdk.Group>
  )
}

function Item({ value, onSelect, children }: { value: string; onSelect: () => void; children: React.ReactNode }) {
  return (
    <Cmdk.Item value={value} onSelect={onSelect} className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-sm data-[selected=true]:bg-accent">
      {children}
    </Cmdk.Item>
  )
}
