// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-composer.tsx (AgentComposerTextarea; Apache-2.0). Modified for session-dashboard.
// Changes: auto-grow without `field-sizing` (not in WebKitGTK); one layer over the text paints what
// Claude Code desktop shows there: picked commands and files as blue chips, the rainbow
// "ultrathink", and a greyed hint after the text ("Type to filter", a command's arguments).
import { forwardRef, Fragment, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from "react"
import { cn } from "@/lib/utils"
import type { Mark } from "./tokens"

export type ComposerTextareaProps = ComponentPropsWithoutRef<"textarea"> & {
  /** Sorted, non-overlapping ranges painted over the text. Backspace after a chip selects it, a second one deletes it. */
  marks?: Mark[]
  /** greyed text after the end of the text (the caret is there) */
  ghost?: string
  maxHeight?: number
}

export const ComposerTextarea = forwardRef<HTMLTextAreaElement, ComposerTextareaProps>(function ComposerTextarea(
  { className, marks, ghost, onKeyDown, onScroll, maxHeight = 220, ...props },
  forwardedRef,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const value = typeof props.value === "string" ? props.value : ""

  // Auto-grow to content, capped. Typing on a line that still fits changes no height: only then
  // is the box measured from scratch (collapsing it to "auto" first forces the whole window's
  // layout twice per key, which WebKitGTK feels on a long chat)
  const lastLen = useRef(0)
  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    const shrank = value.length < lastLen.current
    lastLen.current = value.length
    if (shrank || !el.style.height) el.style.height = "auto"
    else if (el.scrollHeight <= el.clientHeight) return
    // +1: zoomed web views round heights to fractions; without it a scrollbar shows up empty
    const h = el.scrollHeight + 1
    el.style.height = `${Math.min(h, maxHeight)}px`
    // a scrollbar only once the text is taller than the box can grow
    el.style.overflowY = h > maxHeight ? "auto" : "hidden"
  }, [value, maxHeight])

  // The wrapper always renders so toggling the layer never remounts (and blurs) the textarea.
  let upTo = 0
  return (
    <div className="relative flex min-w-0 flex-1">
      <textarea
        {...props}
        ref={(el) => {
          innerRef.current = el
          if (typeof forwardedRef === "function") forwardedRef(el)
          else if (forwardedRef) forwardedRef.current = el
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event)
          const ta = event.currentTarget
          if (
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            ta.selectionStart !== ta.selectionEnd
          )
            return
          const caret = ta.selectionStart
          const chip = marks?.find((r) => r.kind === "chip" && (event.key === "Backspace" ? r.end === caret : event.key === "Delete" && r.start === caret))
          // the first key selects the chip, the next one deletes it (natively: undo keeps working)
          if (chip) {
            event.preventDefault()
            ta.setSelectionRange(chip.start, chip.end)
          }
        }}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop)
          onScroll?.(event)
        }}
        className={cn(
          "relative block w-full flex-1 resize-none overflow-x-hidden overflow-y-hidden bg-transparent text-[var(--cc-fg)] outline-none placeholder:text-cc-placeholder",
          className,
        )}
      />
      {/* the same text, transparent, over the textarea (its metrics: same classes), scrolled with it;
          each mark has the box's colour behind it, hiding the plain glyphs under it */}
      {(!!marks?.length || !!ghost) && (
        <div aria-hidden className={cn("pointer-events-none absolute inset-0 z-[1] overflow-hidden break-words whitespace-pre-wrap text-transparent select-none", className)}>
          <div style={{ transform: `translateY(${-scrollTop}px)` }}>
            {marks?.map((m, i) => {
              const before = value.slice(upTo, m.start)
              const word = value.slice(m.start, m.end)
              upTo = m.end
              return (
                // keyed by place in the list, so typing elsewhere doesn't restart the rainbow's sweep
                <Fragment key={i}>
                  {before}
                  {m.kind === "chip" ? (
                    <span className="bg-cc-raised text-cc-accent-text">
                      <span className="opacity-50">{word[0]}</span>
                      {word.slice(1)}
                    </span>
                  ) : (
                    <span className="bg-cc-raised">
                      <span className="cc-rainbow [-webkit-text-fill-color:transparent]">{word}</span>
                    </span>
                  )}
                </Fragment>
              )
            })}
            {ghost && (
              <>
                {value.slice(upTo)}
                <span className="ml-0.5 text-cc-placeholder">{ghost}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
})