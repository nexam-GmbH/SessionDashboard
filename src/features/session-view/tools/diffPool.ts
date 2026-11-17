// Adapted from pingdotgg/t3code@be5f805:apps/web/src/components/DiffWorkerPoolProvider.tsx (MIT). Modified for session-dashboard.
// Shared @pierre/diffs setup for the session view's inline diffs and the Review screen
//. pierre keeps one worker pool singleton: whichever provider
// mounts first creates it, so both screens pass these same options. The token block
// targets `:host` (the diff's Shadow DOM host): pierre 1.6.4 never sets
// `data-theme-type`, so selectors on it were silently ignored.
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker"
import { registerCustomTheme } from "@pierre/diffs"
import { CLAUDE_DARK, CLAUDE_LIGHT } from "../markdown/claudeTheme"

// Claude Code desktop's code colours in every diff (chat and Review), under pierre's own theme
// names: a worker renders with those before it hears of any other
registerCustomTheme("pierre-dark", async () => ({ ...CLAUDE_DARK, name: "pierre-dark" }))
registerCustomTheme("pierre-light", async () => ({ ...CLAUDE_LIGHT, name: "pierre-light" }))
export const DIFF_THEME = { dark: "pierre-dark", light: "pierre-light" } as const

export const POOL_OPTIONS = { workerFactory: () => new DiffsWorker(), poolSize: 2 }
export const HIGHLIGHTER_OPTIONS = { theme: DIFF_THEME, langs: [] }

/** Our diff tints, gutters and selection, for pierre's `unsafe` CSS layer. */
export const DIFF_TOKEN_CSS = `
  :host {
    --diffs-gap-style: none !important;
    --diffs-bg-context-override: #111113 !important;
    --diffs-bg-context-gutter-override: #111113 !important;
    --diffs-bg-buffer-override: #141416 !important;
    --diffs-bg-separator-override: #18191b !important;
    --diffs-bg-hover-override: #2e3135 !important;
    --diffs-bg-addition-override: #12261a !important;
    --diffs-bg-addition-number-override: #10221a !important;
    --diffs-bg-addition-emphasis-override: #1a3f27 !important;
    --diffs-bg-deletion-override: #2d1517 !important;
    --diffs-bg-deletion-number-override: #281315 !important;
    --diffs-bg-deletion-emphasis-override: #4b1e22 !important;
    --diffs-dark-addition-color: #2ea043 !important;
    --diffs-dark-deletion-color: #f85149 !important;
    --diffs-dark-modified-color: #0090ff !important;
    --diffs-fg-number-override: #5a6169 !important;
    --diffs-bg-selection-override: #1d61af !important;
  }
  [data-code]::-webkit-scrollbar { height: 8px; background: transparent; }
  [data-code]::-webkit-scrollbar-thumb { background-color: transparent; border-radius: 4px; }
  [data-code]:hover::-webkit-scrollbar-thumb { background-color: #43484e; }
`

/** Tool payloads are fragments that rarely end in a newline; avoid "No newline at end of file" noise. */
export function withTrailingNewline(text: string) {
  if (!text) return ""
  return text.endsWith("\n") ? text : `${text}\n`
}
