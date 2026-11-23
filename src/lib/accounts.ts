// Claude accounts, by e-mail. Your normal Claude Code login (~/.claude) is the account with id "";
// every other one runs on a token (`claude setup-token`) that Rust keeps in the system's credential
// store (src-tauri/src/claude/tokens.rs). One account is active for the whole app: new sessions and
// every message that continues a session run on it. Sessions of all accounts share ~/.claude.
import type { ClaudeAccount } from "@/store/app"
import { REAL } from "@/backend/mode"

/** Your normal Claude Code login. */
export const DEFAULT_ACCOUNT = ""

/** A setup-token is valid for a year; a warning shows this long before it ends. */
export const TOKEN_DAYS = 365
export const WARN_DAYS = 14

/** An account as the UI lists it: the normal login first. */
export interface AccountView {
  id: string
  email?: string
  plan?: string
  label?: string
  /** your normal login (no token) */
  login: boolean
  expiresAt?: string
  /** its token does not work (a 401): sign in again */
  invalid?: boolean
}

interface AccountSource {
  settings: { accounts?: ClaudeAccount[]; activeAccount?: string }
  caps?: { account?: { email?: string; subscriptionType?: string } } | null
}

/** "Claude Max" / "max" / "team" → "Max" / "Team". */
export function planName(p?: string | null): string | undefined {
  if (!p) return undefined
  const s = p.replace(/^claude\s+/i, "").trim()
  return s ? s[0].toUpperCase() + s.slice(1) : undefined
}

export function accountsOf(st: AccountSource): AccountView[] {
  const me = st.caps?.account
  return [
    // the browser preview has no login: a stand-in address
    { id: DEFAULT_ACCOUNT, email: me?.email ?? (REAL ? undefined : "you@example.com"), plan: planName(me?.subscriptionType) ?? (REAL ? undefined : "Max"), login: true },
    ...(st.settings.accounts ?? []).map((a) => ({ id: a.id, email: a.email, plan: a.plan, label: a.label, login: false, expiresAt: a.expiresAt, invalid: a.invalid })),
  ]
}

/** The account the app runs on now ("" = your normal login); one that was removed falls back to it. */
export function activeAccountOf(st: AccountSource): string {
  const id = st.settings.activeAccount ?? ""
  return id && (st.settings.accounts ?? []).some((a) => a.id === id) ? id : DEFAULT_ACCOUNT
}

/** How an account shows: its e-mail ("Your Claude login" while the normal login's is not known yet). */
export function accountName(st: AccountSource, id: string | undefined): string {
  const a = accountsOf(st).find((x) => x.id === (id ?? ""))
  if (!a) return "a removed account"
  return a.email ?? (a.login ? "your Claude login" : "an account")
}

/** Name with its label: "Work · name@firm.de". */
export function accountTitle(a: AccountView): string {
  const mail = a.email ?? (a.login ? "Your Claude login" : "Account")
  return a.label ? `${a.label} · ${mail}` : mail
}

/** Days until a token ends (negative: ended), or null for the normal login. */
export function daysLeft(a: { expiresAt?: string }, now = Date.now()): number | null {
  if (!a.expiresAt) return null
  return Math.floor((Date.parse(a.expiresAt) - now) / 864e5)
}

export const initialOf = (a: AccountView) => (a.label?.[0] ?? a.email?.[0] ?? "?").toUpperCase()
