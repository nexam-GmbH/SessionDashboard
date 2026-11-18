// Adapted from pingdotgg/t3code@be5f805:apps/web/src/components/chat/ComposerCommandMenu.tsx (MIT). Modified for session-dashboard.
// Changes: cmdk (MIT) list with a controlled active item while focus stays in the textarea; the
// "/" and "@" popups of Claude Code desktop: above the token, one-line rows with the matched
// letters in semibold, a command's description in a flyout beside the popup, no headers.
import { memo, useLayoutEffect, useRef } from "react"
import { Command } from "cmdk"
import { FileCode2, FileImage, FileJson, FileText } from "lucide-react"
import { cn } from "@/lib/utils"
import { matchIndices } from "./tokens"

export type MenuItem =
  | { id: string; type: "command"; label: string; description: string }
  | { id: string; type: "file"; label: string; description: string; path: string }

const ROW = "flex h-7 cursor-default items-center gap-2 rounded-lg px-2.5 text-sm"

/** `text` with the letters at `hits` (offset by `from` in the matched string) in semibold. */
function Hl({ text, hits, from = 0 }: { text: string; hits: Set<number>; from?: number }) {
  if (!hits.size) return text
  return [...text].map((ch, i) => (hits.has(from + i) ? <b key={i} className="font-semibold text-[var(--cc-fg)]">{ch}</b> : ch))
}

function fileIcon(name: string) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  if (ext === "json") return FileJson
  if (/^(png|jpe?g|gif|webp|svg|ico)$/.test(ext)) return FileImage
  if (/^(md|mdx|txt|rst)$/.test(ext)) return FileText
  return FileCode2
}

export const ComposerMenu = memo(function ComposerMenu({
  items,
  activeId,
  kind,
  query,
  left,
  bottom,
  onHighlight,
  onSelect,
  onAria,
}: {
  items: MenuItem[]
  activeId: string | null
  kind: "slash" | "mention"
  query: string
  /** the token's x relative to the composer */
  left: number
  /** distance from the composer's bottom edge to the token's line top */
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
  const flyRef = useRef<HTMLDivElement>(null)
  const active = items.find((i) => i.id === activeId)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const el = activeId ? list.querySelector<HTMLElement>(`[data-menu-id="${CSS.escape(activeId)}"]`) : null
    el?.scrollIntoView({ block: "nearest" })
    onAria?.({ listId: list.id || undefined, optionId: el?.id || undefined })
    // the description flyout follows the highlighted row
    if (el && flyRef.current) flyRef.current.style.top = `${el.offsetTop - list.scrollTop + 6}px`
  }, [activeId, items, onAria])
  useLayoutEffect(() => () => onAria?.({}), [onAria])

  const slash = kind === "slash"
  return (
    <div
      className="absolute z-40"
      // "/": 16 px left of the token, 10 px above its line; "@": at the token, 24 px above
      style={slash ? { left: Math.max(-8, left - 16), bottom: bottom + 10 } : { left, bottom: bottom + 24 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <Command
        shouldFilter={false}
        value={activeId ?? ""}
        loop
        label={slash ? "Commands" : "Mention suggestions"}
        className={cn(
          "overflow-hidden rounded-[14px] bg-cc-raised p-1.5 text-[var(--cc-fg)] shadow-[var(--cc-shadow-panel)] select-none",
          slash ? "w-max max-w-[min(512px,calc(100vw-16px))] min-w-60" : "w-[560px] max-w-[calc(100vw-32px)]",
        )}
      >
        <Command.List ref={listRef} label={slash ? "Commands" : "Mention suggestions"} className="max-h-[372px] overflow-y-auto">
          {items.map((item) => {
            const hits = matchIndices(query, item.type === "file" ? item.path : item.label)
            const Icon = item.type === "file" ? fileIcon(item.label) : null
            const dir = item.type === "file" ? item.path.length - item.label.length : 0
            return (
              <Command.Item
                key={item.id}
                value={item.id}
                data-menu-id={item.id}
                onMouseMove={() => item.id !== activeId && onHighlight(item.id)}
                onSelect={() => onSelect(item)}
                title={item.type === "file" ? item.path : undefined}
                className={cn(ROW, item.id === activeId && "bg-cc-ghost-sel")}
              >
                {Icon && (
                  <span className="flex size-5 shrink-0 items-center justify-center text-cc-fg2">
                    <Icon size={16} />
                  </span>
                )}
                <span className={cn("truncate", item.type === "file" ? "shrink-0" : "min-w-0", hits.size && "text-cc-fg2")}>
                  <Hl text={item.label} hits={hits} from={dir} />
                </span>
                {item.type === "file" && item.description && (
                  <span className="min-w-0 truncate text-xs text-cc-fg2">
                    <Hl text={item.description} hits={hits} />
                  </span>
                )}
              </Command.Item>
            )
          })}
        </Command.List>
      </Command>
      {/* a command's description, beside the popup at the highlighted row (Claude Code desktop) */}
      {slash && active?.description && (
        <div
          ref={flyRef}
          role="tooltip"
          className="absolute left-full ml-2 line-clamp-[10] w-max max-w-72 rounded-md bg-[#0b0b0b] px-2 py-1.5 text-[13px] leading-[18px] text-white shadow-[var(--cc-shadow-panel)] dark:bg-cc-raised dark:text-[var(--cc-fg)]"
        >
          <Hl text={active.description} hits={query && active.description.toLowerCase().includes(query.toLowerCase()) ? matchIndices(query, active.description) : new Set()} />
        </div>
      )}
    </div>
  )
})
