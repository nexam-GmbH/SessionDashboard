// "Start fresh": a new session in the same folder, opened with an editable brief of this one instead
// of its whole conversation. Offered where the context is large; the old session stays.
import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { getApp } from "@/store/app"
import { startFresh } from "@/store/actions"
import type { ID } from "@/lib/model"
import { buildBrief } from "../brief"

function branchOf(id: ID) {
  const st = getApp()
  const s = st.sessions[id]
  const repo = s?.repoId ? st.repos[s.repoId] : undefined
  return repo?.worktrees.find((w) => w.id === s?.worktreeId)?.branch || repo?.git?.branch
}

export function StartFreshButton({ sessionId, size = "xs" }: { sessionId: ID; size?: "xs" | "sm" }) {
  const [brief, setBrief] = useState<string | null>(null)
  const open = () => {
    const st = getApp()
    const s = st.sessions[sessionId]
    if (s) setBrief(buildBrief(s, st.transcripts[sessionId], branchOf(sessionId)))
  }
  return (
    <>
      <Button size={size} variant="outline" onClick={open} title="A new session in the same folder, started with a short brief of this one">
        Start fresh…
      </Button>
      <Dialog open={brief !== null} onOpenChange={(o) => !o && setBrief(null)}>
        <DialogContent className="flex max-h-[85vh] w-[min(760px,92vw)] max-w-none flex-col sm:max-w-none">
          <DialogHeader>
            <DialogTitle>Start fresh with a brief</DialogTitle>
            <DialogDescription>
              A new session in the same folder starts with this brief instead of the whole conversation, so what matters sits where the model uses it best. Edit it as you like; this session stays as it is.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={brief ?? ""}
            onChange={(e) => setBrief(e.target.value)}
            aria-label="Brief for the new session"
            className="min-h-64 flex-1 overflow-y-auto font-mono text-xs leading-5 [field-sizing:fixed] md:text-xs"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBrief(null)}>
              Cancel
            </Button>
            <Button
              disabled={!brief?.trim()}
              onClick={() => {
                if (brief) startFresh(sessionId, brief)
                setBrief(null)
              }}
            >
              Start
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
