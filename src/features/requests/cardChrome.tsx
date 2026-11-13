// Adapted from agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/ApprovalCard.tsx (MIT). Modified for session-dashboard.
// Shared chrome for attention cards (permission, question, plan): one bordered block with
// a tinted title line (icon · title · meta · aside · pager), an optional body and the
// action row. Changes: status tokens (perm orange / input amber), a compact "1/2" pager,
// calm copy (§2.5): short option labels with the full ACP name as tooltip, keyboard
// hints only while the card has focus.
import { forwardRef, type KeyboardEvent, type ReactNode } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import type { PermissionOption } from "@/lib/model"
import { MOD } from "@/components/common/bits"
import { cn } from "@/lib/utils"

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
    icon: ReactNode
    title: ReactNode
    meta?: ReactNode
    /** right side of the title line, before the pager (e.g. a details toggle) */
    aside?: ReactNode
    pager?: Pager
    children?: ReactNode
    footer?: ReactNode
    onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void
    className?: string
    label: string
  }
>(function CardFrame({ tone, icon, title, meta, aside, pager, children, footer, onKeyDown, className, label }, ref) {
  return (
    <section
      ref={ref}
      role="alertdialog"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        "group/card overflow-hidden rounded-[6px] border bg-elevated outline-none focus-visible:ring-1 focus-visible:ring-brand/70",
        tone === "perm" ? "border-st-perm/45" : "border-st-input/40",
        className,
      )}
    >
      <header className={cn("flex min-h-8 min-w-0 items-center gap-2 px-2.5 py-1", tone === "perm" ? "bg-st-perm-tint/70" : "bg-st-input-tint/70")}>
        <span className={cn("inline-flex shrink-0", tone === "perm" ? "text-st-perm" : "text-st-input")}>{icon}</span>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px] leading-[18px] font-medium text-fg">{title}</div>
        {meta}
        {aside}
        {pager && pager.total > 1 && (
          <span className="flex shrink-0 items-center text-[11px] text-fg-faint">
            <button type="button" aria-label="Previous request" onClick={pager.onPrev} className="inline-flex size-5 items-center justify-center rounded-[3px] hover:bg-hover hover:text-fg">
              <ChevronLeft size={12} />
            </button>
            <span className="tabular" title="Pending requests">
              {pager.index + 1}/{pager.total}
            </span>
            <button type="button" aria-label="Next request" onClick={pager.onNext} className="inline-flex size-5 items-center justify-center rounded-[3px] hover:bg-hover hover:text-fg">
              <ChevronRight size={12} />
            </button>
          </span>
        )}
      </header>
      {children && <div className="border-t border-line-subtle/60 px-2.5 py-2">{children}</div>}
      {footer && <div className="flex flex-wrap items-center gap-1.5 border-t border-line-subtle/60 px-2.5 py-2">{footer}</div>}
    </section>
  )
})

/** Small chevron that reveals a card's secondary details (cwd, description). */
export function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? "Hide details" : "Show details"}
      title={open ? "Hide details" : "Details"}
      onClick={onToggle}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-[3px] text-fg-faint hover:bg-hover hover:text-fg"
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
        className="min-h-[52px] w-full resize-y rounded-[4px] border border-line bg-canvas px-2 py-1.5 text-[12.5px] leading-[18px] text-fg outline-none placeholder:text-fg-faint focus:border-brand/60"
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onSubmit}
          title={`${MOD}+Enter`}
          className="inline-flex h-6 items-center rounded-[4px] border border-line bg-elevated px-2 text-[12px] text-fg hover:border-line-strong hover:bg-hover"
        >
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} title="Esc" className="h-6 rounded-[4px] px-2 text-[12px] text-fg-faint hover:bg-hover hover:text-fg-muted">
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Option button; its number key and the ⏎ hint show only while the card has focus. */
export function OptionButton({
  n,
  children,
  variant,
  onClick,
  disabled,
  enter,
  title,
}: {
  n: number
  children: ReactNode
  variant: "primary" | "secondary" | "quiet"
  onClick: () => void
  disabled?: boolean
  /** this option is taken by Enter */
  enter?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-[4px] border px-2 text-[12px] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45",
        variant === "primary" && "border-transparent bg-brand text-white hover:bg-[#0588f0]",
        variant === "secondary" && "border-line bg-elevated text-fg hover:border-line-strong hover:bg-hover",
        variant === "quiet" && "border-transparent text-fg-muted hover:bg-hover hover:text-fg",
      )}
    >
      <span className={cn("tabular hidden text-[10.5px] group-focus-within/card:inline", variant === "primary" ? "text-white/70" : "text-fg-faint")}>{n}</span>
      <span className="min-w-0 truncate">{children}</span>
      {enter && <span className="hidden text-[10.5px] text-white/70 group-focus-within/card:inline">⏎</span>}
    </button>
  )
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/**
 * 1–3 word label for an ACP permission option (the full `name` goes in the tooltip):
 * "Yes" → Allow, "Yes, and don't ask again for npm test:* in this project" → Always allow
 * `npm test:*`, "No, keep planning" → Keep planning.
 */
export function optionLabel(o: PermissionOption): ReactNode {
  if (o.kind === "allow_once" && /^(yes|allow)\.?$/i.test(o.name.trim())) return "Allow"
  if (o.kind === "reject_once" && /^no,? and tell/i.test(o.name)) return "Deny"
  if (o.kind === "reject_always" && /^no\.?$/i.test(o.name.trim())) return "Always deny"
  const pattern = /(\S+(?: \S+)?:\*)/.exec(o.name)?.[1]
  if (o.kind === "allow_always" && pattern)
    return (
      <>
        Always allow <code className="font-mono text-[11.5px]">{pattern}</code>
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
