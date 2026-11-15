import { useMemo, useState } from "react"
import { Check, FolderGit2, FolderOpen } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

/**
 * Add repositories. Pick a
 * folder, the scan lists git repos with how many Claude Code sessions already
 * exist for each (matched by transcript cwd). Phase 1: mock scan result.
 */
const SCAN = [
  { name: "search-service", path: "~/code/search-service", sessions: 14, branch: "main" },
  { name: "payments-api", path: "~/code/payments-api", sessions: 31, branch: "main" },
  { name: "catalog-web", path: "~/code/catalog-web", sessions: 7, branch: "main" },
  { name: "inventory-worker", path: "~/code/inventory-worker", sessions: 0, branch: "master" },
  { name: "scheduler", path: "~/code/scheduler", sessions: 3, branch: "main" },
  { name: "docs-site", path: "~/code/docs-site", sessions: 22, branch: "main" },
  { name: "dotfiles", path: "~/code/dotfiles", sessions: 0, branch: "main" },
]

export function AddReposDialog({ onClose, firstRun }: { onClose: () => void; firstRun?: boolean }) {
  const [folder] = useState("~/code")
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SCAN.map((r) => [r.name, r.sessions > 0])),
  )
  const count = useMemo(() => Object.values(selected).filter(Boolean).length, [selected])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[620px] gap-0 border-border bg-muted p-0 sm:max-w-[620px]">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium">{firstRun ? "Add your repos" : "Add repos"}</DialogTitle>
          <DialogDescription className="sr-only">
            Pick a folder. Repos with existing Claude Code sessions are pre-selected; their history is imported, nothing is moved.
          </DialogDescription>
        </div>
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="flex h-7 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2 font-mono text-xs text-muted-foreground">
            <FolderOpen size={13} className="text-muted-foreground/70" />
            {folder}
          </div>
          <Button size="sm" variant="outline">Choose…</Button>
        </div>
        <div className="max-h-[320px] overflow-y-auto border-b border-border" title="Repos with existing Claude Code sessions are preselected">
          {SCAN.map((r) => (
            <label key={r.name} className="flex h-8 cursor-default items-center gap-3 border-b border-border px-4 last:border-0 hover:bg-accent/50">
              <Checkbox checked={!!selected[r.name]} onCheckedChange={(v) => setSelected((s) => ({ ...s, [r.name]: !!v }))} className="size-3.5" />
              <FolderGit2 size={14} className="text-muted-foreground/70" />
              <span className="w-40 text-sm text-foreground">{r.name}</span>
              <span className="flex-1 truncate font-mono text-xs text-muted-foreground/70">{r.path}</span>
              <span className={cn("tabular w-20 text-right text-xs", r.sessions ? "text-muted-foreground" : "text-muted-foreground/70")} title={`${r.sessions} existing Claude Code sessions`}>
                {r.sessions ? `${r.sessions} sessions` : ""}
              </span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2 px-4 py-3">
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="default" onClick={onClose} disabled={!count}>
            <Check /> Import {count}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
