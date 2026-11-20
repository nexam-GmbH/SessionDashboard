// Above the overview after a restart: "5 sessions were running when the app last closed", with a
// choice of which to bring back (each resumes as a session the app runs, idle until you write).
import { useState } from "react"
import { History } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useShallow } from "zustand/react/shallow"
import { useApp } from "@/store/app"
import { resumeMany } from "@/store/actions"
import { plural } from "@/lib/format"
import { useRestore } from "./restore"

export function RestoreCard() {
  const r = useRestore()
  // only the sessions it offers back: any other session changing does not render this again
  const listed = useApp(useShallow((s) => (r?.ids ?? []).map((id) => s.sessions[id])))
  const repos = useApp((s) => s.repos)
  const [off, setOff] = useState<Set<string>>(() => new Set())
  const [open, setOpen] = useState(false)
  if (!r) return null
  const byId = new Map(listed.filter(Boolean).map((s) => [s.id, s]))
  const ids = r.ids.filter((id) => byId.has(id))
  if (!ids.length) return null
  const chosen = ids.filter((id) => !off.has(id))
  const done = () => useRestore.setState(null, true)
  return (
    <section aria-label="Sessions from last time" className="mx-auto mt-4 flex w-[min(720px,calc(100%-2rem))] flex-col gap-2 rounded-xl bg-card px-4 py-3 text-sm ring-1 ring-foreground/10">
      <header className="flex items-center gap-2">
        <History size={15} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">{plural(ids.length, "session")} {ids.length === 1 ? "was" : "were"} running when the app last closed.</span>
        <Button size="xs" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Choose"}
        </Button>
        <Button size="xs" variant="ghost" onClick={done}>
          Dismiss
        </Button>
        <Button
          size="xs"
          disabled={!chosen.length}
          onClick={() => {
            resumeMany(chosen)
            done()
          }}
        >
          Resume {chosen.length === ids.length ? "all" : chosen.length}
        </Button>
      </header>
      {open && (
        <ul className="flex flex-col gap-1 pl-6">
          {ids.map((id) => {
            const s = byId.get(id)!
            const repo = s.repoId ? repos[s.repoId]?.name : undefined
            return (
              <li key={id}>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={!off.has(id)}
                    onCheckedChange={(v) =>
                      setOff((prev) => {
                        const next = new Set(prev)
                        if (v) next.delete(id)
                        else next.add(id)
                        return next
                      })
                    }
                  />
                  <span className="min-w-0 truncate">{s.title}</span>
                  {repo && <span className="shrink-0 text-xs text-muted-foreground">{repo}</span>}
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
