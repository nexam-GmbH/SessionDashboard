// Adapted from agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/ApprovalCard.tsx (MIT). Modified for session-dashboard.
// Shared chrome for attention cards (permission, question, plan): one bordered block with
// a tinted title line (icon · title · meta · aside · pager), an optional body and the
// action row. Changes: status tokens (perm orange / input amber), a compact "1/2" pager,
// calm copy: short option labels with the full ACP name as tooltip, keyboard
// hints only while the card has focus.
import { forwardRef, useId, type KeyboardEvent, type ReactNode } from "react"
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { PermissionOption } from "@/lib/model"
import { MOD } from "@/components/common/bits"
import { cn } from "@/lib/utils"

/** Keyboard focus ring for the cards' own buttons (the shadcn Button's ring: 1px `ring`). */
export const FOCUS = "outline-none focus-visible:ring-1 focus-visible:ring-ring"

export interface Pager {
  index: number
  total: number
  onPrev: () => void
  onNext: () => void
}

export const CardFrame = forwardRef<
  HTMLElement,
  {
    tone: "perm" | "input"
    icon?: ReactNode
    title: ReactNode
    meta?: ReactNode
    /** right side of the title line, before the pager (e.g. a details toggle) */
    aside?: ReactNode
    pager?: Pager
    children?: ReactNode
    footer?: ReactNode
    /** left of the buttons (a note: "Approve in your terminal") */
    footerNote?: ReactNode
    onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void
    className?: string
    label: string
    /** keyboard model for screen readers (the visible key hints only show while focused) */
    keyHint?: string
  }
>(function CardFrame({ title, meta, aside, pager, children, footer, footerNote, onKeyDown, className, label, keyHint }, ref) {
  const hintId = useId()
  return (
    // Claude Code desktop's request card, in the conversation: a plain bordered block, the question
    // in bold, what it is about under it, the answers bottom right. A labelled region: focus lands
    // here when a request arrives, and screen reader users can jump to it
    <section
      ref={ref}
      role="region"
      aria-label={label}
      aria-describedby={keyHint ? hintId : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn("group/card my-2 rounded-xl border border-foreground/12 bg-background px-4 pt-3.5 pb-3 outline-none focus-visible:border-foreground/25", className)}
    >
      <header className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[15px] leading-6 font-semibold text-foreground">{title}</div>
        {meta && <div className="flex h-6 shrink-0 items-center gap-2">{meta}</div>}
        {aside}
        {pager && pager.total > 1 && (
          <span className="flex h-6 shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
            <button type="button" aria-label="Previous request" onClick={pager.onPrev} className={cn("inline-flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground", FOCUS)}>
              <ChevronLeft size={14} />
            </button>
            <span className="tabular">
              <span aria-hidden>
                {pager.index + 1} of {pager.total}
              </span>
              <span className="sr-only">
                Request {pager.index + 1} of {pager.total}
              </span>
            </span>
            <button type="button" aria-label="Next request" onClick={pager.onNext} className={cn("inline-flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground", FOCUS)}>
              <ChevronRight size={14} />
            </button>
          </span>
        )}
        {keyHint && (
          <span id={hintId} className="sr-only">
            {keyHint}
          </span>
        )}
      </header>
      {children && <div className="mt-1.5 flex flex-col gap-2 text-sm text-muted-foreground">{children}</div>}
      {footer && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {footerNote && <span className="mr-auto text-xs text-muted-foreground/70">{footerNote}</span>}
          {footer}
        </div>
      )}
    </section>
  )
})

/** Key chips inside a button ("⇧ Ctrl ↵"), the way Claude Code desktop labels its card buttons. */
export function KeyChips({ keys, dark }: { keys: string[]; dark?: boolean }) {
  return (
    <span aria-hidden className="ml-1 hidden items-center gap-0.5 sm:inline-flex">
      {keys.map((k) => (
        <kbd
          key={k}
          className={cn(
            "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border px-1 font-sans text-[11px] leading-none",
            dark ? "border-background/25 text-background/70" : "border-foreground/15 text-muted-foreground",
          )}
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}

/** Small chevron that reveals a card's secondary details (cwd, description). */
export function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? "Hide details" : "Show details"}
      title={open ? "Hide details" : "Details"}
      onClick={onToggle}
      className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground", FOCUS)}
    >
      <ChevronRight size={12} className={cn("transition-transform duration-150", open && "rotate-90")} />
    </button>
  )
}

/** Inline "tell Claude what to do differently" field; Cmd/Ctrl+Enter submits. */
export function FeedbackField({
  placeholder,
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  placeholder: string
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
  submitLabel: string
}) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <textarea
        autoFocus
        rows={2}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder.replace(/\s*\(optional\)$/, "")}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onSubmit()
          } else if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
          }
        }}
        className="min-h-[52px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-[18px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-input"
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onSubmit}
          title={`${MOD}+Enter`}
          className={cn("inline-flex h-6 items-center rounded-md border border-border bg-muted px-2 text-xs text-foreground hover:border-input hover:bg-accent", FOCUS)}
        >
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} title="Esc" className={cn("h-6 rounded-md px-2 text-xs text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground", FOCUS)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** A card's answer button: Deny gray, the main answer white, key chips inside (Claude Code desktop). */
export function OptionButton({
  n,
  children,
  variant,
  onClick,
  disabled,
  enter,
  keys,
  title,
}: {
  /** its number key (1–9) while the card has focus; none when 0 */
  n?: number
  children: ReactNode
  variant: "primary" | "secondary" | "quiet"
  onClick: () => void
  disabled?: boolean
  /** this option is taken by Enter while the card has focus */
  enter?: boolean
  /** a shortcut that works anywhere in the session ("Ctrl ↵") */
  keys?: string[]
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45",
        FOCUS,
        // on the light primary the ring needs an offset to stay visible
        variant === "primary" && "bg-foreground text-background hover:bg-foreground/88 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        variant === "secondary" && "bg-secondary text-foreground hover:bg-accent",
        variant === "quiet" && "bg-secondary text-foreground hover:bg-accent",
      )}
    >
      {!!n && <span aria-hidden className={cn("tabular hidden text-xs group-focus-within/card:inline", variant === "primary" ? "text-background/55" : "text-muted-foreground/70")}>{n}</span>}
      <span className="min-w-0 truncate">{children}</span>
      {keys ? <KeyChips keys={keys} dark={variant === "primary"} /> : enter && <span aria-hidden className={cn("hidden text-xs group-focus-within/card:inline", variant === "primary" ? "text-background/55" : "text-muted-foreground/70")}>⏎</span>}
    </button>
  )
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/**
 * 1–3 word label for an ACP permission option (the full `name` goes in the tooltip):
 * "Yes" → Allow once (the same label as map cards and the inspector), "Yes, and don't ask again
 * for npm test:* in this project" → Always allow
 * `npm test:*`, "No, keep planning" → Keep planning.
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

/** A ⌄ beside a card's main answer with its other ways (Claude Code desktop: "Allow and switch to Auto"). */
export function MoreAnswers({ items, disabled, label = "More options" }: { items: { label: string; onSelect: () => void; danger?: boolean }[]; disabled?: boolean; label?: string }) {
  if (!items.length) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          title={label}
          className={cn("-ml-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-45 data-[state=open]:bg-accent", FOCUS)}
        >
          <ChevronDown size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {items.map((it) => (
          <DropdownMenuItem key={it.label} variant={it.danger ? "destructive" : undefined} onSelect={it.onSelect}>
            {it.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
