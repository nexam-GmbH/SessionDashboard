// Adapted from agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/ApprovalCard.tsx (MIT). Modified for session-dashboard.
// Shared chrome of the request cards, shaped after Claude Code desktop's approval card: docked in
// place of the prompt box while it is the active request, or a plain card in the conversation.
import { forwardRef, useEffect, useEffectEvent, useId, useRef, type ComponentProps, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { PermissionOption } from "@/lib/model"
import { cn } from "@/lib/utils"

/** Desktop's focus ring (1 px accent in a soft glow, from index.css). */
export const FOCUS = "outline-none cc-focus"
/** The one-shot "promote" animation: from 75 % opacity, 6 px up and 97 % scale, 220 ms. */
export const ENTER =
  "origin-top animate-in fade-in-75 zoom-in-97 slide-in-from-top-1.5 duration-220 ease-[cubic-bezier(0.215,0.61,0.355,1)] motion-reduce:animate-none [:root[data-reduce-motion]_&]:animate-none"

export interface Pager {
  index: number
  total: number
  /** undefined: no way back (first question) */
  onPrev?: () => void
  onNext?: () => void
}

const GHOST_ICON = cn("inline-flex size-6 items-center justify-center rounded-lg text-cc-fg2 hover:bg-cc-ghost hover:text-foreground disabled:opacity-40", FOCUS)

/** "‹ 2 of 3 ›" */
export function PagerNav({ pager, noun }: { pager: Pager; noun: string }) {
  return (
    <span className="flex h-6 shrink-0 items-center gap-0.5 text-sm text-cc-fg3">
      <button type="button" aria-label={`Previous ${noun}`} disabled={!pager.onPrev} onClick={pager.onPrev} className={GHOST_ICON}>
        <ChevronLeft size={16} />
      </button>
      <span className="px-0.5 tabular-nums">
        {pager.index + 1} of {pager.total}
      </span>
      <button type="button" aria-label={`Next ${noun}`} disabled={!pager.onNext} onClick={pager.onNext} className={GHOST_ICON}>
        <ChevronRight size={16} />
      </button>
    </span>
  )
}

export const CardFrame = forwardRef<
  HTMLElement,
  {
    /** in the composer dock (the active request) rather than in the conversation */
    docked: boolean
    label: string
    /** keyboard model for screen readers */
    keyHint?: string
    title: ReactNode
    meta?: ReactNode
    pager?: Pager
    children?: ReactNode
    footer?: ReactNode
    onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void
    className?: string
  }
>(function CardFrame({ docked, label, keyHint, title, meta, pager, children, footer, onKeyDown, className }, ref) {
  const hintId = useId()
  return (
    // a labelled region: focus lands here when a request arrives, screen readers can jump to it
    <section
      ref={ref}
      role="region"
      aria-label={label}
      aria-describedby={keyHint ? hintId : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        // the card takes focus when it arrives: a quiet inset accent line, not the glowing ring
        "@container flex min-h-0 flex-col gap-3 rounded-xl p-3 text-sm text-foreground outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--cc-accent)]",
        ENTER,
        // the dock keeps the conversation in view: at most max(60vh, 16rem), the body scrolls
        // --card-bg: the colour the scroll fades melt into (the inline card fill is a faint tint over the chat)
        docked ? "max-h-[max(60vh,16rem)] bg-cc-panel shadow-[var(--cc-shadow-panel)] [--card-bg:var(--cc-panel)]" : "my-3 max-h-[60vh] max-w-[480px] bg-cc-card ring-1 ring-cc-wash-2 [--card-bg:var(--cc-surface)]",
        className,
      )}
    >
      <header className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1 py-0.5 leading-5">{title}</div>
        {meta}
        {pager && pager.total > 1 && <PagerNav pager={pager} noun="request" />}
        {keyHint && (
          <span id={hintId} className="sr-only">
            {keyHint}
          </span>
        )}
      </header>
      {children && (
        <FadeScroll className="-mx-3 min-h-0 px-3" inner="flex flex-col gap-3">
          {children}
        </FadeScroll>
      )}
      {footer}
    </section>
  )
})

/**
 * A scrolling area with desktop's top and bottom fades: sticky gradient strips in the `--fade`
 * colour (default `--card-bg`), shown only while there is more to scroll that way (attributes set on scroll and on
 * resize, no re-render). `onMoreBelow` hears when "more below" changes. Props go to the inner box.
 */
export const FadeScroll = forwardRef<
  HTMLDivElement,
  ComponentProps<"div"> & { inner?: string; edge?: "h-2" | "h-3"; onMoreBelow?: (more: boolean) => void }
>(function FadeScroll({ className, inner, edge = "h-3", onMoreBelow, children, ...rest }, ref) {
  const outer = useRef<HTMLDivElement>(null)
  const sync = useEffectEvent(() => {
    const el = outer.current
    if (!el) return
    el.toggleAttribute("data-more-above", el.scrollTop > 1)
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1
    if (below === el.hasAttribute("data-more-below")) return
    el.toggleAttribute("data-more-below", below)
    onMoreBelow?.(below)
  })
  useEffect(() => {
    const el = outer.current
    if (!el) return
    // first notification on observe: the initial state, without a layout read on mount
    const ro = new ResizeObserver(() => sync())
    ro.observe(el)
    if (el.children[1]) ro.observe(el.children[1])
    return () => ro.disconnect()
  }, [])
  const strip = cn("pointer-events-none sticky z-10 block shrink-0 opacity-0 transition-opacity duration-150", edge)
  return (
    <div ref={outer} onScroll={() => sync()} className={cn("overflow-y-auto", className)}>
      <span aria-hidden className={cn(strip, "top-0 bg-linear-to-b from-[var(--fade,var(--card-bg))] to-transparent [[data-more-above]>&]:opacity-100", edge === "h-2" ? "-mb-2" : "-mb-3")} />
      <div ref={ref} className={inner} {...rest}>
        {children}
      </div>
      <span aria-hidden className={cn(strip, "bottom-0 bg-linear-to-t from-[var(--fade,var(--card-bg))] to-transparent [[data-more-below]>&]:opacity-100", edge === "h-2" ? "-mt-2" : "-mt-3")} />
    </div>
  )
})

/** The decision row: deny-ish answers at the start, the allow group at the end (primary last); stacked at ≤ 420 px. */
export function Decision({ start, end }: { start?: ReactNode; end?: ReactNode }) {
  const stack = "@max-[420px]:flex-col @max-[420px]:items-stretch"
  return (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3", stack)}>
      <div className={cn("flex flex-wrap items-center gap-2", stack)}>{start}</div>
      <div className={cn("ms-auto flex flex-wrap items-center justify-end gap-3 @max-[420px]:ms-0", stack)}>{end}</div>
    </div>
  )
}

/** Keycaps after a button's label ("Ctrl ⏎"); dock only, hidden at ≤ 520 px. */
function KeyCaps({ keys, onPrimary }: { keys: string[]; onPrimary: boolean }) {
  return (
    <span aria-hidden className="inline-flex gap-0.5 @max-[520px]:hidden">
      {keys.map((k) => (
        <kbd
          key={k}
          className={cn(
            "inline-flex h-4 min-w-4 items-center justify-center rounded px-1 font-sans text-[11px] leading-none",
            onPrimary ? "bg-cc-on-primary/15 text-cc-on-primary/70" : "bg-cc-wash text-cc-fg3",
          )}
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}

// short labels: earlier with more buttons in the row (desktop: 500 / 425 / 350 px)
const SHORT = {
  500: ["@max-[500px]:hidden", "@max-[500px]:inline"],
  425: ["@max-[425px]:hidden", "@max-[425px]:inline"],
  350: ["@max-[350px]:hidden", "@max-[350px]:inline"],
} as const
export type ShortAt = keyof typeof SHORT
/** Where a row of `n` buttons switches to short labels. */
export const shortAt = (n: number): ShortAt => (n >= 4 ? 500 : n === 3 ? 425 : 350)

const VARIANT = {
  primary: "bg-cc-primary font-medium text-cc-on-primary hover:bg-cc-primary-hover",
  secondary: "bg-secondary text-foreground hover:bg-[var(--cc-secondary-hover)]",
  ghost: "text-cc-fg2 hover:bg-cc-ghost hover:text-foreground",
}

/** Desktop's button: 28 px, radius 8, 14 px text; a short label at tight widths. */
export function OptionButton({
  children,
  short,
  at = 500,
  variant,
  onClick,
  disabled,
  keys,
  title,
  className,
}: {
  children: ReactNode
  /** label at tight card widths (≤ `at` px) */
  short?: ReactNode
  at?: ShortAt
  variant: keyof typeof VARIANT
  onClick: () => void
  disabled?: boolean
  keys?: string[]
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex h-7 max-w-full min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-sm whitespace-nowrap disabled:pointer-events-none disabled:opacity-40",
        FOCUS,
        VARIANT[variant],
        className,
      )}
    >
      {short ? (
        <>
          <span className={cn("min-w-0 truncate", SHORT[at][0])}>{children}</span>
          <span className={cn("hidden min-w-0 truncate", SHORT[at][1])}>{short}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">{children}</span>
      )}
      {keys && <KeyCaps keys={keys} onPrimary={variant === "primary"} />}
    </button>
  )
}

/** A split button: `children` is the main button, the caret opens its other answers ("More allow options"). */
export function Split({
  children,
  label,
  items,
  disabled,
  variant = "primary",
}: {
  children: ReactNode
  label: string
  items: { label: string; hint?: string; danger?: boolean; onSelect: () => void }[]
  disabled?: boolean
  variant?: "primary" | "secondary"
}) {
  if (!items.length) return children
  return (
    <span className="inline-flex min-w-0 [&>button:first-child]:flex-1 [&>button:first-child]:rounded-e-none">
      {children}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={label}
            title={label}
            className={cn(
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-e-lg border-s disabled:pointer-events-none disabled:opacity-40",
              variant === "primary" ? "border-cc-on-primary/20" : "border-cc-wash-2",
              VARIANT[variant],
              FOCUS,
            )}
          >
            <ChevronDown size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-56">
          {items.map((it) => (
            <DropdownMenuItem key={it.label} variant={it.danger ? "destructive" : undefined} onSelect={it.onSelect} className="flex-col items-start gap-0 py-1.5">
              {it.label}
              {it.hint && <span className="text-[13px] leading-[17px] text-cc-fg3">{it.hint}</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

/** The footer turned into a short editor (deny with feedback, revise a plan); Enter sends, Esc goes back. */
export function FeedbackField({
  label,
  placeholder,
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
  submitLabel: string
}) {
  const id = useId()
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <label htmlFor={id} className="text-xs text-cc-fg3">
        {label}
      </label>
      <textarea
        id={id}
        autoFocus
        rows={2}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onSubmit()
          } else if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
          }
        }}
        className="min-h-[60px] w-full resize-none rounded-lg bg-cc-wash px-3 py-2 text-sm text-foreground outline-none placeholder:text-cc-placeholder focus-visible:ring-1 focus-visible:ring-cc-accent"
      />
      <Decision
        end={
          <>
            <OptionButton variant="secondary" onClick={onCancel} title="Esc">
              Back
            </OptionButton>
            <OptionButton variant="primary" onClick={onSubmit} title="Enter">
              {submitLabel}
            </OptionButton>
          </>
        }
      />
    </div>
  )
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/**
 * 1–3 word label for an ACP permission option (the full `name` goes in the tooltip): "Yes, and
 * don't ask again for npm test:* in this project" → Always allow `npm test:*`.
 */
export function optionLabel(o: PermissionOption): ReactNode {
  if (o.kind === "allow_once" && /^(yes|allow)\.?$/i.test(o.name.trim())) return "Allow once"
  if (o.kind === "reject_once" && /^no,? and tell/i.test(o.name)) return "Deny"
  if (o.kind === "reject_always" && /^no\.?$/i.test(o.name.trim())) return "Always deny"
  const pattern = /(\S+(?: \S+)?:\*)/.exec(o.name)?.[1]
  if (o.kind === "allow_always" && pattern)
    return (
      <>
        Always allow <code className="font-mono text-xs">{pattern}</code>
      </>
    )
  if (o.kind === "allow_always" && /^yes,? and don't ask again\.?$/i.test(o.name.trim())) return "Always allow"
  const rest = o.name
    .replace(/^(yes|no),?\s*(and\s+)?/i, "")
    .replace(/\s+(during this session|in this project)$/i, "")
    .trim()
  return rest ? cap(rest) : o.name
}

/** Auto-focus a newly shown card only if the user isn't typing somewhere. */
export function canStealFocus() {
  const a = document.activeElement as HTMLElement | null
  if (!a || a === document.body) return true
  return !(a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)
}

/**
 * The active card's keys from anywhere in its session (desktop: 1–9, Esc, Ctrl+Enter), not while
 * typing in a field or inside a menu or dialog. They arm 400 ms after the card appears so a
 * keystroke already on its way can't answer it. `handle` returns true when it used the key.
 */
export function useCardKeys(ref: RefObject<HTMLElement | null>, handle: false | ((e: globalThis.KeyboardEvent) => boolean)) {
  const shownAt = useRef(0)
  useEffect(() => {
    shownAt.current = performance.now()
  }, [])
  useEffect(() => {
    if (!handle) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      const card = ref.current
      if (!card || e.defaultPrevented || e.isComposing || e.repeat || performance.now() - shownAt.current < 400) return
      const t = e.target as HTMLElement
      if (t !== card && t.closest("input, textarea, [contenteditable=true], [role=menu], [role=dialog], [role=listbox]")) return
      if (t !== document.body && !t.closest("[data-session-view]")?.contains(card)) return
      if (!handle(e)) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  })
}

/**
 * Desktop's exit for a resolved card: fade and fold up over 200 ms (opacity and transform only),
 * answering 1/12 early; at once under reduced motion.
 */
export function leave(el: HTMLElement | null, then: () => void) {
  if (!el || document.documentElement.hasAttribute("data-reduce-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches) return then()
  el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-6px) scaleY(0.96)" }], {
    duration: 200,
    easing: "cubic-bezier(0.165, 0.84, 0.44, 1)",
    fill: "forwards",
  })
  setTimeout(then, 183)
}

/** No modifier keys held. */
export const plain = (e: globalThis.KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
/** Ctrl+Enter (⌘ on macOS), with or without Shift. */
export const modEnter = (e: globalThis.KeyboardEvent) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey
