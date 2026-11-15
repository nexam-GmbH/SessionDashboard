// Settings over the current screen, like Claude Code desktop's: the sections on the left, the chosen
// one on the right. Closing it leaves you where you were.
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { useApp } from "@/store/app"
import { closeSettings, openSettings } from "@/store/actions"
import { cn } from "@/lib/utils"
import { SECTIONS } from "./SettingsView"

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen)
  const current = SECTIONS.find((x) => x.id === open) ?? SECTIONS[0]
  const Page = current.Page
  return (
    <Dialog open={!!open} onOpenChange={(o) => !o && closeSettings()}>
      <DialogContent className="flex h-[min(760px,85vh)] w-[min(1040px,92vw)] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Sessions, defaults for new sessions, notifications and the window</DialogDescription>
        <nav aria-label="Settings sections" className="flex w-52 shrink-0 flex-col gap-0.5 border-r bg-sidebar p-2">
          <h2 className="px-2 pt-2 pb-3 text-sm font-medium">Settings</h2>
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              onClick={() => openSettings(x.id)}
              aria-current={x.id === current.id ? "page" : undefined}
              className={cn(
                "flex h-8 items-center rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                x.id === current.id ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              {x.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-8 pt-6 pb-10">
          <Page />
        </div>
      </DialogContent>
    </Dialog>
  )
}
