// Adapted from pingdotgg/t3code@be5f805:apps/web/src/components/chat/ComposerCommandMenu.tsx (MIT). Modified for session-dashboard.
// Changes: cmdk (MIT) list with a controlled active item while focus stays in the
// textarea; two item kinds (`/` commands, `@` files from the repo); anchored at
// the caret instead of a drawer above the composer.
import { memo, useLayoutEffect, useRef } from "react"
import { Command } from "cmdk"
import { FileCode2 } from "lucide-react"
import { cn } from "@/lib/utils"

export type MenuItem =
  | { id: string; type: "command"; label: string; description: string }
  | { id: string; type: "file"; label: string; description: string; path: string }

export const ComposerMenu = memo(function ComposerMenu({
  items,
  activeId,
  kind,
  left,
  bottom,
  onHighlight,
  onSelect,
  onAria,
}: {
  items: MenuItem[]
  activeId: string | null
  kind: "slash" | "mention"
  /** caret x relative to the composer */
  left: number
  /** distance from the composer's bottom edge to the caret line top */
  bottom: number
  onHighlight: (id: string) => void
  onSelect: (item: MenuItem) => void
  /**
   * DOM ids of the listbox and its active option, for the textarea's aria-controls /
   * aria-activedescendant (cmdk generates the ids; focus stays in the textarea).
   */
  onAria?: (aria: { listId?: string; optionId?: string }) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const el = activeId ? list.querySelector<HTMLElement>(`[data-menu-id="${CSS.escape(activeId)}"]`) : null
    el?.scrollIntoView({ block: "nearest" })
    onAria?.({ listId: list.id || undefined, optionId: el?.id || undefined })
  }, [activeId, items, onAria])
  useLayoutEffect(() => () => onAria?.({}), [onAria])

  return (
    <div
      className="absolute z-40 w-[380px] max-w-[calc(100%-16px)] overflow-hidden rounded-md border border-line bg-elevated shadow-lg"
      style={{ left: Math.max(8, left - 12), bottom: bottom + 4 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <Command shouldFilter={false} value={activeId ?? ""} loop label={kind === "slash" ? "Commands" : "Files"}>
        <div className="flex h-6 items-center border-b border-line-subtle px-2 text-[11px] text-fg-faint">
          {kind === "slash" ? "Commands" : "Files in this repository"}
          <span className="ml-auto" aria-hidden>
            ↑↓ · ⏎ or Tab · Esc
          </span>
        </div>
        <Command.List ref={listRef} label={kind === "slash" ? "Commands" : "Files in this repository"} className="max-h-[240px] overflow-y-auto p-1">
          {items.length === 0 && <div className="px-2 py-2 text-[12px] text-fg-faint">{kind === "slash" ? "No matching command." : "No matching files."}</div>}
          {items.map((item) => (
            <Command.Item
              key={item.id}
              value={item.id}
              data-menu-id={item.id}
              onMouseMove={() => item.id !== activeId && onHighlight(item.id)}
              onSelect={() => onSelect(item)}
              className={cn(
                "flex h-7 cursor-default items-center gap-2 rounded-[3px] px-1.5 text-[12.5px] text-fg-muted",
                item.id === activeId && "bg-selected text-fg",
              )}
            >
              {/* the "/" is part of a command's label; only files get a leading icon */}
              {item.type === "file" && <FileCode2 size={12} className="shrink-0 text-fg-faint" />}
              <span className={cn("shrink-0 truncate font-mono text-[12px]", item.type === "file" ? "max-w-[55%]" : "min-w-[76px]")}>{item.label}</span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-faint">{item.description}</span>
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </div>
  )
})
