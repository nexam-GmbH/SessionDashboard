// "Where was I": back at a session after 10 minutes or more, a short card above the prompt box says
// what you last asked, what happened since and, when Claude Code wrote one, its own recap of where
// things stand. Gone once you send something, dismiss it or leave.
import { memo, useEffect, useMemo } from "react"
import { History } from "lucide-react"
import type { ID, Transcript } from "@/lib/model"
import { useApp } from "@/store/app"
import { AWAY_MS, setAway, useAway } from "@/store/away"
import { currentSessionId } from "@/store/actions"
import { Button } from "@/components/ui/button"
import { minutes } from "@/features/composer/cache"
import { plural } from "@/lib/format"

const plain = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>|]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()

interface Since {
  turns: number
  files: number
  commands: number
  asked?: string
}

function summarize(t: Transcript, since: string): Since | null {
  const turns = new Set<string>()
  const files = new Set<string>()
  let commands = 0
  let asked: string | undefined
  let any = false
  for (let i = t.order.length - 1; i >= 0; i--) {
    const it = t.items[t.order[i]]
    if (!it) continue
    const after = it.at > since
    if (it.type === "user_message") {
      asked ??= it.text
      if (!after) break
    }
    if (!after) continue
    any = true
    turns.add(it.turnId)
    if (it.type === "tool_call") {
      const c = it.call
      if (c.status !== "completed") continue
      if (c.diff?.length) for (const f of c.diff) files.add(f.path)
      else if (c.kind === "edit") for (const l of c.locations ?? []) files.add(l.path)
      if (c.kind === "execute") commands++
    }
  }
  if (!any) return null
  return { turns: turns.size, files: files.size, commands, asked: asked && plain(asked) }
}

export const SinceCard = memo(function SinceCard({ sessionId }: { sessionId: ID }) {
  const since = useAway(sessionId)
  const t = useApp((s) => s.transcripts[sessionId])
  // away from the window for a while with this session in front counts too
  useEffect(() => {
    let blurred = 0
    const onBlur = () => (blurred = Date.now())
    const onFocus = () => {
      if (blurred && Date.now() - blurred >= AWAY_MS && currentSessionId() === sessionId) setAway(sessionId, new Date(blurred).toISOString())
      blurred = 0
    }
    window.addEventListener("blur", onBlur)
    window.addEventListener("focus", onFocus)
    return () => {
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("focus", onFocus)
    }
  }, [sessionId])
  const sum = useMemo(() => (since && t ? summarize(t, since) : null), [since, t])
  if (!since || !sum || !t) return null
  const recap = t.recap && t.recap.at > since ? t.recap.text : undefined
  const facts = [sum.turns > 1 && plural(sum.turns, "turn"), sum.files > 0 && `${plural(sum.files, "file")} edited`, sum.commands > 0 && plural(sum.commands, "command")].filter(Boolean)
  return (
    <section aria-label="Since you were here" className="mb-2 flex flex-col gap-1.5 rounded-xl bg-card px-3 py-2 text-xs ring-1 ring-foreground/10">
      <header className="flex h-6 items-center gap-2 text-muted-foreground">
        <History size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          Since you were here <time title={new Date(since).toLocaleString()}>{minutes(Date.now() - Date.parse(since))} ago</time>
          {facts.length > 0 && <span className="text-muted-foreground/70"> · {facts.join(" · ")}</span>}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setAway(sessionId, null)}>
          Dismiss
        </Button>
      </header>
      {sum.asked && (
        <p className="line-clamp-1 text-muted-foreground" title={sum.asked}>
          You asked: <span className="text-foreground">{sum.asked}</span>
        </p>
      )}
      {/* Claude's last message is right above in the chat; its recap (when Claude Code wrote one) is not */}
      {recap && <p className="line-clamp-3 text-sm text-foreground">{recap}</p>}
    </section>
  )
})
