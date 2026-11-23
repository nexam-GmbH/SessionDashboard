// Bottom left of the sidebar: the account the app runs on (its e-mail, plan and 5-hour use). A
// click lists every account with its limits; another one is active at once (a notice says so, with
// Undo). Below them: add an account, manage accounts (Settings → Accounts).
import { ChevronsUpDown, KeyRound, Plus, Settings2 } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { openSettings } from "@/store/actions"
import { REAL } from "@/backend/mode"
import { initialOf, WARN_DAYS, daysLeft } from "@/lib/accounts"
import { cn } from "@/lib/utils"
import { AccountItems, useAccountChoices } from "./AccountItems"
import { setActiveAccount, useActiveAccount } from "./accountState"

export function AccountSwitcher() {
  const active = useActiveAccount()
  const choices = useAccountChoices()
  const me = choices.find((a) => a.id === active) ?? choices[0]
  // no login known (signed out): the row says so and leads to Settings → Accounts
  const signedOut = REAL && me.login && !me.email
  // a token that ends soon: here and on the Accounts page
  const ending = choices.filter((a) => {
    const d = daysLeft(a)
    return d != null && d <= WARN_DAYS
  })
  const five = me.five
  if (signedOut) {
    return (
      <SidebarMenuButton
        size="lg"
        onClick={() => openSettings("accounts")}
        className="text-st-input-fg"
        title="No Claude Code login found: Settings → Accounts"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-st-input/20 text-xs font-medium">
          ?
        </span>
        <span className="truncate text-sm">Not signed in</span>
      </SidebarMenuButton>
    )
  }
  // inside the footer's SidebarMenuItem
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          aria-label={`Account: ${me.email ?? "your Claude login"}. Switch account`}
          className="data-[state=open]:bg-sidebar-accent"
        >
          <span
            className="grid size-7 shrink-0 place-items-center rounded-full bg-sidebar-accent text-xs font-medium text-sidebar-accent-foreground"
            aria-hidden
          >
            {initialOf(me)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[13px]" title={me.email}>
              {me.label ? `${me.label} · ` : ""}
              {me.email ?? "Your Claude login"}
            </span>
            <span
              className={cn(
                "truncate text-[11px]",
                me.invalid
                  ? "text-st-error-fg"
                  : ending.length
                    ? "text-st-input-fg"
                    : "text-muted-foreground"
              )}
              title={
                ending.length
                  ? `The token of ${ending.map((a) => a.email).join(", ")} ends soon: Settings → Accounts → Sign in again`
                  : undefined
              }
            >
              {me.invalid
                ? "Sign-in invalid · sign in again"
                : ending.length
                ? `A token ends in ${Math.max(0, daysLeft(ending[0]) ?? 0)} d`
                : (me.plan ?? "Claude")}
            </span>
          </span>
          {five != null && (
            <span
              className={cn(
                "shrink-0 text-xs tabular",
                five >= 90
                  ? "text-st-error-fg"
                  : five >= 75
                    ? "text-st-input-fg"
                    : "text-muted-foreground"
              )}
              title="5-hour window used"
            >
              {Math.round(five)}%
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-72"
        aria-label="Accounts"
      >
        {me.invalid && (
          <>
            <DropdownMenuItem onSelect={() => openSettings(`accounts:signin:${me.id}`)} className="text-st-error-fg">
              <KeyRound /> Sign {me.email} in again
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Run on</DropdownMenuLabel>
        <AccountItems choices={choices} onPick={(id) => setActiveAccount(id)} />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSettings("accounts:add")}>
          <Plus /> Add account
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openSettings("accounts")}>
          <Settings2 /> Manage accounts
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
