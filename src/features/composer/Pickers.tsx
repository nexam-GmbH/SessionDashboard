// The settings in the row under the prompt box, like the Claude Code desktop app: the permission
// mode on the left; the model, then effort as its own control, on the right. The model menu has
// the models (1–9 pick), "More models" for older versions, Fast mode and the output style; the
// effort popover is a stepped slider with Ultracode under it. Ctrl/⌘+Shift+M, I, E open the mode,
// model and effort menus. In the desktop app the options come from the installed claude (store
// `caps`); the mock world uses the built-in lists. Menus open and close without animation.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { Check, CircleHelp, TriangleAlert } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandItem, CommandList } from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Kbd } from "@/components/ui/kbd"
import { MOD } from "@/components/common/bits"
import { useApp } from "@/store/app"
import type { Effort, PermissionMode } from "@/lib/model"
import { cn } from "@/lib/utils"
import { EFFORTS, MODELS, MODES, PICKER_EVENT, effortLabel, modeOption, recommendedEffort, type PickerKind } from "./options"

interface Option<T extends string> {
  value: T
  label: string
  note?: string
  icon?: ReactNode
  tone?: "warn"
}

/** The search text of an option (cmdk matches and selects by it). */
const itemValue = (o: { label: string; note?: string; value: string }) => `${o.label} ${o.note ?? ""} ${o.value}`

/** Event-time clock (handlers only). */
const clock = () => Date.now()

/** Claude Code desktop's ghost button (28 px, 8 px radius, secondary ink); the composer's icon buttons add `w-7`. */
export const GHOST =
  "inline-flex h-7 min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-lg text-cc-fg2 outline-none transition-colors duration-[60ms] hover:bg-cc-ghost hover:text-[var(--cc-fg)] focus-visible:shadow-[0_0_0_1px_var(--cc-accent),0_0_0_6px_var(--cc-focus-glow)] disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-cc-ghost-sel data-[state=open]:text-[var(--cc-fg)]"
/** A popup from the composer: 14 px radius, raised surface, panel shadow, 6 px gutter, no open/close animation. */
export const PANEL = "gap-0 rounded-[14px] bg-cc-raised p-1.5 text-[var(--cc-fg)] shadow-[var(--cc-shadow-panel)] ring-0 data-open:animate-none! data-closed:animate-none!"
/** A row of a menu from the composer (28 px, 10 px side padding, 8 px radius, the highlight fill). */
export const MENU_ITEM = "min-h-7 gap-2 rounded-lg px-2.5 py-1 text-sm focus:bg-cc-ghost-sel focus:text-[var(--cc-fg)] data-open:bg-cc-ghost-sel [&_svg]:text-cc-fg2"
/** Bypass permissions and Max effort: warning tone. */
export const WARN = "text-[#895902] dark:text-[#e49c06]"
/** Ultracode's violet ("pro") ink. */
const PRO = "font-medium text-[#5437b8] dark:text-[#a89af0]"
/** A section header in a menu (footnote, medium, muted). */
const HEADER = "px-2.5 py-1 text-[13px] font-medium text-cc-fg2"
const SEP = "mx-2.5 my-1 bg-[rgb(0_0_0/0.1)] dark:bg-[rgb(255_255_255/0.1)]"

/**
 * Ctrl/⌘+Shift+M, I, E open a menu of the prompt box on screen (kept-alive views are display:none,
 * so only a visible trigger answers). `from` is where focus was, to go back to after.
 */
function usePickerShortcut(kind: PickerKind, disabled: boolean | undefined, open: () => void) {
  const ref = useRef<HTMLButtonElement>(null)
  const from = useRef<Element | null>(null)
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<PickerKind>).detail !== kind || disabled || !ref.current?.offsetParent) return
      from.current = document.activeElement
      open()
    }
    window.addEventListener(PICKER_EVENT, on)
    return () => window.removeEventListener(PICKER_EVENT, on)
  }, [kind, disabled, open])
  return { ref, fromRef: from }
}

/** Back to where focus was when a shortcut opened the menu (the prompt box). */
function restoreFocus(e: Event, from: RefObject<Element | null>) {
  const back = from.current
  from.current = null
  if (back instanceof HTMLElement && back.isConnected) {
    e.preventDefault()
    back.focus()
  }
}

function Locked({ reason, children }: { reason?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={-1}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
    </Tooltip>
  )
}

/** The mode menu: a header and a list with descriptions, 1–9 pick. */
function SettingMenu<T extends string>({
  kind,
  title,
  value,
  options,
  onChange,
  trigger,
  disabled,
  disabledReason,
  shortcut,
}: {
  kind: PickerKind
  title: string
  value: T
  options: Option<T>[]
  onChange: (v: T) => void
  trigger: ReactNode
  disabled?: boolean
  disabledReason?: string
  shortcut?: string
}) {
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // the hint shows on hover only: not over the open menu, not again when focus comes back after a pick
  const [tip, setTip] = useState(false)
  const [sel, setSel] = useState("")
  const closedAt = useRef(0)
  const current = options.find((o) => o.value === value)
  const show = () => {
    // opens on the current choice: Enter keeps it, arrows move from it
    setSel(current ? itemValue(current) : "")
    setOpen(true)
  }
  const { ref, fromRef } = usePickerShortcut(kind, disabled, show)
  const pick = (v: T) => {
    onChange(v)
    closedAt.current = clock()
    setOpen(false)
  }
  const button = (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      aria-label={`${title}: ${current?.label ?? value}`}
      aria-keyshortcuts={shortcut ? `Control+Shift+${shortcut}` : undefined}
      className={cn(GHOST, "px-2 @max-[384px]/composer:px-1")}
    >
      {trigger}
    </button>
  )
  if (disabled) return <Locked reason={disabledReason}>{button}</Locked>
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) {
          fromRef.current = null
          show()
        } else {
          setOpen(false)
          closedAt.current = clock()
        }
      }}
    >
      <Tooltip open={tip && !open} onOpenChange={(o) => setTip(o && clock() - closedAt.current > 600)}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {title}
          {shortcut && <Kbd>{`${MOD}+Shift+${shortcut}`}</Kbd>}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className={cn(PANEL, "w-80")}
        onOpenAutoFocus={(e) => {
          // the list takes ↑↓ Enter (cmdk)
          e.preventDefault()
          listRef.current?.focus()
        }}
        onCloseAutoFocus={(e) => restoreFocus(e, fromRef)}
      >
        <Command
          ref={listRef}
          tabIndex={-1}
          loop
          value={sel}
          onValueChange={setSel}
          className="rounded-none bg-transparent p-0 outline-none"
          onKeyDown={(e) => {
            const n = Number(e.key)
            if (n >= 1 && n <= Math.min(9, options.length) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
              e.preventDefault()
              pick(options[n - 1].value)
            }
          }}
        >
          <div className={HEADER}>{title}</div>
          <CommandList className="max-h-[360px]">
            {options.map((o, i) => (
              <CommandItem
                key={o.value}
                value={itemValue(o)}
                onSelect={() => pick(o.value)}
                className={cn("min-h-7 items-start gap-2 rounded-lg px-2.5 py-1 data-selected:bg-cc-ghost-sel [&>svg:last-child]:hidden", o.note && "pb-[9px]")}
              >
                {o.icon && <span className={cn("flex h-5 shrink-0 items-center text-cc-fg2", o.tone === "warn" && WARN)}>{o.icon}</span>}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("truncate text-sm", o.tone === "warn" && WARN)}>{o.label}</span>
                  {o.note && <span className="text-[13px] leading-[17px] text-cc-fg2">{o.note}</span>}
                </span>
                <Slot n={i} on={o.value === value} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** A row's trailing 20 px slot: the accent check when chosen, else its digit (1–9). */
function Slot({ n, on }: { n: number; on: boolean }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[13px] text-cc-fg2 tabular">
      {on ? <Check size={16} className="text-cc-accent!" aria-label="Selected" /> : n < 9 ? n + 1 : null}
    </span>
  )
}

// the trigger's compact labels on a narrow composer (Claude Code desktop)
const SHORT: Partial<Record<PermissionMode, string>> = { acceptEdits: "Accept", bypassPermissions: "Bypass" }

export function ModePicker({ value, onChange, disabled, disabledReason }: { value: PermissionMode; onChange: (v: PermissionMode) => void; disabled?: boolean; disabledReason?: string }) {
  const allowBypass = useApp((s) => s.settings.allowBypass || s.caps?.defaultMode === "bypassPermissions")
  const options = MODES.filter((m) => m.value === value || (m.value === "bypassPermissions" ? allowBypass : m.value !== "dontAsk")).map((m) => ({
    value: m.value,
    label: m.label,
    note: m.note,
    icon: <m.icon size={14} />,
    tone: m.value === "bypassPermissions" ? ("warn" as const) : undefined,
  }))
  const cur = modeOption(value)
  return (
    <SettingMenu
      kind="mode"
      title="Mode"
      shortcut="M"
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      disabledReason={disabledReason}
      trigger={
        <span className={cn("flex min-w-0 items-center gap-1.5", value === "bypassPermissions" && WARN)}>
          <cur.icon size={12} className="shrink-0" />
          <span className={cn("truncate", SHORT[value] && "@max-[480px]/composer:hidden")}>{cur.label}</span>
          {SHORT[value] && <span className="hidden truncate @max-[480px]/composer:inline">{SHORT[value]}</span>}
        </span>
      }
    />
  )
}

/** Models the installed claude offers (aliases like "opus" resolve to a full model id). */
function useModels() {
  const caps = useApp((s) => s.caps?.models)
  return caps?.length
    ? caps.map((m) => ({
        value: m.value,
        label: m.displayName.replace(/ \(recommended\)$/, ""),
        note: m.description,
        resolved: m.resolvedModel,
        efforts: m.supportedEffortLevels,
        fast: m.supportsFastMode,
        // the current family by alias (opus, sonnet, fable, haiku); pinned versions go under "More models"
        main: !m.value.startsWith("claude-"),
      }))
    : MODELS.map((m) => ({ value: m.value as string, label: m.label, note: m.note as string | undefined, resolved: m.value as string, efforts: undefined as string[] | undefined, fast: !m.value.includes("haiku") && !m.value.includes("sonnet"), main: true }))
}
type ModelRow = ReturnType<typeof useModels>[number]

/** The option a session's model matches: by alias, else by the resolved model id. */
function matchModel(models: ModelRow[], model: string) {
  return models.find((m) => m.value === model) ?? models.find((m) => m.resolved === model && m.value !== "default") ?? models.find((m) => m.resolved === model)
}

/** The efforts a model allows (all when the installed claude doesn't say). */
function useEfforts(model?: string) {
  const allowed = matchModel(useModels(), model ?? "")?.efforts
  return EFFORTS.filter((e) => !allowed || allowed.includes(e.value))
}

/** "Opus 5.5 1M" for a model with the 1M context window. */
const modelName = (m: ModelRow | undefined, value: string) => {
  const name = m?.label ?? (value.replace(/^claude-/, "") || "Default model")
  return /\[1m\]|1m context/i.test(`${value} ${m?.resolved ?? ""} ${m?.label ?? ""}`) && !/1M/.test(name) ? `${name} 1M` : name.replace(/ \(1M context\)/i, " 1M")
}

/**
 * The model menu (Claude Code desktop): above the trigger, right-aligned; the current family with
 * 1–9 and the blue check, the host's default marked "Default", older versions under "More models",
 * then `extra` (Fast mode, output style). The trigger reads the model's name (" Fast" when on).
 */
export function ModelPicker({
  value,
  onChange,
  disabled,
  disabledReason,
  extra,
  fast,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  disabledReason?: string
  extra?: ReactNode
  fast?: boolean
}) {
  const all = useModels()
  const appDefault = useApp((s) => s.settings.defaults.model)
  const [open, setOpen] = useState(false)
  const { ref, fromRef } = usePickerShortcut("model", disabled, () => setOpen(true))
  // no "Default" row: the model it stands for carries a "Default" badge
  const aliasDefault = all.find((m) => m.value === "default")?.resolved
  const rows = all.filter((m) => m.value !== "default")
  const resolve = (v: string) => (v === "default" ? rows.find((m) => m.main && m.resolved === aliasDefault) : matchModel(rows, v))
  const cur = resolve(value)
  const def = resolve(appDefault)
  const more = rows.filter((m) => !m.main)
  // an older model in use stays in the main list, at its end
  const main = [...rows.filter((m) => m.main), ...(cur && !cur.main ? [cur] : [])]
  const name = modelName(cur, value)
  const button = (
    <button ref={ref} type="button" disabled={disabled} aria-label={`Model: ${name}${fast ? " Fast" : ""}`} aria-keyshortcuts="Control+Shift+I" className={cn(GHOST, "px-3 @max-[384px]/composer:px-1")}>
      <span className="truncate">
        {name}
        {fast && <span className="whitespace-nowrap text-cc-fg3 @max-[280px]/composer:hidden"> Fast</span>}
      </span>
    </button>
  )
  if (disabled) return <Locked reason={disabledReason}>{button}</Locked>
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        if (o) fromRef.current = null
        setOpen(o)
      }}
    >
      <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={6}
        className={cn(PANEL, "w-max max-w-[min(416px,calc(100vw-16px))] min-w-32")}
        onCloseAutoFocus={(e) => restoreFocus(e, fromRef)}
        onKeyDown={(e) => {
          const n = Number(e.key)
          if (n >= 1 && n <= Math.min(9, main.length) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
            e.preventDefault()
            onChange(main[n - 1].value)
            setOpen(false)
          }
        }}
      >
        {main.map((m, i) => (
          <DropdownMenuItem key={m.value} role="menuitemradio" aria-checked={m === cur} onSelect={() => onChange(m.value)} className={cn(MENU_ITEM, "items-start", m.note && "pb-[9px]")}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{m.label}</span>
                {m === def && <span className="inline-flex h-[22px] shrink-0 items-center rounded-full border border-[rgb(0_0_0/0.16)] px-2 text-xs text-cc-fg2 dark:border-[rgb(255_255_255/0.25)]">Default</span>}
              </span>
              {m.note && <span className="text-[13px] leading-[17px] text-cc-fg2">{m.note}</span>}
            </span>
            <Slot n={i} on={m === cur} />
          </DropdownMenuItem>
        ))}
        {more.length > 0 && (
          <>
            <DropdownMenuSeparator className={SEP} />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={cn(MENU_ITEM, "pr-1.5")}>More models</DropdownMenuSubTrigger>
              <DropdownMenuSubContent sideOffset={2} className={cn(PANEL, "max-h-[50vh] w-max min-w-40 overflow-y-auto")}>
                {more.map((m) => (
                  <DropdownMenuItem key={m.value} role="menuitemradio" aria-checked={m === cur} onSelect={() => onChange(m.value)} className={MENU_ITEM}>
                    <span className="flex-1 truncate">{m.label}</span>
                    <Slot n={9} on={m === cur} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
        {extra}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Effort, its own control right after the model (Claude Code desktop): the level's name (a
 * warning triangle at Max; "· Ultracode" in violet when on), opening a 220 px popover with a
 * stepped slider from "Faster" to "Smarter", the "Recommended" mark and, given `onUltra`, the
 * Ultracode switch. The New session screen shows it without Ultracode.
 */
export function EffortPicker({
  value,
  model,
  onChange,
  disabled,
  disabledReason,
  ultra,
  onUltra,
}: {
  value: Effort
  model?: string
  onChange: (v: Effort) => void
  disabled?: boolean
  disabledReason?: string
  ultra?: boolean
  onUltra?: (on: boolean) => void
}) {
  const levels = useEfforts(model)
  // the recommended level goes by the model's id (an alias like "opus" by what it resolves to)
  const resolved = matchModel(useModels(), model ?? "")?.resolved ?? model ?? ""
  const [open, setOpen] = useState(false)
  // opened from the keyboard: focus goes to the slider (else to the popover)
  const [byKey, setByKey] = useState(false)
  const { ref, fromRef } = usePickerShortcut("effort", disabled, () => {
    setByKey(true)
    setOpen(true)
  })
  if (!levels.length) return null
  const name = effortLabel(value)
  const max = value === "max"
  const button = (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      aria-label={`Effort: ${name}${max ? " High usage" : ""}${ultra ? ", Ultracode" : ""}`}
      aria-keyshortcuts="Control+Shift+E"
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setByKey(true)}
      className={cn(GHOST, "px-3 @max-[384px]/composer:px-1")}
    >
      {max && <TriangleAlert size={12} className="shrink-0 fill-[#fbb315] text-cc-raised" aria-hidden />}
      <span className={cn("truncate", ultra && PRO)}>
        {name}
        {ultra && <span className="whitespace-nowrap @max-[280px]/composer:hidden"> · Ultracode</span>}
      </span>
    </button>
  )
  if (disabled) return <Locked reason={disabledReason}>{button}</Locked>
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) fromRef.current = null
        else setByKey(false)
        setOpen(o)
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className={cn(max && "max-w-60 flex-col items-start")}>
          <span>
            Effort <Kbd>{MOD}+Shift+E</Kbd>
          </span>
          {max && <span className="opacity-70">Claude thinks longer with Max effort and uses your limits faster than High.</span>}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        tabIndex={-1}
        className={cn(PANEL, "w-[220px] gap-7 p-4 outline-none select-none")}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const el = e.currentTarget as HTMLElement
          ;(byKey ? el.querySelector<HTMLElement>("[role=slider]") : el)?.focus()
        }}
        onCloseAutoFocus={(e) => restoreFocus(e, fromRef)}
      >
        <EffortBody levels={levels} value={value} onChange={onChange} ultra={!!ultra} onUltra={onUltra} recommended={recommendedEffort(resolved)} />
      </PopoverContent>
    </Popover>
  )
}

const W = 188 // the slider's width: the 220 px popover less its 16 px padding

/** The popover's content: header with the live level, the slider, the Max warning, Ultracode. */
function EffortBody({
  levels,
  value,
  onChange,
  ultra,
  onUltra,
  recommended,
}: {
  levels: typeof EFFORTS
  value: Effort
  onChange: (v: Effort) => void
  ultra: boolean
  onUltra?: (on: boolean) => void
  recommended: Effort
}) {
  const n = levels.length
  const committed = Math.max(0, levels.findIndex((l) => l.value === value))
  // the level under the thumb while dragging, and which way the label last moved
  const [live, setLive] = useState<number | null>(null)
  const [dir, setDir] = useState(1)
  const [dragging, setDragging] = useState(false)
  const at = live ?? committed
  const rec = levels.findIndex((l) => l.value === recommended)
  const box = useRef<{ left: number } | null>(null)
  const move = (i: number) => {
    const to = Math.max(0, Math.min(n - 1, i))
    if (to !== at) setDir(to > at ? 1 : -1)
    setLive(to)
  }
  const commit = (i: number) => {
    setLive(null)
    if (levels[i] && levels[i].value !== value) onChange(levels[i].value)
  }
  const stopAt = (clientX: number) => (n < 2 ? 0 : Math.round(((clientX - (box.current?.left ?? 0) - 10) / (W - 20)) * (n - 1)))
  // thumb centre from 10 to W − 10; the dots from 12 to W − 12
  const thumbX = n < 2 ? W / 2 : 10 + (at * (W - 20)) / (n - 1)
  const dotX = (i: number) => (n < 2 ? W / 2 : 12 + (i * (W - 24)) / (n - 1))
  const label = levels[at]?.label ?? ""
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-3 text-sm">
          <span className="text-cc-fg2">Effort</span>
          <span className="relative overflow-hidden">
            {/* the new level slides in from below (up a level) or above, as in the desktop app */}
            <span key={label} className={cn("block animate-in duration-200 ease-[var(--cc-ease-out)] fade-in in-data-[reduce-motion]:animate-none", dir > 0 ? "slide-in-from-bottom-[0.55em]" : "slide-in-from-top-[0.55em]", ultra && PRO)}>
              {label}
            </span>
          </span>
        </div>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button type="button" aria-label="About effort" className="rounded-full text-cc-fg2 outline-none hover:text-[var(--cc-fg)] focus-visible:shadow-[0_0_0_1px_var(--cc-accent),0_0_0_6px_var(--cc-focus-glow)]">
              <CircleHelp size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="end" sideOffset={8} className="w-[220px] flex-col items-start gap-1">
            <span className="font-medium">Effort</span>
            <span className="opacity-80">Higher effort means more thorough responses, but takes longer and uses your limits faster.</span>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex justify-between text-[13px] text-cc-fg2" dir="ltr">
          <span>Faster</span>
          <span>Smarter</span>
        </div>
        <div className="flex flex-col gap-2">
          <div
            role="slider"
            tabIndex={0}
            aria-label="Effort"
            aria-valuemin={0}
            aria-valuemax={n - 1}
            aria-valuenow={at}
            aria-valuetext={at === rec ? `${label} (Recommended)` : label}
            className="group/slider relative h-7 touch-none outline-none"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              box.current = { left: e.currentTarget.getBoundingClientRect().left }
              setDragging(true)
              move(stopAt(e.clientX))
            }}
            onPointerMove={(e) => box.current && move(stopAt(e.clientX))}
            onPointerUp={() => {
              box.current = null
              setDragging(false)
              commit(at)
            }}
            onPointerCancel={() => {
              box.current = null
              setDragging(false)
              setLive(null)
            }}
            onKeyDown={(e) => {
              const to = { ArrowLeft: at - 1, ArrowDown: at - 1, ArrowRight: at + 1, ArrowUp: at + 1, Home: 0, End: n - 1 }[e.key]
              if (to === undefined) return
              e.preventDefault()
              move(to)
            }}
            onKeyUp={() => live !== null && commit(at)}
          >
            <div className="absolute inset-x-0 inset-y-0.5 overflow-hidden rounded-lg bg-[rgb(0_0_0/0.1)] dark:bg-[rgb(255_255_255/0.1)]">
              {/* the fill: a full-width layer slid left so it ends at the thumb, its content slid back (transforms only) */}
              <div className="absolute inset-0 overflow-hidden transition-transform duration-[120ms] ease-[var(--cc-ease-out)]" style={{ transform: `translateX(${thumbX - W}px)` }}>
                <div className="absolute inset-0 transition-transform duration-[120ms] ease-[var(--cc-ease-out)]" style={{ transform: `translateX(${W - thumbX}px)` }}>
                  <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent,rgb(0_0_0/0.2)_20px)] dark:bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.35)_20px)]" />
                  {ultra && <UltraGlow />}
                </div>
              </div>
              {levels.map((l, i) => (
                <span
                  key={l.value}
                  title={i === rec ? `${l.label} (Recommended)` : l.label}
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 px-2 py-2.5"
                  style={{ left: dotX(i) }}
                >
                  <span className={cn("block w-[3px] rounded-full bg-[rgb(0_0_0/0.25)] dark:bg-[rgb(255_255_255/0.25)]", i === rec ? "h-[9px]" : "h-[3px]")} />
                </span>
              ))}
            </div>
            <span
              className={cn(
                "pointer-events-none absolute top-0.5 left-0 h-6 w-5 rounded-lg bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.04),0_0_12px_rgb(0_0_0/0.06)] transition-[transform,scale] duration-[120ms] ease-[var(--cc-ease-out)] group-focus-visible/slider:shadow-[0_0_0_1px_var(--cc-accent),0_0_0_6px_var(--cc-focus-glow)] dark:shadow-[0_0_12px_rgb(0_0_0/0.24)]",
                dragging && "scale-[1.12] ease-[var(--cc-ease-overshoot)]",
              )}
              style={{ transform: `translateX(${thumbX - 10}px)` }}
            />
          </div>
          {rec >= 0 && (
            <div className="relative h-[17px] text-[13px] leading-[17px]">
              <span className={cn("absolute -translate-x-1/2 whitespace-nowrap", at === rec ? "text-cc-fg2" : "text-cc-fg3")} style={{ left: dotX(rec) }}>
                Recommended
              </span>
            </div>
          )}
        </div>
        {value === "max" && (
          <p className={cn("flex gap-2 text-[13px] leading-[17px]", WARN)}>
            <TriangleAlert size={12} className="mt-0.5 shrink-0 fill-[#fbb315] text-cc-raised" aria-hidden />
            Claude thinks longer with Max effort and uses your limits faster than High.
          </p>
        )}
      </div>
      {onUltra && (
        <label className="flex cursor-pointer items-start justify-between gap-3">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className={cn("truncate text-sm", ultra && PRO)}>Ultracode</span>
            <span className="text-[13px] leading-[17px] text-cc-fg2">Lets Claude run many subagents on big tasks</span>
          </span>
          <Switch size="sm" checked={ultra} onCheckedChange={onUltra} aria-label="Ultracode" className="mt-0.5 data-checked:bg-[#5437b8] dark:data-checked:bg-[#a89af0]" />
        </label>
      )}
    </>
  )
}

/**
 * Ultracode's glow in the slider's fill: a violet "charged" ground with a cell grid and a sheen
 * that keeps crossing it. One small element animating its background (no script, no canvas); only
 * while the popover is open with Ultracode on, still under reduced motion.
 */
function UltraGlow() {
  return (
    <div className="absolute inset-0 animate-in duration-700 ease-out fade-in in-data-[reduce-motion]:animate-none">
      <div className="absolute inset-0 animate-[cc-rainbow_2.4s_linear_infinite] bg-[linear-gradient(120deg,transparent_40%,rgb(255_255_255/0.55)_50%,transparent_60%),radial-gradient(circle,rgb(255_255_255/0.5)_0.9px,transparent_1.3px),linear-gradient(90deg,transparent,#888edd_45%,#8964c4)] bg-size-[300%_100%,4px_4px,100%_100%] motion-reduce:animate-none in-data-[reduce-motion]:animate-none dark:bg-[linear-gradient(120deg,transparent_40%,rgb(255_255_255/0.4)_50%,transparent_60%),radial-gradient(circle,rgb(255_255_255/0.35)_0.9px,transparent_1.3px),linear-gradient(90deg,transparent,#9e80eb_60%,#594099)]" />
    </div>
  )
}

// why claude can't serve fast mode (its own wording); "sdk_opt_in_required" is not listed because
// the app opts in by passing the setting itself
const FAST_BLOCKED: Record<string, string> = {
  not_first_party: "Fast mode is only available when Claude Code uses the Claude API directly.",
  disabled_by_env: "An environment variable turns fast mode off in this session.",
  model_not_allowed: "This model is not in your organization's allowed models.",
  free: "Fast mode runs on usage credits, which aren't available on your account.",
  preference: "Fast mode isn't available for your organization at this time.",
  extra_usage_disabled: "Fast mode requires usage credits. Turn them on under Usage.",
}

/** A switch row in the model menu: toggles without closing it. */
function SwitchRow({ label, checked, onChange, disabled, reason, pro }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; reason?: string; pro?: boolean }) {
  return (
    <DropdownMenuItem
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      title={reason}
      onSelect={(e) => {
        e.preventDefault()
        onChange(!checked)
      }}
      className={cn(MENU_ITEM, "data-disabled:pointer-events-auto")}
    >
      <span className={cn("flex-1 truncate", checked && pro && PRO)}>{label}</span>
      <Switch size="sm" checked={checked} disabled={disabled} tabIndex={-1} aria-hidden className={cn("pointer-events-none", pro && "data-checked:bg-[#5437b8] dark:data-checked:bg-[#a89af0]")} />
    </DropdownMenuItem>
  )
}

/**
 * The model menu's end: "Fast mode" (on models that have it) and the output style. `ultra` given
 * (the New session screen, which has no Ultracode switch elsewhere): an Ultracode row too.
 */
export function ModelExtras({
  model,
  fast,
  ultra,
  style,
  onChange,
}: {
  model: string
  fast: boolean
  ultra?: boolean
  style?: string
  onChange: (patch: { fastMode?: boolean; ultracode?: boolean; outputStyle?: string }) => void
}) {
  const models = useModels()
  const reason = useApp((s) => s.caps?.fastModeDisabledReason)
  const styles = useApp((s) => s.caps?.outputStyles) ?? ["default", "Explanatory", "Learning"]
  const m = matchModel(models, model)
  const blocked = reason ? (FAST_BLOCKED[reason] ?? "Fast mode isn't available for your organization at this time.") : undefined
  const cur = style ?? "default"
  const styleName = (v: string) => (v === "default" ? "Default" : v)
  return (
    <>
      {m?.fast !== false && (
        <>
          <DropdownMenuSeparator className={SEP} />
          <DropdownMenuLabel className={HEADER}>Fast mode</DropdownMenuLabel>
          <SwitchRow label="Enable fast mode" checked={fast && !blocked} onChange={(v) => onChange({ fastMode: v })} disabled={!!blocked} reason={blocked} />
        </>
      )}
      <DropdownMenuSeparator className={SEP} />
      {ultra !== undefined && <SwitchRow label="Ultracode" pro checked={ultra} onChange={(v) => onChange({ ultracode: v })} />}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className={cn(MENU_ITEM, "pr-1.5")}>
          Output style
          <span className="ml-auto max-w-40 truncate pl-2 text-[13px] text-cc-fg2">{styleName(cur)}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent sideOffset={2} className={cn(PANEL, "w-max min-w-36")}>
          {styles.map((v) => (
            <DropdownMenuItem key={v} role="menuitemradio" aria-checked={v === cur} onSelect={() => onChange({ outputStyle: v })} className={MENU_ITEM}>
              <span className="flex-1 truncate">{styleName(v)}</span>
              <Slot n={9} on={v === cur} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  )
}
