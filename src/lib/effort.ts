// The effort a session runs at when none is chosen, from your Claude Code settings (the app reads
// them at start: claude itself does not report it).
import type { ClaudeCaps } from "@/store/app"
import type { Effort } from "@/lib/model"

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"]

/** What your settings give `model` (modelSettings), else your effortLevel; undefined: claude's own default. */
export function claudeEffort(caps: ClaudeCaps | null | undefined, model?: string): Effort | undefined {
  if (!caps?.effort) return undefined
  const resolved = (model && caps.models.find((m) => m.value === model)?.resolvedModel) || model
  const e = (resolved && caps.effort.byModel[resolved]) || caps.effort.default
  return e && EFFORTS.includes(e) ? (e as Effort) : undefined
}
