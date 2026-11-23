// The active Claude account and what changes it: switching (the footer, Ctrl+K, the limit card, the
// automatic switch at the limit), adding one (`claude setup-token` in the built-in terminal; Rust
// reads the token it prints into the credential store) and removing one (its token only).
import { useShallow } from "zustand/react/shallow"
import { getApp, useApp, type ClaudeAccount } from "@/store/app"
import { patchSettings } from "@/store/actions"
import { REAL } from "@/backend/mode"
import { IN_TAURI } from "@/lib/platform"
import {
  accountName,
  accountsOf,
  activeAccountOf,
  DEFAULT_ACCOUNT,
  TOKEN_DAYS,
  type AccountView,
} from "@/lib/accounts"
import { refreshUsage } from "@/features/usage/usageData"
import { showUndo } from "@/features/notifications/undo"

const desktop = () => IN_TAURI && REAL

export function useAccounts(): AccountView[] {
  const list = useApp(useShallow((s) => s.settings.accounts ?? []))
  const email = useApp((s) => s.caps?.account?.email)
  const sub = useApp((s) => s.caps?.account?.subscriptionType)
  return accountsOf({
    settings: { accounts: list },
    caps: { account: { email, subscriptionType: sub } },
  })
}

export function useActiveAccount(): string {
  return useApp((s) => activeAccountOf(s))
}

/** Make an account the one the app runs on. New sessions start on it; a session continues on it
 * with your next message. A short notice says so, with Undo. */
export function setActiveAccount(
  id: string,
  opts: { quiet?: boolean; note?: string } = {}
) {
  const prev = activeAccountOf(getApp())
  if (prev === id) return
  patchSettings({ activeAccount: id })
  // its limits now (an account on a token reports them with its next model call)
  void refreshUsage({ limits: true })
  if (!opts.quiet)
    showUndo(opts.note ?? "Active", accountName(getApp(), id), () =>
      setActiveAccount(prev, { quiet: true })
    )
}

const newId = () =>
  `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** The account the dialog is adding or signing in again (kept in settings once its token is saved). */
export function draftAccount(
  email: string,
  label?: string,
  plan?: string,
  id = newId()
): ClaudeAccount {
  const now = new Date()
  return {
    id,
    email: email.trim(),
    ...(label?.trim() ? { label: label.trim() } : {}),
    ...(plan ? { plan } : {}),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOKEN_DAYS * 864e5).toISOString(),
  }
}

/**
 * Signed in again: the account under its new id (a new token), the old token gone. Sessions keep
 * their history; the active account moves along.
 */
export async function replaceAccount(oldId: string, a: ClaudeAccount) {
  const list = getApp().settings.accounts ?? []
  const old = list.find((x) => x.id === oldId)
  patchSettings({
    accounts: list.map((x) =>
      x.id === oldId
        ? { ...a, label: a.label ?? old?.label, plan: a.plan ?? old?.plan }
        : x
    ),
    ...(getApp().settings.activeAccount === oldId
      ? { activeAccount: a.id }
      : {}),
  })
  if (desktop()) {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("account_token_delete", { accountId: oldId }).catch(
      () => undefined
    )
  }
}

/** Keep an account (new, or signed in again: its token is newer). */
export function keepAccount(a: ClaudeAccount) {
  const list = getApp().settings.accounts ?? []
  patchSettings({
    accounts: list.some((x) => x.id === a.id)
      ? list.map((x) => (x.id === a.id ? { ...x, ...a } : x))
      : [...list, a],
  })
}

export function renameAccount(id: string, label: string) {
  patchSettings({
    accounts: (getApp().settings.accounts ?? []).map((x) =>
      x.id === id ? { ...x, label: label.trim() || undefined } : x
    ),
  })
}

/** Remove an account: its token goes, every session stays. The active one falls back to your login. */
export async function removeAccount(id: string) {
  if (!id) return
  if (desktop()) {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("account_token_delete", { accountId: id })
  }
  if (activeAccountOf(getApp()) === id)
    setActiveAccount(DEFAULT_ACCOUNT, { quiet: true })
  patchSettings({
    accounts: (getApp().settings.accounts ?? []).filter((x) => x.id !== id),
  })
}

/** Whether an account's token is in the credential store (the token never leaves Rust). */
export async function hasToken(id: string): Promise<boolean> {
  if (!desktop()) return true
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<boolean>("account_has_token", { accountId: id }).catch(
    () => false
  )
}

/** A token pasted by hand (when reading it from the terminal did not work). */
export async function saveToken(id: string, token: string) {
  if (!desktop()) return
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("account_token_save", { accountId: id, token })
}

/** What a sign-in reports while it runs (src-tauri/src/claude/signin.rs). */
export type SignInEvent =
  | { type: "output"; text: string }
  | { type: "checking" }
  | { type: "invalid"; message: string }
  | { type: "saved" }
  | { type: "exit" }

/**
 * Sign an account in: `claude setup-token` in a terminal of its own (your browser opens; sign in
 * with that account's e-mail). Rust reads the token it prints, checks it against the API and only
 * then saves it; the output comes here with the token masked. Returns a stop function.
 */
export function signIn(id: string, on: (e: SignInEvent) => void): () => void {
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    if (desktop()) void import("@tauri-apps/api/core").then(({ invoke }) => invoke("account_signin_cancel", { accountId: id }).catch(() => undefined))
  }
  void (async () => {
    if (!desktop()) {
      // the browser preview: a sign-in that works after a moment
      on({ type: "output", text: "Opening browser to sign in…" })
      setTimeout(() => !stopped && on({ type: "saved" }), 800)
      return
    }
    const { invoke, Channel } = await import("@tauri-apps/api/core")
    const ch = new Channel<SignInEvent>()
    ch.onmessage = (e) => {
      if (!stopped) on(e)
      if (e.type === "saved" || e.type === "exit") stopped = true
    }
    try {
      await invoke("account_signin_start", { accountId: id, onData: ch })
    } catch (e) {
      on({ type: "invalid", message: `Could not start claude setup-token: ${String(e)}` })
    }
  })()
  return stop
}

/** Type into a running sign-in (a code the browser shows). */
export async function signInInput(id: string, text: string) {
  if (!desktop()) return
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("account_signin_input", { accountId: id, text })
}

/** A session on this account got a 401: its sign-in does not work any more. */
export function markInvalid(id: string) {
  if (!id) return
  const list = getApp().settings.accounts ?? []
  if (!list.some((x) => x.id === id && !x.invalid)) return
  patchSettings({ accounts: list.map((x) => (x.id === id ? { ...x, invalid: true } : x)) })
}

/** Days until the token of an account in settings ends; null for the normal login. */
export const accountDays = (
  a: Pick<ClaudeAccount, "expiresAt">,
  now = Date.now()
) => (a.expiresAt ? Math.floor((Date.parse(a.expiresAt) - now) / 864e5) : null)
