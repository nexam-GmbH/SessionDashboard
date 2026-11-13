// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-composer.tsx (AgentComposerTextarea; Apache-2.0). Modified for session-dashboard.
// Changes: our tokens and 13px density; auto-grow without `field-sizing` (not in
// WebKitGTK); token chips styled as quiet highlights.
import { forwardRef, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from "react"
import { cn } from "@/lib/utils"
import type { Range } from "./tokens"

const TOKEN_CLASS = "rounded-[3px] bg-brand/20 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand)_45%,transparent)]"

export type ComposerTextareaProps = ComponentPropsWithoutRef<"textarea"> & {
  /** Sorted, non-overlapping [start, end) ranges drawn as inline tokens. Backspace at a token's end deletes it whole. */
  highlights?: Range[]
  maxHeight?: number
}

export const ComposerTextarea = forwardRef<HTMLTextAreaElement, ComposerTextareaProps>(function ComposerTextarea(
  { className, highlights, onKeyDown, onScroll, maxHeight = 220, ...props },
  forwardedRef,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const value = typeof props.value === "string" ? props.value : ""

  // Auto-grow to content, capped.
  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [value, maxHeight])

  let renderedUpTo = 0
  // The wrapper always renders so toggling highlights never remounts (and blurs) the textarea.
  return (
    <div className="relative flex min-w-0 flex-1">
      {highlights && highlights.length > 0 && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap text-transparent [scrollbar-gutter:stable]",
            className,
          )}
        >
          <div style={{ transform: `translateY(${-scrollTop}px)` }}>
            {highlights.map(({ start, end }) => {
              const before = value.slice(renderedUpTo, start)
              renderedUpTo = end
              return [
                before,
                <span className={TOKEN_CLASS} key={start}>
                  {value.slice(start, end)}
                </span>,
              ]
            })}
          </div>
        </div>
      )}
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
          const token = highlights?.find((r) => (event.key === "Backspace" ? r.end === caret : event.key === "Delete" && r.start === caret))
          // Selecting the token lets the native delete remove it, keeping undo intact.
          if (token) ta.setSelectionRange(token.start, token.end)
        }}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop)
          onScroll?.(event)
        }}
        className={cn(
          "relative block w-full flex-1 resize-none overflow-y-auto bg-transparent text-fg outline-none [scrollbar-gutter:stable] placeholder:text-fg-faint",
          className,
        )}
      />
    </div>
  )
})
