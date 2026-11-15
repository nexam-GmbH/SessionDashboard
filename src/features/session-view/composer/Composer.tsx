// The chat's prompt box (Claude Code desktop layout) with the session's settings in
// the row under it: permission mode, model, effort and the context ring. Key semantics mirror the
// Claude Code CLI: Enter queues while Claude is working (the queue above stays
// editable), Ctrl/⌘+Enter sends now, ↑ edits the last queued message, Esc in an empty box stops,
// Esc Esc opens Rewind, Shift+Tab cycles the permission mode.
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { REAL } from "@/backend/mode"
import type { ID, PermissionMode } from "@/lib/model"
import { useApp } from "@/store/app"
import { addSessionFolder, forkSession, removeSessionFolder, sendMessage, setSessionSettings } from "@/store/actions"
import { runInTerminal, runSlashInTerminal } from "@/features/terminal/terminals"
import { MOD } from "@/components/common/bits"
import { capabilities } from "@/lib/status"
import { PromptBox } from "@/features/composer/PromptBox"
import { EffortPicker, ModePicker, ModelExtras, ModelPicker } from "@/features/composer/Pickers"
import { ContextRing } from "@/features/composer/ContextRing"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { FolderPlus } from "lucide-react"
import { plural } from "@/lib/format"
import { getUiValue, interruptSession, takeLastQueued } from "../sessionStore"

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"]
const EMPTY_FILES: string[] = []

/** A reply to a terminal session: typed into its terminal, or (when that can't be done) a copy here. */
function replyToTerminal(id: ID, text: string, way: string | null) {
  if (way) {
    void import("@/backend/real").then((r) =>
      r.realInject(id, text).catch(() => forkSession(id, text)),
    )
    return
  }
  forkSession(id, text)
}

export const Composer = memo(function Composer({ sessionId }: { sessionId: ID }) {
  const control = useApp((s) => s.sessions[sessionId]?.control)
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const mode = useApp((s) => s.sessions[sessionId]?.permissionMode)
  const model = useApp((s) => s.sessions[sessionId]?.model)
  const effort = useApp((s) => s.sessions[sessionId]?.effort)
  const fast = useApp((s) => s.sessions[sessionId]?.fastMode)
  const ultra = useApp((s) => s.sessions[sessionId]?.ultracode)
  const style = useApp((s) => s.sessions[sessionId]?.outputStyle)
  const repoId = useApp((s) => s.sessions[sessionId]?.repoId)
  const dirs = useApp((s) => s.sessions[sessionId]?.additionalDirs)
  const repos = useApp((s) => s.repos)
  const repoOrder = useApp((s) => s.repoOrder)
  const files = useApp((s) => (repoId ? (s.repoSpecs[repoId]?.files ?? EMPTY_FILES) : EMPTY_FILES))
  const lastEsc = useRef(0)
  // Rewind puts the prompt back here; the session view remounts the composer with a new key
  const initialText = useMemo(() => getUiValue<{ text: string } | null>(`prefill:${sessionId}`, null)?.text ?? "", [sessionId])
  // a terminal session: whether a reply can be typed into its terminal
  const [injectWay, setInjectWay] = useState<string | null>(null)
  useEffect(() => {
    if (!(REAL && control === "observed")) return
    let alive = true
    void import("@/backend/real").then((r) => r.realInjectWay(sessionId).then((w) => alive && setInjectWay(w)))
    return () => {
      alive = false
    }
  }, [sessionId, control])

  const folders = useMemo(() => {
    const added = repoOrder.filter((id) => dirs?.includes(repos[id].rootPath))
    return {
      candidates: repoOrder.filter((id) => id !== repoId).map((id) => ({ id, name: repos[id].name })),
      added,
      onAdd: (id: ID) => addSessionFolder(sessionId, id),
      onRemove: (id: ID) => removeSessionFolder(sessionId, id),
      // a running session's extra folders are a quiet note under the box, not chips in it
      chips: false,
    }
  }, [repoOrder, repos, repoId, dirs, sessionId])

  if (!control || !mode || !model || !effort) return null
  const caps = capabilities(control)
  // a session in a terminal never closes because you replied here: the reply is typed into that
  // terminal when it allows it (Konsole, tmux, kitty, WezTerm, the app's terminal), else it continues
  // in a copy in this app while the terminal keeps its own. Take over (the banner) moves it on purpose.
  const takeOver = REAL && control === "observed"
  // a past session: the banner above offers Resume; nothing to type into until then
  if (!caps.send && !takeOver) return null
  const working = status === "working" || status === "starting"
  // a terminal session: what you pick here applies when it moves into the app (your next message)
  const locked = !caps.changeSettings && !takeOver
  const lockReason = "Runs in your terminal: change it there"
  const observedNote = control === "observed" ? " · goes to your terminal" : ""

  return (
    <div className="mx-auto w-full max-w-[var(--chat-w)] px-5 pb-3">
      <PromptBox
        files={files}
        initialText={initialText}
        placeholder={takeOver ? (injectWay ? `Reply: typed into its terminal (${injectWay}); it keeps running there` : "Reply: continues in a copy here (Settings → Sessions → Sync terminal sessions keeps it one session)") : working ? "Add to the queue, or Esc to stop" : "Reply to Claude"}
        keysHint={`${working ? `Enter queues, ${MOD}+Enter sends now, Escape stops.` : "Enter sends, Shift+Enter adds a line."} Slash for commands, at sign to mention a file, ! runs a command in the terminal.${locked ? "" : " Shift+Tab changes the permission mode."}`}
        sendHint={takeOver ? (injectWay ? `Send to ${injectWay} · Enter` : "Continue in a copy · Enter") : working ? `Enter: after this step · ${MOD}+Enter: send now${observedNote}` : `Send · Enter${observedNote}`}
        busy={working && caps.interrupt}
        onStop={() => interruptSession(sessionId)}
        onSubmit={(text, attachments, how) => (/^!\s*\S/.test(text) && !attachments.length ? void runInTerminal(text.replace(/^!\s*/, "").trim()) : !attachments.length && runSlashInTerminal(text, sessionId) ? undefined : takeOver ? replyToTerminal(sessionId, attachments.length ? `${text}\n\n${attachments.map((a) => `[attached: ${a}]`).join("\n")}` : text, injectWay) : sendMessage(sessionId, text, how, attachments))}
        onEscapeEmpty={(e) => {
          if (working && caps.interrupt) {
            e.preventDefault()
            interruptSession(sessionId)
          } else if (caps.changeSettings) {
            // Esc Esc opens Rewind (Claude Code CLI)
            const now = performance.now()
            if (now - lastEsc.current < 500) {
              e.preventDefault()
              window.dispatchEvent(new CustomEvent("sd:rewind", { detail: sessionId }))
              lastEsc.current = 0
            } else lastEsc.current = now
          }
        }}
        onArrowUpEmpty={() => takeLastQueued(sessionId)}
        onShiftTab={locked ? undefined : () => setSessionSettings(sessionId, { permissionMode: MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length] })}
        folders={locked ? undefined : folders}
        footer={
          <>
            {folders.added.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground/70 outline-none focus-visible:ring-1 focus-visible:ring-ring">
                    <FolderPlus size={13} />
                    {plural(folders.added.length, "folder")}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-72">
                  Also sees {folders.added.map((id) => repos[id].name).join(", ")}. Change it under + → Add folder.
                </TooltipContent>
              </Tooltip>
            )}
            <span className="flex-1" />
            {/* Claude Code desktop: model, effort and permissions at the bottom right; the rest in the model menu */}
            <ModelPicker
              value={model}
              onChange={(m) => setSessionSettings(sessionId, { model: m })}
              disabled={locked}
              disabledReason={lockReason}
              extra={<ModelExtras model={model} fast={!!fast} ultra={!!ultra} style={style} onChange={(patch) => setSessionSettings(sessionId, patch)} />}
            />
            <EffortPicker value={effort} model={model} onChange={(e) => setSessionSettings(sessionId, { effort: e })} disabled={locked} disabledReason={lockReason} />
            <ModePicker value={mode} onChange={(permissionMode) => setSessionSettings(sessionId, { permissionMode })} disabled={locked} disabledReason={lockReason} />
            <ContextRing sessionId={sessionId} canCompact={!locked} />
          </>
        }
      />
    </div>
  )
})
