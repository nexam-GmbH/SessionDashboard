// The session list, on the stock shadcn Sidebar (create-tauri-ui starter layout, MIT): workspace
// switcher on top, New session + Search, the overview and the main agent, then each repo's live
// sessions in a fixed order, Archive and Settings at the bottom. One line per session; rows never
// move while a session lives, so muscle memory (and Ctrl+1–9) stays valid.
import { memo, useEffect, useRef, useState } from "react"
import { Archive, ChartColumn, Check, ChevronsUpDown, Network, Plus, Search, Settings } from "lucide-react"
import { useUsage } from "@/features/usage/usageData"
import { useShallow } from "zustand/react/shallow"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { ensureTranscript } from "@/mocks/transcript"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useApp } from "@/store/app"
import {
  activeWorkspace,
  selectArchivedCount,
  selectLiveSessionIds,
  selectNeedsByWorkspace,
  selectNeedsYou,
  selectSessionOrder,
  useHomeRepos,
  useSession,
  useShownStatus,
  useVisibleRepos,
} from "@/store/selectors"
import { currentSessionId, openArchive, openNewSession, openOverview, openPalette, openSession, openSettings, repoInFocus, setWorkspace } from "@/store/actions"
import { useModHeld } from "./modKey"
import { navigate } from "./nav"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { MOD, Shortcut } from "@/components/common/bits"
import { EditableTitle, SessionMenu, startRename, useRenaming } from "@/features/rename/Rename"
import { WorkspaceDialog } from "@/features/workspaces/WorkspaceDialog"
import { cn } from "@/lib/utils"
import type { ID } from "@/lib/model"

export function AppSidebar() {
  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader data-tauri-drag-region>
        <WorkspaceSwitcher />
        <div className="flex items-center gap-2">
          <Button className="flex-1 justify-start" onClick={() => openNewSession(repoInFocus())} aria-keyshortcuts="Control+N">
            <Plus /> New session
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant="outline" onClick={() => openPalette()} aria-label="Search sessions" aria-keyshortcuts="Control+K">
                <Search />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Search <Shortcut keys={["mod", "K"]} className="ml-1" />
            </TooltipContent>
          </Tooltip>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <Sessions />
      </SidebarContent>
      <SidebarFooter>
        <Footer />
      </SidebarFooter>
    </Sidebar>
  )
}

/** Workspaces (Work, Games, Projects…). Another workspace that waits for you shows its count here. */
function WorkspaceSwitcher() {
  const list = useApp((s) => s.settings.workspaces)
  const ws = useApp((s) => activeWorkspace(s))
  const needs = useApp(selectNeedsByWorkspace)
  const live = useApp((s) => selectSessionOrder(s).length)
  const [creating, setCreating] = useState(false)
  const elsewhere = Object.entries(needs).filter(([id]) => id !== ws?.id).reduce((n, [, c]) => n + c, 0)
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label={`Workspace: ${ws?.name ?? "All"}`} className="data-[state=open]:bg-sidebar-accent">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Network className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{ws?.name ?? (list.length ? "All workspaces" : "Sessions")}</span>
                <span className={cn("truncate text-xs", elsewhere ? "text-st-perm-fg" : "text-muted-foreground")}>
                  {elsewhere ? `${elsewhere} waiting in other workspaces` : `${live} live session${live === 1 ? "" : "s"}`}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
            {list.length > 0 && <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>}
            {list.map((w, i) => (
              <DropdownMenuItem key={w.id} onSelect={() => setWorkspace(w.id)}>
                <span className="w-4 shrink-0">{w.id === ws?.id && <Check />}</span>
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {needs[w.id] ? <span className="tabular text-xs text-st-perm-fg">{needs[w.id]} need you</span> : null}
                {i < 9 && <DropdownMenuShortcut>Alt+{i + 1}</DropdownMenuShortcut>}
              </DropdownMenuItem>
            ))}
            {list.length > 0 && (
              <DropdownMenuItem onSelect={() => setWorkspace("")}>
                <span className="w-4 shrink-0">{!ws && <Check />}</span>
                <span className="flex-1">All workspaces</span>
              </DropdownMenuItem>
            )}
            {list.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => setCreating(true)}>
              <Plus /> New workspace…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openSettings()}>
              <Settings /> Edit workspaces
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <WorkspaceDialog open={creating} onOpenChange={setCreating} />
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function Sessions() {
  const repoOrder = useVisibleRepos()
  const mainId = useApp((s) => s.mainSessionId)
  const homes = useHomeRepos()
  const ready = useApp((s) => s.ready)
  if (!ready) return <ListSkeleton />
  return (
    <nav aria-label="Sessions" className="flex flex-col">
      <SidebarGroup>
        <SidebarMenu>
          <OverviewRow />
          {mainId && <SessionRow id={mainId} />}
        </SidebarMenu>
      </SidebarGroup>
      {homes.map((id) => (
        <RepoGroup key={id} repoId={id} mainId={mainId} />
      ))}
      {repoOrder.map((id) => (
        <RepoGroup key={id} repoId={id} mainId={mainId} />
      ))}
    </nav>
  )
}

/** While the first list of sessions is read: the list's shape, so the wait reads as loading. */
function ListSkeleton() {
  return (
    <nav aria-label="Sessions" aria-busy="true" className="flex flex-col">
      <SidebarGroup>
        <SidebarMenu>
          <OverviewRow />
        </SidebarMenu>
      </SidebarGroup>
      {[3, 4, 2].map((n, g) => (
        <SidebarGroup key={g}>
          <div className="flex h-8 items-center px-2">
            <Skeleton className="h-3 w-24" />
          </div>
          <SidebarMenu>
            {Array.from({ length: n }, (_, i) => (
              <SidebarMenuItem key={i}>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </nav>
  )
}

function OverviewRow() {
  const held = useModHeld()
  const active = useApp((s) => s.route === "/")
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} onClick={openOverview} aria-current={active ? "page" : undefined} aria-keyshortcuts="Control+0">
        <Network />
        <span>Overview</span>
      </SidebarMenuButton>
      {held && <NumberHint n={0} />}
    </SidebarMenuItem>
  )
}

const RepoGroup = memo(function RepoGroup({ repoId, mainId }: { repoId: ID; mainId: ID }) {
  const name = useApp((s) => s.repos[repoId]?.name)
  const isHome = useApp((s) => !!s.repos[repoId]?.isHome)
  const ids = useApp(useShallow((s) => selectLiveSessionIds(s, repoId).filter((id) => id !== mainId)))
  if (isHome && !ids.length) return null
  return (
    <SidebarGroup aria-label={isHome ? `${name}: all repos` : name} className="group/repo">
      <SidebarGroupLabel>
        <span className="truncate">
          {name}
          {isHome && <span className="font-normal"> · all repos</span>}
        </span>
      </SidebarGroupLabel>
      <SidebarGroupAction
        onClick={() => openNewSession(repoId)}
        aria-label={`New session in ${name}`}
        title={`New session in ${name}`}
        className="opacity-0 transition-opacity group-hover/repo:opacity-100 focus-visible:opacity-100"
      >
        <Plus />
      </SidebarGroupAction>
      <SidebarMenu>
        {ids.map((id) => (
          <SessionRow key={id} id={id} />
        ))}
        {!ids.length && <li className="px-2 py-1 text-xs text-muted-foreground/70">No live sessions</li>}
      </SidebarMenu>
    </SidebarGroup>
  )
})

const SessionRow = memo(function SessionRow({ id }: { id: ID }) {
  const s = useSession(id)
  const active = useApp(() => currentSessionId() === id)
  const needs = useApp((st) => selectNeedsYou(st).includes(id))
  const status = useShownStatus(id)
  const n = useApp((st) => selectSessionOrder(st).indexOf(id) + 1)
  const held = useModHeld()
  const editing = useRenaming((r) => r.id === id && r.where === "list")
  // the session on screen is always in view in the list (Ctrl+Tab, Ctrl+J, a new session)
  const item = useRef<HTMLLIElement>(null)
  useEffect(() => {
    const el = item.current
    const box = el?.closest<HTMLElement>("[data-slot=sidebar-content]")
    if (!active || !el || !box) return
    // only the list scrolls (scrollIntoView would also shift the overflow-hidden shell)
    const r = el.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    if (r.top < b.top) box.scrollTop -= b.top - r.top + 8
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8
  }, [active])
  if (!s) return null
  const quiet = (s.status === "idle" || s.status === "stopped") && !active
  if (editing) {
    return (
      <SidebarMenuItem>
        <div className="flex h-8 w-full items-center gap-2 rounded-md bg-sidebar-accent px-2">
          <StatusGlyph status={status} size="sm" title={null} animate={status === "working"} />
          <EditableTitle id={id} where="list" className="h-6 text-sm">
            {null}
          </EditableTitle>
        </div>
      </SidebarMenuItem>
    )
  }
  return (
    <SidebarMenuItem ref={item}>
      <SessionMenu id={id} where="list">
          <SidebarMenuButton
            isActive={active}
            onClick={() => openSession(id)}
            // start reading its chat while the pointer rests here: usually ready by the click
            onPointerEnter={() => ensureTranscript(id)}
            onDoubleClick={() => startRename(id, "list")}
            onKeyDown={(e) => {
              if (e.key === "F2") {
                e.preventDefault()
                startRename(id, "list")
              }
            }}
            aria-current={active ? "page" : undefined}
          >
            <StatusGlyph status={status} size="sm" title={null} animate={status === "working"} />
            <span className={cn(quiet ? "text-muted-foreground" : "text-sidebar-foreground", (needs || s.status === "done_unseen") && "font-medium")}>{s.title}</span>
          </SidebarMenuButton>
      </SessionMenu>
      {held && n > 0 && n <= 9 && <NumberHint n={n} />}
    </SidebarMenuItem>
  )
})

function NumberHint({ n }: { n: number }) {
  return (
    <SidebarMenuBadge className="border border-sidebar-border bg-sidebar font-normal text-muted-foreground">
      {MOD === "⌘" ? "⌘" : ""}
      {n}
    </SidebarMenuBadge>
  )
}

function Footer() {
  const archived = useApp(selectArchivedCount)
  const route = useApp((s) => s.route)
  const session = useUsage((s) => s.limits?.limits.find((l) => l.group === "session")?.percent)
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="sm" isActive={route === "/usage"} onClick={() => navigate("/usage")}>
          <ChartColumn />
          <span>Usage</span>
        </SidebarMenuButton>
        {session != null && (
          <SidebarMenuBadge className={cn("font-normal", session >= 90 ? "text-st-error-fg" : session >= 75 ? "text-st-input-fg" : "text-muted-foreground")} title="Current 5-hour session used">
            {Math.round(session)}%
          </SidebarMenuBadge>
        )}
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton size="sm" isActive={route === "/archive"} onClick={openArchive}>
          <Archive />
          <span>Archive</span>
        </SidebarMenuButton>
        {archived > 0 && <SidebarMenuBadge className="font-normal text-muted-foreground">{archived}</SidebarMenuBadge>}
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton size="sm" isActive={route === "/settings"} onClick={() => openSettings()} aria-keyshortcuts="Control+Comma">
          <Settings />
          <span>Settings</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
