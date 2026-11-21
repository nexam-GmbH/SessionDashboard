// Every setting in one place: its type, default and, for the ones Settings shows as a plain row,
// its label, hover text and page. The store derives its defaults from this and checks what it reads
// from localStorage against it, so a value of the wrong kind falls back to its default instead of
// breaking a screen. Adding a simple setting = a field in `Settings` and an entry here.
import type { Settings, Workspace } from "./app"
import { DEFAULT_MODEL } from "@/lib/model"
import { OS } from "@/lib/platform"
import { MOD } from "@/components/common/bits"
import { EFFORTS, MODES } from "@/features/composer/options"

/** localStorage key of the settings (kept since the first version: renaming it loses them all) */
export const SETTINGS_KEY = "sd.settings"

/** Interface size steps (Settings → Window, Ctrl+= / Ctrl+−). */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]

/** The Settings pages that show plain rows from here (the rest of each page is its own code). */
export type SettingsPage = "sessions" | "new" | "notifications" | "window"

/** How a setting shows as a row: label left, control right. */
export interface SettingRowSpec {
  page: SettingsPage
  label: string
  /** the hover text on the label; `text in backticks` shows as code */
  description?: string
  /** select width (Tailwind class); w-44 when unset */
  width?: string
  /** a short reason when the setting does nothing on this computer: shown as the hint, row disabled */
  unavailable?: () => string | undefined
}

export interface Option<V> {
  value: V
  label: string
}

interface BooleanField {
  type: "boolean"
  default: boolean
  row?: SettingRowSpec
}
interface EnumField<V extends string> {
  type: "enum"
  default: V
  /** every value a saved setting may hold */
  options: readonly Option<V>[]
  /** the values the row's menu offers, when not all of them */
  offer?(v: V): boolean
  row?: SettingRowSpec
}
interface StringField {
  type: "string"
  default: string
  /** a menu of common values; any string still loads (a model id the menu does not list) */
  options?: readonly Option<string>[]
  row?: SettingRowSpec
}
interface NumberField {
  type: "number"
  default: number
  min: number
  max: number
  /** shown as a menu of these values */
  options?: readonly Option<number>[]
  row?: SettingRowSpec
}
interface ListField<I> {
  type: "list"
  default: I[]
  /** items that fail this are dropped, the rest kept as saved */
  item: (v: unknown) => boolean
}
interface GroupField<T> {
  type: "group"
  fields: { [K in keyof T]-?: FieldFor<T[K]> }
}

/** The field kind a value type needs; the registry below is checked against `Settings` with it. */
export type FieldFor<T> = [T] extends [boolean]
  ? BooleanField
  : [T] extends [number]
    ? NumberField
    : [T] extends [string]
      ? string extends T
        ? StringField
        : EnumField<T>
      : [T] extends [readonly (infer I)[]]
        ? ListField<I>
        : [T] extends [object]
          ? GroupField<T>
          : never

export type AnyField = BooleanField | EnumField<string> | StringField | NumberField | ListField<unknown> | { type: "group"; fields: Record<string, AnyField> }

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === "string"
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v)
const strings = (v: unknown) => Array.isArray(v) && v.every(isString)

/** A workspace the overview can show without tripping over a field of the wrong kind. */
function isWorkspace(v: unknown): v is Workspace {
  if (!isRecord(v) || !isString(v.id) || !isString(v.name)) return false
  const repos = (r: unknown) => Array.isArray(r) && r.every((x) => isRecord(x) && isString(x.key) && isString(x.name) && optional(x.path, isString))
  return optional(v.repos, repos) && optional(v.folders, strings) && optional(v.home, isString) && optional(v.configDir, isString) && optional(v.lead, isString)
}

/**
 * The registry. Within a page, rows show in the order they are listed here (groups keep their
 * fields' order), so entries are grouped by page in screen order.
 */
export const SETTINGS: { [K in keyof Settings]-?: FieldFor<Settings[K]> } = {
  // Settings → Sessions (the desktop app)
  recentPerRepo: {
    type: "number",
    default: 5,
    min: 1,
    max: 100,
    options: [3, 5, 8, 10, 15, 25].map((v) => ({ value: v, label: String(v) })),
    row: {
      page: "sessions",
      label: "Past sessions per project",
      description: "How many finished sessions each project lists under its running ones (Show more adds the rest). History (Ctrl+Shift+H) has all of them; Ctrl+K searches what was said in them.",
      width: "w-20",
    },
  },
  sendKey: {
    type: "enum",
    default: "enter",
    options: [
      { value: "enter", label: "Enter" },
      { value: "mod-enter", label: "Ctrl+Enter" },
    ],
    row: { page: "sessions", label: "Send with", description: "Enter sends and Shift+Enter adds a line, as in Claude Code; or Enter adds a line and Ctrl+Enter sends.", width: "w-32" },
  },
  chatWidth: {
    type: "enum",
    default: "readable",
    options: [
      { value: "readable", label: "Readable" },
      { value: "wide", label: "Wide" },
    ],
    row: { page: "sessions", label: "Chat width", description: "A readable column, like Claude Code desktop, or one that uses the window's width.", width: "w-32" },
  },
  cloud: { type: "boolean", default: true },

  // Settings → New sessions
  defaults: {
    type: "group",
    fields: {
      model: {
        type: "string",
        default: DEFAULT_MODEL,
        options: [
          { value: "claude-opus-5-5", label: "Opus 5.5" },
          { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
          { value: "claude-haiku-5-5", label: "Haiku 5.5" },
          { value: "claude-fable-5-2", label: "Fable 5.2" },
        ],
        row: { page: "new", label: "Model" },
      },
      effort: { type: "enum", default: "high", options: EFFORTS, row: { page: "new", label: "Effort" } },
      permissionMode: {
        type: "enum",
        default: "default",
        options: MODES,
        offer: (m) => m !== "bypassPermissions" && m !== "dontAsk",
        row: { page: "new", label: "Permissions", description: "bypassPermissions is never used as a default." },
      },
      worktree: { type: "boolean", default: true, row: { page: "new", label: "Worktree", description: "Start new sessions in `.claude/worktrees/<name>` (`claude --worktree`)." } },
    },
  },
  allowBypass: {
    type: "boolean",
    default: false,
    row: { page: "new", label: "Allow bypass permissions mode", description: "Adds Bypass permissions to the mode picker. Claude then never asks before acting; use it only in a sandbox." },
  },

  // Settings → Notifications
  notify: {
    type: "group",
    fields: {
      permission: { type: "boolean", default: true, row: { page: "notifications", label: "Needs permission", description: "A tool call is waiting for approval." } },
      question: { type: "boolean", default: true, row: { page: "notifications", label: "Asks a question", description: "A question for you or a plan to approve." } },
      finished: { type: "boolean", default: false, row: { page: "notifications", label: "Finishes", description: "Off by default: finished sessions get a dot in the list instead." } },
      error: { type: "boolean", default: true, row: { page: "notifications", label: "Fails", description: "API errors, crashes, rate limits." } },
      sound: { type: "boolean", default: false, row: { page: "notifications", label: "Sound", description: "The desktop's message sound with each notification." } },
    },
  },
  mutedRepos: { type: "list", default: [], item: isString },

  // Settings → Window
  // the stock theme's 14px text: 100% (the old 13px theme started at 110%)
  uiScale: {
    type: "number",
    default: 1,
    min: 0.5,
    max: 2,
    options: ZOOM_STEPS.map((z) => ({ value: z, label: `${Math.round(z * 100)}%` })),
    row: { page: "window", label: "Interface size", description: `Everything in the window, larger or smaller. ${MOD}+= and ${MOD}+− change it from anywhere.`, width: "w-24" },
  },
  // one bar like Claude desktop / Zed: the app draws the title bar and window buttons itself
  nativeTitlebar: {
    type: "boolean",
    default: false,
    row: { page: "window", label: "Native title bar", description: "Use the window manager's title bar instead of the app's own. On KDE Wayland the change shows after a restart.", unavailable: () => (OS !== "linux" ? "Linux only" : undefined) },
  },
  reduceMotion: { type: "boolean", default: false, row: { page: "window", label: "Reduce motion", description: "Stops the working spinner." } },

  // set elsewhere: their own screens, the top bar, keys
  claudeConfigDir: { type: "string", default: "~/.claude" },
  claudeConfigDirs: { type: "list", default: [], item: isString },
  autoSwitchAccount: { type: "number", default: 0, min: 0, max: 100 },
  machines: { type: "list", default: [], item: (m) => isRecord(m) && isString(m.host) },
  workspaces: { type: "list", default: [], item: isWorkspace },
  workspace: { type: "string", default: "" },
  terminalShell: { type: "string", default: "" },
  sidebarHidden: { type: "boolean", default: false },
  terminalHeight: { type: "number", default: 280, min: 120, max: 4000 },
  detailsOpen: { type: "boolean", default: true },
  transcriptView: {
    type: "enum",
    default: "normal",
    options: [
      { value: "normal", label: "Normal" },
      { value: "thinking", label: "Thinking" },
      { value: "verbose", label: "Verbose" },
    ],
  },
}

/** A field's saved value if it is one the app can use, else its default (never throws). */
function read(f: AnyField, v: unknown): unknown {
  switch (f.type) {
    case "boolean":
      return typeof v === "boolean" ? v : f.default
    case "string":
      return isString(v) ? v : f.default
    case "enum":
      return f.options.some((o) => o.value === v) ? v : f.default
    case "number":
      return typeof v === "number" && Number.isFinite(v) && v >= f.min && v <= f.max ? v : f.default
    case "list":
      return Array.isArray(v) ? v.filter(f.item) : [...f.default]
    case "group": {
      const o = isRecord(v) ? v : {}
      return Object.fromEntries(Object.entries(f.fields).map(([k, sub]) => [k, read(sub, o[k])]))
    }
  }
}

/**
 * Settings from what was saved: every known setting, each saved value checked against its field.
 * Keys the app no longer has are left out. Never throws.
 */
export function readSettings(saved: unknown): Settings {
  return read({ type: "group", fields: SETTINGS } as AnyField, saved) as Settings
}

/** A plain row on a Settings page: where the value lives (`["notify", "sound"]`) and its field. */
export interface SettingRowEntry {
  path: [keyof Settings] | [keyof Settings, string]
  field: BooleanField | EnumField<string> | StringField | NumberField
  row: SettingRowSpec
}

/** Every setting shown as a plain row, in registry order. */
export const SETTING_ROWS: SettingRowEntry[] = Object.entries(SETTINGS).flatMap(([key, f]) => {
  const k = key as keyof Settings
  const field = f as AnyField
  if (field.type === "group") return Object.entries(field.fields).flatMap(([sub, g]) => rowOf([k, sub], g))
  return rowOf([k], field)
})

function rowOf(path: SettingRowEntry["path"], f: AnyField): SettingRowEntry[] {
  return f.type !== "group" && f.type !== "list" && f.row ? [{ path, field: f, row: f.row }] : []
}
