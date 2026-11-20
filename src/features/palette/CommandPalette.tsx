// Search (Ctrl+K). shadcn Command (cmdk, MIT); structure after Orca's worktree-jump palette (MIT,
// ideas) and T3 Code's "In messages" (MIT, ideas): with an empty query it lists live sessions
// ranked by attention (needs you, then unread, then recently opened), so Ctrl+K ⏎ goes
// where you are needed, and the past sessions you touched last. Typing searches live sessions (in
// every workspace), past ones by title, then what was said in every session ("In messages": opens
// the chat at that message), then repos (new session there) and a few commands.
import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { Command as Cmdk } from "cmdk"
import { ArrowUpDown, CornerDownLeft, LoaderCircle, MessageSquareText, Plus, Search } from "lucide-react"
import type { SearchHit } from "@/backend/real"
import { useContentSearch } from "@/features/history/contentSearch"
import { openSessionAt } from "@/features/session-view/find/find"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { getApp } from "@/store/app"
import { selectNeedsYou, selectSessionOrder, useShownStatus } from "@/store/selectors"
import { closePalette, openNewSession, openSession, takePaletteTypeAhead } from "@/store/actions"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { Kbd, Shortcut } from "@/components/common/bits"
import { relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
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
  const content = useContentSearch(query)

  const { live, past, repos, commands } = useMemo(() => {
    const s = getApp()
    const repoName = (x: Session) => (x.repoId ? (s.repos[x.repoId]?.name ?? "") : "main agent")
    const order = selectSessionOrder(s)
    let live: Hit[]
    let past: Hit[]
    if (!query) {
      // attention first, then what you had open most recently, then the rest in list order
      const needs = selectNeedsYou(s)
      const unseen = order.filter((id) => !!s.sessions[id].unreadSince)
      const ranked = [...new Set([...needs, ...unseen, ...s.recent.filter((id) => order.includes(id)), ...order])]
      live = ranked.slice(0, 8).map((id) => ({ x: s.sessions[id], repo: repoName(s.sessions[id]) }))
      // the past sessions you were in last (opened lately, or the newest ones)
      const pastIds = new Set(Object.keys(s.sessions).filter((id) => !s.sessions[id].archived && s.sessions[id].control === "history"))
      const opened = s.recent.filter((id) => pastIds.has(id))
      const newest = [...pastIds].sort((a, b) => s.sessions[b].updatedAt.localeCompare(s.sessions[a].updatedAt))
      past = [...new Set([...opened, ...newest])].slice(0, 5).map((id) => ({ x: s.sessions[id], repo: repoName(s.sessions[id]) }))
    } else {
      const pq = prepareQuery(query)
      const scored = (ids: string[]) =>
        ids
          .map((id) => s.sessions[id])
          .map((x) => ({ x, repo: repoName(x), score: scoreSession(pq, x, repoName(x)) }))
          .filter((h) => h.score > 0)
          .sort((a, b) => b.score - a.score || b.x.updatedAt.localeCompare(a.x.updatedAt))
      // live sessions of every workspace (opening one switches to its workspace)
      const allLive = Object.keys(s.sessions).filter((id) => !s.sessions[id].archived && s.sessions[id].control !== "history")
      live = scored([...new Set([...order, ...allLive])]).slice(0, 10)
      const pastIds = Object.keys(s.sessions).filter((id) => s.sessions[id].archived || s.sessions[id].control === "history")
      past = scored(pastIds).slice(0, 8)
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
  // also sessions listed above by title: a hit here opens the chat at the message itself
  const inMessages = content.hits.slice(0, 12)
  const values = [
    ...live.map(({ x }) => `s:${x.id}`),
    ...past.map(({ x }) => `s:${x.id}`),
    ...inMessages.map((h) => `m:${h.sessionId}`),
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
        className="top-[12%] bottom-auto max-w-[680px] translate-y-0 gap-0 overflow-hidden rounded-xl border-border bg-muted p-0 shadow-[0_16px_48px_rgba(0,0,0,0.55)] sm:max-w-[680px]"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <Cmdk shouldFilter={false} loop value={selected} onValueChange={setValue} className="flex flex-col" label="Search">
          <div className="flex h-11 items-center gap-2.5 border-b border-border px-3.5">
            <Search size={15} className="shrink-0 text-muted-foreground/70" />
            <Cmdk.Input
              autoFocus
              value={raw}
              onValueChange={setRaw}
              placeholder="Search sessions and what was said in them"
              className="h-full flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <Cmdk.List className="max-h-[min(560px,66vh)] overflow-y-auto p-1.5">
            <Cmdk.Empty className="px-3 py-6 text-center text-xs text-muted-foreground/70">Nothing matches.</Cmdk.Empty>
            {live.length > 0 && (
              <Group heading={query ? "Sessions" : "Sessions, most urgent first"}>
                {live.map(({ x, repo }) => (
                  <SessionItem key={x.id} x={x} repo={repo} onSelect={() => run(() => openSession(x.id))} />
                ))}
              </Group>
            )}
            {past.length > 0 && (
              <Group heading={query ? "Past and archived" : "Past sessions, last opened first"}>
                {past.map(({ x, repo }) => (
                  <SessionItem key={x.id} x={x} repo={repo} past onSelect={() => run(() => openSession(x.id))} />
                ))}
              </Group>
            )}
            {query.length >= 2 && (inMessages.length > 0 || content.busy) && (
              <Group heading={content.busy && !inMessages.length ? "In messages · searching…" : "In messages"}>
                {inMessages.map((h) => (
                  <MessageItem key={h.sessionId} hit={h} onSelect={() => run(() => openSessionAt(h.sessionId, h.uuid, query))} />
                ))}
                {content.busy && !inMessages.length && (
                  <div className="flex h-8 items-center gap-2 px-2 text-xs text-muted-foreground/70">
                    <LoaderCircle size={13} className="animate-spin-steps" /> Reading every session once (a few seconds)…
                  </div>
                )}
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
      <StatusGlyph status={status} outcome={x.outcome} unread={!!x.unreadSince} size="sm" title={null} />
      <span className={past && !x.unreadSince ? "truncate text-muted-foreground" : cn("truncate text-foreground", x.unreadSince && "font-medium")}>{x.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground/70">{repo}</span>
      <span className="tabular ml-auto shrink-0 text-xs text-muted-foreground/70">{x.archived ? "archived" : relTime(x.updatedAt)}</span>
    </Item>
  )
}

function MessageItem({ hit, onSelect }: { hit: SearchHit; onSelect: () => void }) {
  const s = getApp()
  const x = s.sessions[hit.sessionId]
  const repo = x?.repoId ? (s.repos[x.repoId]?.name ?? "") : ""
  return (
    <Cmdk.Item value={`m:${hit.sessionId}`} onSelect={onSelect} className="flex cursor-default flex-col items-stretch gap-0.5 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-accent">
      <span className="flex min-w-0 items-center gap-2.5">
        <MessageSquareText size={14} className="shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 truncate text-foreground">{x?.title ?? hit.sessionId.slice(0, 8)}</span>
        <span className="shrink-0 text-xs text-muted-foreground/70">{repo}</span>
        <span className="tabular ml-auto shrink-0 text-xs text-muted-foreground/70">
          {hit.count > 1 ? `${hit.count} messages · ` : ""}
          {relTime(hit.at)}
        </span>
      </span>
      <span className="truncate pl-6 text-xs text-muted-foreground">
        <span className="text-muted-foreground/70">{hit.role === "user" ? "You: " : "Claude: "}</span>
        {hit.before}
        <mark className="rounded-sm bg-st-input/25 px-0.5 text-foreground">{hit.matched}</mark>
        {hit.after}
      </span>
    </Cmdk.Item>
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
