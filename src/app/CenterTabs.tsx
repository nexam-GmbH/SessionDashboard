// Tab strip — UI_PLAN §4.3. Behavior after Supabase Studio layouts/Tabs/Tabs.tsx (Apache-2.0)
// and Yaak core/Tabs (MIT); look after VS Code "Dark Modern" (active tab merges with the
// editor surface, 1px top accent). Pinned Map/Sessions tabs, closable others, drag to reorder.
import { memo, useState } from "react"
import { FolderGit2, GitCompareArrows, Network, Rows3, Settings2, Waypoints, Wrench, X, ExternalLink, Plus } from "lucide-react"
import { navigate } from "./nav"
import { useApp, type Tab } from "@/store/app"
import { closeTab, moveTab, openNewSession, pinTab } from "@/store/actions"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { cn } from "@/lib/utils"
import { useTabTitle } from "./tabMeta"
import { openPopout } from "./popout"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Shortcut } from "@/components/common/bits"

export function CenterTabs() {
  const tabs = useApp((s) => s.tabs)
  return (
    <div className="flex h-[var(--tab-h)] shrink-0 items-stretch border-b border-line-subtle bg-chrome">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]">
        {tabs.map((t) => (
          <TabItem key={t.key} tab={t} />
        ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => openNewSession()}
              className="flex w-8 shrink-0 items-center justify-center text-fg-faint hover:text-fg"
              aria-label="New session"
            >
              <Plus size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            New session <Shortcut keys={["mod", "N"]} className="ml-1" />
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

const ICONS = {
  map: Network,
  sessions: Rows3,
  repo: FolderGit2,
  graph: Waypoints,
  review: GitCompareArrows,
  settings: Settings2,
  dev: Wrench,
} as const

const TabItem = memo(function TabItem({ tab }: { tab: Tab }) {
  const active = useApp((s) => s.activeTab === tab.key)
  const meta = useTabTitle(tab.key)
  const [dragOver, setDragOver] = useState(false)
  const Icon = tab.kind === "session" ? null : ICONS[tab.kind as keyof typeof ICONS]
  return (
    <div
      role="tab"
      aria-selected={active}
      draggable={!tab.pinned}
      onDragStart={(e) => {
        pinTab(tab.key)
        e.dataTransfer.setData("text/tab", tab.key)
      }}
      onDragOver={(e) => {
        if (!tab.pinned) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false)
        const from = e.dataTransfer.getData("text/tab")
        if (from) moveTab(from, tab.key)
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          closeTab(tab.key)
        }
      }}
      onClick={() => navigate(tab.key)}
      onDoubleClick={() => pinTab(tab.key)}
      title={tab.preview ? `${meta.title} (preview: double-click to keep open)` : meta.title}
      className={cn(
        "group/tab relative flex shrink-0 cursor-default items-center gap-1.5 border-r border-line-subtle text-xs transition-colors",
        tab.pinned ? "px-3" : "max-w-[220px] min-w-[96px] pr-1 pl-3",
        active
          ? "bg-canvas text-fg before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-brand"
          : "text-fg-faint hover:bg-hover/60 hover:text-fg-muted",
        dragOver && "bg-hover",
      )}
    >
      {tab.kind === "session" && meta.status ? (
        <StatusGlyph status={meta.status} size="xs" />
      ) : Icon ? (
        <Icon size={13} className={active ? "text-fg-muted" : undefined} />
      ) : null}
      <span className={cn("truncate", tab.preview && "italic")}>{meta.title}</span>
      {!tab.pinned && (
        <span className="ml-auto flex shrink-0 items-center">
          {tab.kind === "session" && (
            <button
              className="hidden size-5 items-center justify-center rounded-sm text-fg-faint hover:bg-selected hover:text-fg group-hover/tab:flex"
              onClick={(e) => {
                e.stopPropagation()
                openPopout(tab.key)
              }}
              aria-label="Open in new window"
              title="Open in new window"
            >
              <ExternalLink size={11} />
            </button>
          )}
          <button
            className={cn(
              "flex size-5 items-center justify-center rounded-sm text-fg-faint hover:bg-selected hover:text-fg",
              !active && "opacity-0 group-hover/tab:opacity-100",
            )}
            onClick={(e) => {
              e.stopPropagation()
              closeTab(tab.key)
            }}
            aria-label="Close tab"
          >
            <X size={12} />
          </button>
        </span>
      )}
    </div>
  )
})
