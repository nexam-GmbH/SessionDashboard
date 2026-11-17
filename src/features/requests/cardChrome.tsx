// Adapted from agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/ApprovalCard.tsx (MIT). Modified for session-dashboard.
// Shared chrome of the request cards, shaped after Claude Code desktop's approval card: docked in
// place of the prompt box while it is the active request, or a plain card in the conversation.
import { forwardRef, useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react"
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
        docked ? "max-h-[max(60vh,16rem)] bg-cc-panel shadow-[var(--cc-shadow-panel)]" : "my-3 max-w-[480px] bg-cc-card ring-1 ring-cc-wash-2",
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
      {children && <div className="-mx-3 flex min-h-0 flex-col gap-3 overflow-y-auto px-3">{children}</div>}
      {footer}
    </section>
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

const VARIANT = {
  primary: "bg-cc-primary font-medium text-cc-on-primary hover:bg-cc-primary-hover",
  secondary: "bg-secondary text-foreground hover:bg-[var(--cc-secondary-hover)]",
  ghost: "text-cc-fg2 hover:bg-cc-ghost hover:text-foreground",
}

/** Desktop's button: 28 px, radius 8, 14 px text; a short label at tight widths. */
export function OptionButton({
  children,
  short,
  variant,
  onClick,
  disabled,
  keys,
  title,
  className,
}: {
  children: ReactNode
  /** label at card widths ≤ 500 px */
  short?: ReactNode
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
        "inline-flex h-7 max-w-full min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-sm whitespace-nowrap transition-colors duration-[60ms] disabled:pointer-events-none disabled:opacity-40",
        FOCUS,
        VARIANT[variant],
        className,
      )}
    >
      {short ? (
        <>
          <span className="min-w-0 truncate @max-[500px]:hidden">{children}</span>
          <span className="hidden min-w-0 truncate @max-[500px]:inline">{short}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">{children}</span>
      )}
      {keys && <KeyCaps keys={keys} onPrimary={variant === "primary"} />}
    </button>
  )
}

/** A primary split button: `children` is the main button, the caret opens its other answers ("More allow options"). */
export function Split({
  children,
  label,
  items,
  disabled,
}: {
  children: ReactNode
  label: string
  items: { label: string; hint?: string; danger?: boolean; onSelect: () => void }[]
  disabled?: boolean
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
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-e-lg border-s border-cc-on-primary/20 bg-cc-primary text-cc-on-primary hover:bg-cc-primary-hover disabled:pointer-events-none disabled:opacity-40",
              FOCUS,
            )}
          >
            <ChevronDown size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {items.map((it) => (
            <DropdownMenuItem key={it.label} variant={it.danger ? "destructive" : undefined} onSelect={it.onSelect} className="flex-col items-start gap-0">
              {it.label}
              {it.hint && <span className="text-xs text-muted-foreground">{it.hint}</span>}
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

/** No modifier keys held. */
export const plain = (e: globalThis.KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
/** Ctrl+Enter (⌘ on macOS), with or without Shift. */
export const modEnter = (e: globalThis.KeyboardEvent) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey
