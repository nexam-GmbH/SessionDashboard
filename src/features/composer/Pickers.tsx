// The settings in the row under the prompt box, like the Claude Code desktop app: permission
// mode, and the model with its effort (Fast mode, Ultracode and output style inside that menu).
// Each menu is a short list that opens upward; 1–9 pick, ↑↓ move; Ctrl/⌘+Shift+M, I, E open the
// mode, model and effort menus. In the desktop app the options come from the installed claude
// (store `caps`); the mock world uses the built-in lists.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Check } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Kbd } from "@/components/ui/kbd"
import { MOD } from "@/components/common/bits"
import { useApp } from "@/store/app"
import type { Effort, PermissionMode } from "@/lib/model"
import { cn } from "@/lib/utils"
import { EFFORTS, MODELS, MODES, PICKER_EVENT, effortLabel, modeOption, type PickerKind } from "./options"

interface Option<T extends string> {
  value: T
  label: string
  note?: string
  icon?: ReactNode
  tone?: "warn"
  /** options with a group are listed under its heading, after the ungrouped ones */
  group?: string
}

/** The search text of an option (cmdk matches and selects by it). */
const itemValue = (o: { label: string; note?: string; value: string }) => `${o.label} ${o.note ?? ""} ${o.value}`

/** Event-time clock (handlers only). */
const clock = () => Date.now()

/** Claude Code desktop's ghost button (28 px, 8 px radius, secondary ink); the composer's icon buttons add `w-7`. */
export const GHOST =
  "inline-flex h-7 min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-lg text-cc-fg2 outline-none transition-colors duration-[60ms] hover:bg-cc-ghost hover:text-[var(--cc-fg)] focus-visible:shadow-[0_0_0_1px_var(--cc-accent),0_0_0_6px_var(--cc-focus-glow)] disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-cc-ghost-sel data-[state=open]:text-[var(--cc-fg)]"
/** A menu that opens from the composer: 12 px radius, raised surface, panel shadow, 6 px gutter. */
export const PANEL = "gap-0 rounded-xl bg-cc-raised p-1.5 text-[var(--cc-fg)] shadow-[var(--cc-shadow-panel)] ring-0 duration-[120ms]"
/** A row of a dropdown menu opened from the composer (28 px, 12 px side padding, 8 px radius). */
export const MENU_ITEM = "min-h-7 gap-2 rounded-lg px-3 py-1 focus:bg-cc-ghost-sel focus:text-[var(--cc-fg)] data-open:bg-cc-ghost-sel [&_svg]:text-cc-fg2"
/** Bypass permissions and Max effort: warning tone. */
export const WARN = "text-amber-700 dark:text-cc-warn"

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

function SettingMenu<T extends string>({
  kinds,
  title,
  value,
  options,
  onChange,
  trigger,
  disabled,
  disabledReason,
  shortcut,
  extra,
  align = "start",
  width = 320,
}: {
  extra?: ReactNode
  align?: "start" | "end"
  /** the shortcuts (Ctrl+Shift+M / I / E) that open this menu; the first is the tooltip's */
  kinds?: PickerKind[]
  title: string
  value: T
  options: Option<T>[]
  onChange: (v: T) => void
  trigger: ReactNode
  disabled?: boolean
  disabledReason?: string
  shortcut?: string
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // the hint shows on hover only: not over the open menu, not again when focus comes back after a pick
  const [tip, setTip] = useState(false)
  const [sel, setSel] = useState("")
  const closedAt = useRef(0)
  // opened by its shortcut while typing: focus goes back to the prompt box after
  const from = useRef<{ kind: PickerKind; el: Element | null } | null>(null)
  useEffect(() => {
    if (!kinds) return
    const on = (e: Event) => {
      const kind = (e as CustomEvent<PickerKind>).detail
      // only the prompt box on screen answers (kept-alive views are display:none)
      if (kinds.includes(kind) && !disabled && ref.current?.offsetParent) {
        const cur = options.find((o) => o.value === value)
        from.current = { kind, el: document.activeElement }
        setSel(cur ? itemValue(cur) : "")
        setOpen(true)
      }
    }
    window.addEventListener(PICKER_EVENT, on)
    return () => window.removeEventListener(PICKER_EVENT, on)
  }, [kinds, disabled, options, value])
  const pick = (v: T) => {
    onChange(v)
    closedAt.current = clock()
    setOpen(false)
  }
  const groups = [undefined, ...new Set(options.map((o) => o.group).filter(Boolean))] as (string | undefined)[]
  const item = (o: Option<T>, i: number) => (
    <CommandItem key={o.value} value={itemValue(o)} onSelect={() => pick(o.value)} className="min-h-7 items-start gap-2 rounded-lg px-3 py-1 data-selected:bg-cc-ghost-sel [&>svg:last-child]:hidden">
      {o.icon && <span className={cn("flex h-5 shrink-0 items-center text-cc-fg2", o.tone === "warn" && WARN)}>{o.icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-sm", o.tone === "warn" && WARN)}>{o.label}</span>
        {o.note && <span className="text-[13px] leading-[17px] text-cc-fg3">{o.note}</span>}
      </span>
      {o.value === value ? <Check size={14} className="mt-[3px] shrink-0" /> : i < 9 ? <span className="tabular w-3.5 shrink-0 text-center text-xs leading-5 text-cc-fg3">{i + 1}</span> : <span className="w-3.5 shrink-0" />}
    </CommandItem>
  )
  const current = options.find((o) => o.value === value)
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
        setOpen(o)
        // opens on the current choice: Enter keeps it, arrows move from it
        if (o) {
          from.current = null
          setSel(current ? itemValue(current) : "")
        } else closedAt.current = clock()
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
        align={align}
        sideOffset={6}
        style={{ width }}
        className={PANEL}
        onOpenAutoFocus={(e) => {
          // focus the list (cmdk takes ↑↓ Enter there), or the effort row for Ctrl+Shift+E
          e.preventDefault()
          const effort = from.current?.kind === "effort" && listRef.current?.parentElement?.querySelector<HTMLElement>("[data-effort][aria-checked=true]")
          ;(effort || listRef.current)?.focus()
        }}
        onCloseAutoFocus={(e) => {
          const back = from.current?.el
          if (back instanceof HTMLElement && back.isConnected) {
            e.preventDefault()
            back.focus()
          }
          from.current = null
        }}
      >
        <Command
          ref={listRef}
          tabIndex={-1}
          loop
          value={sel}
          onValueChange={setSel}
          className="bg-transparent p-0 outline-none"
          onKeyDown={(e) => {
            const n = Number(e.key)
            if (n >= 1 && n <= Math.min(9, options.length) && !e.ctrlKey && !e.metaKey && !e.altKey) {
              e.preventDefault()
              pick(options[n - 1].value)
            }
          }}
        >
          <div className="px-3 pt-1 pb-1.5 text-[13px] text-cc-fg3">{title}</div>
          <CommandList className="max-h-[360px]">
            {groups.map((g) => {
              const list = options.map((o, i) => [o, i] as const).filter(([o]) => o.group === g)
              if (!list.length) return null
              return (
                <CommandGroup key={g ?? "main"} heading={g} className="p-0 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:font-normal **:[[cmdk-group-heading]]:text-cc-fg3">
                  {list.map(([o, i]) => item(o, i))}
                </CommandGroup>
              )
            })}
          </CommandList>
        </Command>
        {extra && <div className="mt-1.5 border-t border-cc-wash-2 pt-1.5">{extra}</div>}
      </PopoverContent>
    </Popover>
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
      kinds={["mode"]}
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
        label: m.displayName,
        note: m.description,
        resolved: m.resolvedModel,
        efforts: m.supportedEffortLevels,
        fast: m.supportsFastMode,
        // the current family by alias (default, opus, sonnet, fable, haiku); pinned versions are "other"
        main: !m.value.startsWith("claude-"),
      }))
    : MODELS.map((m) => ({ value: m.value as string, label: m.label, note: m.note as string, resolved: m.value as string, efforts: undefined as string[] | undefined, fast: true, main: true }))
}

/** The option a session's model matches: by alias, else by the resolved model id. */
function matchModel(models: ReturnType<typeof useModels>, model: string) {
  return models.find((m) => m.value === model) ?? models.find((m) => m.resolved === model && m.value !== "default") ?? models.find((m) => m.resolved === model)
}

/** The efforts a model allows (all when the installed claude doesn't say). */
function useEfforts(model?: string) {
  const allowed = matchModel(useModels(), model ?? "")?.efforts
  return EFFORTS.filter((e) => !allowed || allowed.includes(e.value))
}

/**
 * The model menu. Given `effort`, it is Claude Code desktop's one model-and-effort control: the
 * trigger reads "Opus 5.5 · High" and the menu has the effort levels under the models.
 */
export function ModelPicker({
  value,
  onChange,
  disabled,
  disabledReason,
  extra,
  effort,
  onEffort,
  fast,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  disabledReason?: string
  extra?: ReactNode
  effort?: Effort
  onEffort?: (e: Effort) => void
  fast?: boolean
}) {
  const models = useModels()
  const efforts = useEfforts(value)
  const cur = matchModel(models, value)
  const name = cur?.label.replace(/ \(recommended\)$/, "") ?? value.replace(/^claude-/, "")
  return (
    <SettingMenu
      kinds={effort && onEffort ? ["model", "effort"] : ["model"]}
      title="Model"
      shortcut="I"
      value={cur?.value ?? value}
      options={models.map((m) => ({ value: m.value, label: m.label.replace(/ \(recommended\)$/, ""), note: m.note, group: m.main ? undefined : "Other versions" }))}
      onChange={onChange}
      disabled={disabled}
      disabledReason={disabledReason}
      trigger={
        <span className="truncate">
          {name}
          {/* the qualifiers go first when the chin is narrow */}
          <span className="text-cc-fg3 @max-[280px]/composer:hidden">
            {fast && " Fast"}
            {effort && ` · ${effortLabel(effort)}`}
          </span>
        </span>
      }
      extra={
        (effort && onEffort) || extra ? (
          <>
            {effort && onEffort && <EffortRow value={effort} options={efforts} onChange={onEffort} />}
            {extra}
          </>
        ) : undefined
      }
      align="end"
    />
  )
}

/** Effort as a row of stops under the models (Ctrl+Shift+E focuses it; ←→ move). */
function EffortRow({ value, options, onChange }: { value: Effort; options: typeof EFFORTS; onChange: (e: Effort) => void }) {
  const step = (dir: number) => {
    const i = options.findIndex((o) => o.value === value) + dir
    if (options[i]) onChange(options[i].value)
  }
  return (
    <div className="px-2 pb-1.5">
      <div className="flex h-7 items-center justify-between px-1 text-[13px] text-cc-fg3">
        <span>Effort</span>
        {value === "max" && <span className={WARN}>High usage</span>}
      </div>
      <div
        role="radiogroup"
        aria-label="Effort"
        className="flex rounded-lg bg-cc-wash p-0.5"
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
          e.preventDefault()
          step(e.key === "ArrowLeft" ? -1 : 1)
          requestAnimationFrame(() => e.currentTarget.querySelector<HTMLElement>("[aria-checked=true]")?.focus())
        }}
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            data-effort
            aria-checked={o.value === value}
            tabIndex={o.value === value ? 0 : -1}
            title={o.value === "max" ? "Claude thinks longer with Max effort and uses your limits faster than High." : o.note}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-6 flex-auto rounded-md px-1.5 text-xs whitespace-nowrap text-cc-fg2 outline-none hover:text-[var(--cc-fg)] focus-visible:shadow-[0_0_0_1px_var(--cc-accent)]",
              o.value === value && "bg-cc-raised text-[var(--cc-fg)] shadow-[0_0_0_1px_var(--cc-wash-2)]",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The effort menu on its own (the New session screen). */
export function EffortPicker({ value, model, onChange, disabled, disabledReason }: { value: Effort; model?: string; onChange: (v: Effort) => void; disabled?: boolean; disabledReason?: string }) {
  const options = useEfforts(model).map((e) => ({ value: e.value, label: e.label, note: e.note }))
  return (
    <SettingMenu
      kinds={["effort"]}
      align="end"
      title="Effort"
      shortcut="E"
      width={260}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      disabledReason={disabledReason}
      trigger={<span className="truncate">{effortLabel(value)}</span>}
    />
  )
}

// why claude can't serve fast mode (its own wording); "sdk_opt_in_required" is not listed because
// the app opts in by passing the setting itself
const FAST_BLOCKED: Record<string, string> = {
  not_first_party: "Fast mode is only available when using the Anthropic API directly",
  disabled_by_env: "Fast mode is not available",
  model_not_allowed: "This model is not in your organization's allowed models",
  free: "Fast mode needs a paid plan",
  preference: "Fast mode is turned off by your organization",
  extra_usage_disabled: "Fast mode needs extra usage turned on",
}

/** A switch row inside a menu (the model menu's Fast mode and Ultracode). */
function MenuSwitch({ label, hint, checked, onChange, disabled, reason }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; reason?: string }) {
  return (
    <label className={cn("flex min-h-7 items-center gap-3 rounded-lg px-3 py-1 select-none", disabled ? "opacity-40" : "cursor-pointer hover:bg-cc-ghost")}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm">{label}</span>
        <span className="truncate text-[13px] leading-[17px] text-cc-fg3">{disabled && reason ? reason : hint}</span>
      </span>
      <Switch size="sm" checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </label>
  )
}

/**
 * What used to be separate controls under the prompt box, inside the model menu (Claude Code
 * desktop keeps only model, effort and mode there): Fast mode, Ultracode and the output style.
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
  ultra: boolean
  style?: string
  onChange: (patch: { fastMode?: boolean; ultracode?: boolean; outputStyle?: string }) => void
}) {
  const models = useModels()
  const reason = useApp((s) => s.caps?.fastModeDisabledReason)
  const styles = useApp((s) => s.caps?.outputStyles) ?? ["default", "Explanatory", "Learning"]
  const m = matchModel(models, model)
  const blocked = (reason && FAST_BLOCKED[reason]) || (m && m.fast === false ? `${m.label} has no fast mode` : undefined)
  const cur = style ?? "default"
  return (
    <div className="flex flex-col">
      <MenuSwitch label="Fast mode" hint="Faster output from the same model, billed higher" checked={fast && !blocked} onChange={(v) => onChange({ fastMode: v })} disabled={!!blocked} reason={blocked} />
      <MenuSwitch label="Ultracode" hint="Lets Claude run many subagents on big tasks" checked={ultra} onChange={(v) => onChange({ ultracode: v })} />
      <div className="flex flex-wrap items-center gap-1 px-3 pt-1 pb-1">
        <span className="mr-1 text-[13px] text-cc-fg3">Style</span>
        {styles.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange({ outputStyle: v })}
            className={cn("h-6 rounded-md px-2 text-xs outline-none focus-visible:shadow-[0_0_0_1px_var(--cc-accent)]", v === cur ? "bg-cc-ghost-sel" : "text-cc-fg2 hover:bg-cc-ghost")}
          >
            {v === "default" ? "Default" : v}
          </button>
        ))}
      </div>
    </div>
  )
}
