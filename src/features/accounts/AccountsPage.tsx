// Settings → Accounts: every Claude account by e-mail (your normal login first), its plan, limits and
// token, which one the app runs on, adding one (`claude setup-token` in the built-in terminal, no
// command to type), signing one in again, removing one (its token only), the automatic switch at the
// usage limit, and taking over the sessions of older account folders (before v0.8.16).
import { useEffect, useRef, useState } from "react"
import { Check, KeyRound, Plus, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { useApp, getApp } from "@/store/app"
import { openSettings, patchSettings, pushNotification } from "@/store/actions"
import { REAL } from "@/backend/mode"
import { IN_TAURI } from "@/lib/platform"
import { plural } from "@/lib/format"
import { accountTitle, daysLeft, initialOf, WARN_DAYS } from "@/lib/accounts"
import {
  PageTitle,
  SettingRow,
  SettingsSection,
  SmallSelect,
} from "@/features/settings/SettingsView"
import { showUndo } from "@/features/notifications/undo"
import {
  Bar,
  limitLine,
  useAccountChoices,
  type AccountChoice,
} from "./AccountItems"
import {
  draftAccount,
  keepAccount,
  removeAccount,
  renameAccount,
  replaceAccount,
  saveToken,
  setActiveAccount,
  signIn,
  signInInput,
  useActiveAccount,
} from "./accountState"

const PLANS = ["Pro", "Max", "Team", "Enterprise"]

export function AccountsPage() {
  const open = useApp((s) => s.settingsOpen)
  const choices = useAccountChoices()
  const active = useActiveAccount()
  // the Add dialog: new (no id), or signing an account in again (its id)
  // "accounts:signin:<id>" (the footer, an invalid sign-in): that account signs in again
  const [adding, setAdding] = useState<{ again?: AccountChoice } | null>(() =>
    open === "accounts:add"
      ? {}
      : open?.startsWith("accounts:signin:")
        ? { again: choices.find((a) => a.id === open.slice("accounts:signin:".length)) }
        : null
  )
  return (
    <>
      <PageTitle
        title="Accounts"
        description="The Claude accounts the app can run on. New sessions start on the active one, and a session continues on it with your next message. Every session stays in ~/.claude, whichever account ran it."
        actions={
          <Button size="sm" variant="outline" onClick={() => setAdding({})}>
            <Plus /> Add account
          </Button>
        }
      />
      <SettingsSection>
        {choices.map((a) => (
          <AccountRow
            key={a.id || "login"}
            a={a}
            active={a.id === active}
            onSignInAgain={() => setAdding({ again: a })}
          />
        ))}
      </SettingsSection>
      <SettingsSection title="At the usage limit">
        <AutoSwitch />
      </SettingsSection>
      <OldFolders />
      {adding && (
        <AddAccount again={adding.again} onClose={() => setAdding(null)} />
      )}
    </>
  )
}

function AccountRow({
  a,
  active,
  onSignInAgain,
}: {
  a: AccountChoice
  active: boolean
  onSignInAgain: () => void
}) {
  const [sure, setSure] = useState(false)
  const days = daysLeft(a)
  const ending = days != null && days <= WARN_DAYS
  useEffect(() => {
    if (!sure) return
    const t = setTimeout(() => setSure(false), 3000)
    return () => clearTimeout(t)
  }, [sure])
  return (
    <div
      role="group"
      aria-label={accountTitle(a)}
      className="flex min-h-14 items-center gap-3 border-b border-border py-2.5"
    >
      <span
        className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-sm font-medium"
        aria-hidden
      >
        {initialOf(a)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm text-foreground">
            {a.email ?? "Your Claude login"}
          </span>
          {a.plan && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {a.plan}
            </span>
          )}
          {active && (
            <span className="flex shrink-0 items-center gap-1 rounded-sm bg-muted px-1.5 text-xs text-foreground">
              <Check className="size-3" /> Active
            </span>
          )}
          {a.full && (
            <span className="shrink-0 rounded-sm bg-st-error/15 px-1 text-xs text-st-error-fg">
              at limit
            </span>
          )}
          {a.invalid && (
            <span className="shrink-0 rounded-sm bg-st-error/15 px-1 text-xs text-st-error-fg" title="A session on this account got a 401: its token does not work. Sign in again.">
              sign-in invalid
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
          {a.limits ? (
            <span className="flex w-60 shrink-0 items-center gap-3">
              <Bar p={a.five} label="5 h" />
              <Bar p={a.week} label="week" />
            </span>
          ) : (
            <span>{limitLine(a)}</span>
          )}
          <span className="min-w-0 truncate">
            {a.login
              ? "Your Claude Code login"
              : days == null
                ? "Token"
                : days < 0
                  ? "Token ended: sign in again"
                  : `Token until ${new Date(a.expiresAt!).toLocaleDateString()}`}
          </span>
          {ending && days! >= 0 && (
            <span className="shrink-0 text-st-input-fg">
              ends in {days} d, sign in again
            </span>
          )}
        </div>
      </div>
      {!a.login && (
        <Input
          defaultValue={a.label ?? ""}
          placeholder="Name"
          aria-label={`Name for ${a.email}`}
          onBlur={(e) => renameAccount(a.id, e.target.value)}
          className="h-7 w-24 text-xs"
        />
      )}
      <div className="flex shrink-0 items-center gap-1.5">
        {!active && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setActiveAccount(a.id)}
          >
            Use
          </Button>
        )}
        {!a.login && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={onSignInAgain}
              title="A new token for this account (claude setup-token)"
            >
              <KeyRound /> Sign in again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={sure ? "text-st-error-fg" : undefined}
              title="Removes the token only. Every session stays, with its history."
              onClick={() =>
                sure
                  ? void removeAccount(a.id).then(() =>
                      showUndo("Removed", a.email ?? "account", () =>
                        openSettings("accounts:add")
                      )
                    )
                  : setSure(true)
              }
            >
              {sure ? "Remove?" : "Remove"}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

const AUTO_SWITCH = [
  { value: "0", label: "Off" },
  { value: "50", label: "If under 50 %" },
  { value: "80", label: "If under 80 %" },
  { value: "95", label: "If under 95 %" },
] as const

/** At the limit: switch the whole app to the account with the most room. */
function AutoSwitch() {
  const value = useApp((st) => st.settings.autoSwitchAccount ?? 0)
  const has = useApp((st) => (st.settings.accounts ?? []).length > 0)
  const shown = AUTO_SWITCH.find((o) => Number(o.value) === value)?.value ?? "0"
  return (
    <SettingRow
      title="Switch accounts at the limit"
      hint={has ? undefined : "needs a second account"}
      disabled={!has}
      description="When a session stops at the active account's usage limit, the app switches to the account with the most room (if its 5-hour window is used less than this) and continues the sessions that stopped, one every 45 s. At most one switch in 30 minutes; with no account free, nothing changes (Continue at reset)."
    >
      <SmallSelect
        value={shown}
        onChange={(v) => patchSettings({ autoSwitchAccount: Number(v) })}
        options={AUTO_SWITCH}
        width="w-36"
      />
    </SettingRow>
  )
}

/** Sessions in account folders from before v0.8.16 (CLAUDE_CONFIG_DIR): copied into ~/.claude once. */
function OldFolders() {
  const dirs = useApp((st) => st.settings.claudeConfigDirs ?? [])
  const [pending, setPending] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!dirs.length || !(IN_TAURI && REAL)) return
    let gone = false
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<number>("claude_old_folders_pending", { dirs })
        .then((n) => !gone && setPending(n))
        .catch(() => undefined)
    )
    return () => {
      gone = true
    }
  }, [dirs])
  if (!dirs.length || !pending) return null
  const take = async () => {
    setBusy(true)
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const n = await invoke<number>("claude_take_over_folders", { dirs })
      setPending(0)
      showUndo(
        "Taken over",
        `${plural(n, "session")} now in ~/.claude`,
        () => undefined
      )
    } catch (e) {
      pushNotification({
        sessionId: getApp().mainSessionId,
        kind: "error",
        title: "Accounts",
        body: `Could not take the sessions over: ${String(e)}`,
        createdAt: new Date().toISOString(),
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsSection title="Older account folders">
      <SettingRow
        title={`${plural(pending, "session")} from older account folders`}
        description={`Before v0.8.16 an account was a folder of its own (${dirs.join(", ")}). Take their sessions over into ~/.claude: they are copied, the originals stay where they are. Sign that account in once more with Add account.`}
      >
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void take()}
        >
          Take them over
        </Button>
      </SettingRow>
    </SettingsSection>
  )
}

/**
 * Add an account, or sign one in again: its e-mail, then `claude setup-token` in a terminal of its
 * own (your browser opens). "Signed in" shows only once the token was read and checked against the
 * API. Until then a field takes a code the browser shows, or a token pasted by hand (checked too).
 */
function AddAccount({ again, onClose }: { again?: AccountChoice; onClose: () => void }) {
  const [email, setEmail] = useState(again?.email ?? "")
  const [label, setLabel] = useState(again?.label ?? "")
  const [plan, setPlan] = useState(again?.plan ?? "")
  const [draft, setDraft] = useState<ReturnType<typeof draftAccount> | null>(null)
  const [phase, setPhase] = useState<"waiting" | "checking" | "ended" | "done">("waiting")
  const [output, setOutput] = useState("")
  const [field, setField] = useState("")
  const [err, setErr] = useState<string>()
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const finish = async (d: ReturnType<typeof draftAccount>) => {
    if (again) await replaceAccount(again.id, d)
    else keepAccount(d)
    setPhase("done")
  }
  // the sign-in stops when the dialog closes (its terminal goes with it)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])
  const start = () => {
    if (!ok) return
    stop.current?.()
    setErr(undefined)
    setOutput("")
    setPhase("waiting")
    const d = draftAccount(email, label, plan || undefined)
    setDraft(d)
    stop.current = signIn(d.id, (e) => {
      if (e.type === "output") setOutput(e.text)
      else if (e.type === "checking") setPhase("checking")
      else if (e.type === "invalid") {
        setErr(e.message)
        setPhase("waiting")
      } else if (e.type === "saved") void finish(d)
      else if (e.type === "exit") setPhase((p) => (p === "done" ? p : "ended"))
    })
  }
  // a code from the browser goes to claude; a token is checked and saved
  const submit = async () => {
    if (!draft || !field.trim()) return
    const v = field.trim()
    setErr(undefined)
    if (v.startsWith("sk-ant-")) {
      setPhase("checking")
      try {
        await saveToken(draft.id, v)
        stop.current?.()
        await finish(draft)
      } catch (e) {
        setErr(String(e).replace(/^Error: /, ""))
        setPhase("waiting")
      }
    } else await signInInput(draft.id, v).catch((e) => setErr(String(e)))
    setField("")
  }
  // the last lines claude printed (the link to open, if the browser did not open by itself)
  const lines = output
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-6)
  const link = /https:\/\/\S+/.exec(output)?.[0]
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg gap-4">
        <DialogTitle>{again ? `Sign ${again.email} in again` : "Add a Claude account"}</DialogTitle>
        <DialogDescription>
          {phase === "done"
            ? "Signed in. The token works and is in your system's credential store."
            : draft
              ? "Your browser opens: sign in there with exactly this e-mail and allow access. The token is read and checked by itself."
              : "The e-mail of the account. Then your browser opens to sign in with it; no command to type."}
        </DialogDescription>
        {phase === "done" ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setActiveAccount(draft!.id)
                onClose()
              }}
            >
              <UserRound /> Use it now
            </Button>
            <Button onClick={onClose}>Done</Button>
          </div>
        ) : !draft ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              start()
            }}
          >
            <Input autoFocus type="email" placeholder="name@firm.de" aria-label="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!again} />
            <div className="flex gap-2">
              <Input placeholder="Name (optional): Work, Private" aria-label="Name" value={label} onChange={(e) => setLabel(e.target.value)} className="flex-1" />
              <SmallSelect value={plan || "-"} onChange={(v) => setPlan(v === "-" ? "" : v)} options={[{ value: "-", label: "Plan" }, ...PLANS.map((p) => ({ value: p, label: p }))]} width="w-28" />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!ok}>
                Sign in
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {phase === "checking" ? (
                "Checking the token…"
              ) : phase === "ended" ? (
                "claude setup-token ended without a working token. Try again, or paste a token."
              ) : (
                <>
                  Waiting for the sign-in of <span className="text-foreground">{draft.email}</span>…
                </>
              )}
            </p>
            {lines.length > 0 && (
              <pre aria-label="claude setup-token" className="max-h-36 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-muted-foreground">
                {lines.join("\n")}
              </pre>
            )}
            {link && (
              <a href={link} target="_blank" rel="noreferrer" className="self-start text-xs text-foreground underline underline-offset-2">
                The browser did not open? Open the sign-in page
              </a>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <Input type="password" autoComplete="off" placeholder="Code from the browser, or a token (sk-ant-…)" aria-label="Code or token" value={field} onChange={(e) => setField(e.target.value)} className="flex-1 font-mono text-xs" disabled={phase === "checking"} />
              <Button type="submit" size="sm" disabled={!field.trim() || phase === "checking"}>
                Send
              </Button>
            </form>
            {err && <p className="text-xs text-st-error-fg">{err}</p>}
            <div className="flex justify-end gap-2">
              {phase === "ended" && (
                <Button variant="outline" onClick={start}>
                  Try again
                </Button>
              )}
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
