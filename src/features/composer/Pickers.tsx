// The settings under the prompt box, like the Claude Code desktop app: model (with Fast mode,
// Ultracode and output style inside its menu), effort and permission mode. Each menu
// is a searchable list ("Select an option…"); 1–9 pick while the search is empty; Ctrl/⌘+Shift+M,
// I, E open the mode, model and effort menus. In the desktop app the options come from the
// installed claude (store `caps`); the mock world uses the built-in lists.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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

const TRIGGER =
  "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-foreground"

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
  kind,
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
}: {
  extra?: ReactNode
  align?: "start" | "end"
  kind?: PickerKind
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
  const [query, setQuery] = useState("")
  const ref = useRef<HTMLButtonElement>(null)
  // the hint shows on hover only: not over the open menu, not again when focus comes back after a pick
  const [tip, setTip] = useState(false)
  const [sel, setSel] = useState("")
  const closedAt = useRef(0)
  useEffect(() => {
    if (!kind) return
    const on = (e: Event) => {
      // only the prompt box on screen answers (kept-alive views are display:none)
      if ((e as CustomEvent<PickerKind>).detail === kind && !disabled && ref.current?.offsetParent) {
        const cur = options.find((o) => o.value === value)
        setSel(cur ? itemValue(cur) : "")
        setOpen(true)
      }
    }
    window.addEventListener(PICKER_EVENT, on)
    return () => window.removeEventListener(PICKER_EVENT, on)
  }, [kind, disabled, options, value])
  const pick = (v: T) => {
    onChange(v)
    closedAt.current = clock()
    setOpen(false)
    setQuery("")
  }
  const groups = [undefined, ...new Set(options.map((o) => o.group).filter(Boolean))] as (string | undefined)[]
  const item = (o: Option<T>, i: number) => (
    <CommandItem key={o.value} value={itemValue(o)} onSelect={() => pick(o.value)} className="h-8 gap-2.5 py-0">
      {o.icon && <span className={cn("shrink-0 text-muted-foreground/70", o.tone === "warn" && "text-st-error-fg")}>{o.icon}</span>}
      <span className={cn("shrink-0 text-sm text-foreground", o.tone === "warn" && "text-st-error-fg")}>{o.label}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">{o.note}</span>
      {o.value === value ? <Check size={14} className="shrink-0 text-foreground" /> : i < 9 ? <span className="tabular w-3.5 shrink-0 text-center text-xs text-muted-foreground/70">{i + 1}</span> : <span className="w-3.5 shrink-0" />}
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
      className={TRIGGER}
    >
      {trigger}
      <ChevronDown size={12} className="shrink-0 text-muted-foreground/70" />
    </button>
  )
  if (disabled) return <Locked reason={disabledReason}>{button}</Locked>
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        // opens on the current choice: Enter keeps it, arrows move from it
        if (o) setSel(current ? itemValue(current) : "")
        if (!o) {
          setQuery("")
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
          {shortcut ? ` · ${MOD}+Shift+${shortcut}` : ""}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align={align} sideOffset={6} className="w-[380px] p-0">
        <Command loop value={sel} onValueChange={setSel}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Select an option…"
            className="h-9 text-sm"
            onKeyDown={(e) => {
              const n = Number(e.key)
              if (!query && n >= 1 && n <= options.length && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault()
                pick(options[n - 1].value)
              }
            }}
          />
          <CommandList className="max-h-[360px]">
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground/70">No match.</CommandEmpty>
            {groups.map((g) => {
              const list = options.map((o, i) => [o, i] as const).filter(([o]) => o.group === g)
              if (!list.length) return null
              return (
                <CommandGroup key={g ?? "main"} heading={g} className={g ? "border-t border-border" : undefined}>
                  {list.map(([o, i]) => item(o, i))}
                </CommandGroup>
              )
            })}
          </CommandList>
        </Command>
        {extra && <div className="border-t p-1">{extra}</div>}
      </PopoverContent>
    </Popover>
  )
}

export function ModePicker({ value, onChange, disabled, disabledReason }: { value: PermissionMode; onChange: (v: PermissionMode) => void; disabled?: boolean; disabledReason?: string }) {
  const allowBypass = useApp((s) => s.settings.allowBypass || s.caps?.defaultMode === "bypassPermissions")
  const options = MODES.filter((m) => m.value !== "bypassPermissions" || allowBypass || value === "bypassPermissions").map((m) => ({
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
      align="end"
      title="Permissions"
      shortcut="M"
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      disabledReason={disabledReason}
      trigger={
        <>
          <cur.icon size={13} className={cn("shrink-0", value === "bypassPermissions" ? "text-st-error-fg" : "text-muted-foreground/70")} />
          <span className={cn("truncate", value === "bypassPermissions" && "text-st-error-fg")}>{cur.label}</span>
        </>
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

export function ModelPicker({ value, onChange, disabled, disabledReason, extra }: { value: string; onChange: (v: string) => void; disabled?: boolean; disabledReason?: string; extra?: ReactNode }) {
  const models = useModels()
  const cur = matchModel(models, value)
  return (
    <SettingMenu
      kind="model"
      title="Model"
      shortcut="I"
      value={cur?.value ?? value}
      options={models.map((m) => ({ value: m.value, label: m.label.replace(/ \(recommended\)$/, ""), note: m.note, group: m.main ? undefined : "Other versions" }))}
      onChange={onChange}
      disabled={disabled}
      disabledReason={disabledReason}
      trigger={<span className="truncate">{cur?.label ?? value.replace(/^claude-/, "")}</span>}
      extra={extra}
      align="end"
    />
  )
}

export function EffortPicker({ value, model, onChange, disabled, disabledReason }: { value: Effort; model?: string; onChange: (v: Effort) => void; disabled?: boolean; disabledReason?: string }) {
  const models = useModels()
  const allowed = model ? matchModel(models, model)?.efforts : undefined
  const options = EFFORTS.filter((e) => !allowed || allowed.includes(e.value)).map((e) => ({ value: e.value, label: e.label, note: e.note }))
  return (
    <SettingMenu
      kind="effort"
      align="end"
      title="Effort"
      shortcut="E"
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
    <label className={cn("flex min-h-9 items-center gap-3 rounded-md px-2 py-1 select-none", disabled ? "opacity-50" : "cursor-pointer hover:bg-accent")}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm text-foreground">{label}</span>
        <span className="truncate text-xs text-muted-foreground">{disabled && reason ? reason : hint}</span>
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
      <div className="flex flex-wrap items-center gap-1 px-2 pt-1 pb-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Style</span>
        {styles.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange({ outputStyle: v })}
            className={cn("h-6 rounded-md px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring", v === cur ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
          >
            {v === "default" ? "Default" : v}
          </button>
        ))}
      </div>
    </div>
  )
}
