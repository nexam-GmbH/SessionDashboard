// Adapted from xyflow React Flow UI (ui.reactflow.dev registry, fetched 2026-11-14 via shadcn@4.23.0):node-search.tsx (MIT).
// Modified for session-dashboard: generic over the result type (the map searches the store, not
// `getNodes()`, because collapsed sessions are not React Flow nodes), results render through a
// caller-supplied row, the list is an anchored dropdown under a 28px toolbar input, Escape
// clears, and the dialog variant was dropped.
import { useCallback, useRef, useState, type ReactNode } from "react"

import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import { Command as CommandPrimitive } from "cmdk"
import { Search, X } from "lucide-react"
import { cn } from "@/lib/utils"

export interface NodeSearchProps<T extends { id: string }> {
  /** Returns the matches for a query (called on every keystroke). */
  onSearch: (query: string) => T[]
  /** Reveal and focus the chosen result. */
  onSelectNode: (item: T) => void
  renderItem: (item: T) => ReactNode
  placeholder?: string
  className?: string
}

export function NodeSearch<T extends { id: string }>({
  onSearch,
  onSelectNode,
  renderItem,
  placeholder = "Search nodes…",
  className,
}: NodeSearchProps<T>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<T[]>([])
  // the delayed close on blur must not win over a re-focus + typing that happens within the delay
  const blurTimer = useRef<number | undefined>(undefined)

  const onChange = useCallback(
    (q: string) => {
      window.clearTimeout(blurTimer.current)
      setQuery(q)
      if (q.trim().length > 0) {
        setOpen(true)
        setResults(onSearch(q.trim()))
      } else {
        setResults([])
      }
    },
    [onSearch],
  )

  const onSelect = useCallback(
    (item: T) => {
      onSelectNode(item)
      setQuery("")
      setResults([])
      setOpen(false)
    },
    [onSelectNode],
  )

  return (
    <Command shouldFilter={false} loop className={cn("relative h-7 w-56 overflow-visible rounded-md! bg-transparent p-0", className)}>
      <div className="relative flex h-7 items-center">
        <Search size={13} className="pointer-events-none absolute left-2 text-fg-faint" />
        <CommandPrimitive.Input
          value={query}
          onValueChange={onChange}
          onFocus={() => {
            window.clearTimeout(blurTimer.current)
            if (query) setOpen(true)
          }}
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setOpen(false), 120)
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation()
              setQuery("")
              setResults([])
              setOpen(false)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          placeholder={placeholder}
          aria-label="Find on map"
          className="h-full w-full rounded-md border border-line-subtle bg-chrome pr-6 pl-7 text-xs text-fg outline-none placeholder:text-fg-faint focus:border-line-strong"
        />
        {query && (
          <button
            className="absolute right-1.5 text-fg-faint hover:text-fg"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange("")}
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {open && query.trim() && (
        <CommandList className="absolute top-8 left-0 z-50 max-h-80 w-[360px] rounded-lg border border-line bg-elevated p-1 shadow-lg">
          {results.length === 0 ? (
            <CommandEmpty className="py-4 text-xs text-fg-faint">No matches for “{query}”</CommandEmpty>
          ) : (
            <CommandGroup className="p-0">
              {results.map((item) => (
                <CommandItem key={item.id} value={item.id} onSelect={() => onSelect(item)} className="h-7 gap-2 px-2 py-0 text-xs">
                  {renderItem(item)}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      )}
    </Command>
  )
}
