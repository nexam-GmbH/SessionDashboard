// "Continue on another account" in the session menu and on the details panel's Account row: the
// conversation goes on as a fork on the account picked (its transcript copied there), the old
// session is archived. Shown only with another Claude account set up, for sessions on this computer.
import { UserRound } from "lucide-react"
import { DropdownMenuLabel, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu"
import { getApp, useApp } from "@/store/app"
import { continueOnAccount, pushNotification } from "@/store/actions"
import { accountKey, accountLabel } from "@/lib/accounts"
import { compact } from "@/lib/format"
import type { ID } from "@/lib/model"
import { useCache } from "@/features/composer/cache"
import { AccountItems, useAccountChoices, useHasAccounts } from "./AccountItems"

/** Why a session can't move now, or null when it can. */
function blocked(s: { machine?: string; role: string; status: string } | undefined) {
  if (!s) return "The session is gone"
  if (s.role === "main") return "The main agent stays on its account"
  if (s.machine) return "Only sessions on this computer can move to another account"
  if (s.status === "working" || s.status === "starting") return "Available when Claude finishes this turn"
  return null
}

export function moveSession(id: ID, dir: string) {
  void continueOnAccount(id, dir, { open: true }).catch((e) => {
    const s = getApp().sessions[id]
    pushNotification({ sessionId: id, kind: "error", title: s?.title ?? "Session", body: `Could not continue on ${accountLabel(dir)}: ${String(e).replace(/^Error: /, "")}`, createdAt: new Date().toISOString() })
  })
}

/** Whether the session can move at all (another account set up, on this computer, not the main agent). */
export function useCanMove(sessionId: ID) {
  const has = useHasAccounts()
  const fixed = useApp((st) => !!st.sessions[sessionId]?.machine || st.sessions[sessionId]?.role === "main")
  return has && !fixed
}

/** Why it can't move right now (a turn running), or null. */
export function useMoveBlocked(sessionId: ID) {
  return useApp((st) => blocked(st.sessions[sessionId]))
}

/** The accounts as menu items, with what moving costs (the prompt cache stays behind). */
export function ContinueOnAccountItems({ sessionId }: { sessionId: ID }) {
  const configDir = useApp((st) => st.sessions[sessionId]?.configDir)
  const choices = useAccountChoices([accountKey(configDir)])
  const cache = useCache(sessionId)
  return (
    <>
      <DropdownMenuLabel>Now on {accountLabel(configDir)}. Continue on</DropdownMenuLabel>
      <AccountItems choices={choices} onPick={(dir) => moveSession(sessionId, dir)} />
      <DropdownMenuLabel className="whitespace-normal">
        {cache && cache.tokens > 0 ? `The prompt cache stays with this account: the first message there reads all ${compact(cache.tokens)} tokens again.` : "The prompt cache stays with this account: the first message there reads the whole conversation again."} This
        session is archived.
      </DropdownMenuLabel>
    </>
  )
}

/** The session menu's submenu: every other account, with its limits. */
export function ContinueOnAccountSub({ sessionId }: { sessionId: ID }) {
  const can = useCanMove(sessionId)
  const why = useMoveBlocked(sessionId)
  if (!can) return null
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!!why} title={why ?? undefined}>
        <UserRound /> Continue on another account
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-80">
        <ContinueOnAccountItems sessionId={sessionId} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
