// Claude accounts: the main Claude Code config folder (~/.claude) and the others listed in
// Settings → Sessions → Other Claude accounts (CLAUDE_CONFIG_DIR folders like ~/.claude-work).
// The same folder reaches the app written in several ways ("~/.claude-work" in Settings,
// "C:\Users\me\.claude-work" from a transcript's location), so accounts are compared by a key.
import { homePath, normPath } from "./format"

export const MAIN_LABEL = "~/.claude"

/** One account: `dir` as Settings has it ("" = the main one), `key` to compare, `label` to show. */
export interface Account {
  key: string
  dir: string
  label: string
}

/** The same key for every way of writing one folder; "" for the main account. */
export function accountKey(dir?: string | null): string {
  const d = dir?.trim()
  if (!d) return ""
  const k = homePath(normPath(d)).replace(/[/\\]+$/, "").toLowerCase()
  return k === MAIN_LABEL ? "" : k
}

/** How an account's folder shows: "~/.claude-work", "~/.claude" for the main one. */
export function accountLabel(dir?: string | null): string {
  const d = dir?.trim()
  return d ? homePath(normPath(d)).replace(/[/\\]+$/, "") : MAIN_LABEL
}

/** Every account, the main one first (Settings → Sessions → Other Claude accounts). */
export function accountsOf(dirs: readonly string[]): Account[] {
  const out: Account[] = [{ key: "", dir: "", label: MAIN_LABEL }]
  for (const d of dirs) {
    const key = accountKey(d)
    if (key && !out.some((a) => a.key === key)) out.push({ key, dir: d, label: accountLabel(d) })
  }
  return out
}

/** The accounts a session could move to: every one but its own. */
export function otherAccounts(dirs: readonly string[], configDir?: string | null): Account[] {
  const own = accountKey(configDir)
  return accountsOf(dirs).filter((a) => a.key !== own)
}
