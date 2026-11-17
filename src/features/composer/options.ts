// Session settings as the Claude Code desktop app names them: permission modes
// Manual / Accept edits / Plan / Auto (+ Bypass permissions only when allowed in Settings), a
// model picker and an effort picker under the prompt box.
import { CodeXml, Hand, ScrollText, TriangleAlert, Zap, type LucideIcon } from "lucide-react"
import type { Effort, PermissionMode } from "@/lib/model"

export const MODELS = [
  { value: "claude-opus-5-5", label: "Opus 5.5", note: "Most capable" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "Fast and capable" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5", note: "Fastest" },
  { value: "claude-fable-5-2", label: "Fable 5.2", note: "Long-form writing" },
] as const

export function modelLabel(model: string) {
  const known = MODELS.find((m) => m.value === model)?.label
  if (known) return known
  // claude-opus-5-5 → "Opus 5.5", claude-haiku-4-5-20251001 → "Haiku 4.5"
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(model)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : model
}

export const EFFORTS: { value: Effort; label: string; note: string }[] = [
  { value: "low", label: "Low", note: "Quick answers" },
  { value: "medium", label: "Medium", note: "Balanced" },
  { value: "high", label: "High", note: "Thinks before acting" },
  { value: "xhigh", label: "Extra high", note: "Longer thinking" },
  { value: "max", label: "Max", note: "Deepest thinking, slowest" },
]

export function effortLabel(e: Effort) {
  return EFFORTS.find((x) => x.value === e)?.label ?? e
}

// Claude Code desktop's mode menu: its order, wording and icons
export const MODES: { value: PermissionMode; label: string; note: string; icon: LucideIcon }[] = [
  { value: "default", label: "Manual", note: "Always ask before making changes", icon: Hand },
  { value: "acceptEdits", label: "Accept edits", note: "Automatically accept all file edits", icon: CodeXml },
  { value: "plan", label: "Plan", note: "Create a plan before making changes", icon: ScrollText },
  // set from the CLI (--permission-mode dontAsk): listed only while a session runs in it
  { value: "dontAsk", label: "Don't ask", note: "Deny actions that aren't pre-approved, without prompting", icon: Hand },
  { value: "auto", label: "Auto", note: "Claude handles permission decisions", icon: Zap },
  { value: "bypassPermissions", label: "Bypass permissions", note: "Accepts all permissions", icon: TriangleAlert },
]

export function modeOption(mode: PermissionMode) {
  return MODES.find((m) => m.value === mode) ?? MODES[0]
}

/**
 * Ctrl/⌘+Shift+M, I, E open the mode, model and effort menus of the composer on screen (Claude
 * Code desktop shortcuts). Kept-alive hidden views ignore it: only a visible trigger opens.
 */
export type PickerKind = "mode" | "model" | "effort"
export const PICKER_EVENT = "sd:picker"
export function openPicker(kind: PickerKind) {
  window.dispatchEvent(new CustomEvent<PickerKind>(PICKER_EVENT, { detail: kind }))
}
