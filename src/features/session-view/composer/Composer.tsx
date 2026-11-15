// The chat's prompt box (Claude Code desktop's Code tab) with the session's settings in the row
// under it: permission mode, model, effort and the context ring. You can always write: while
// Claude works, a session the app runs takes the message at once and reads it after its current
// step; one it can't write to yet queues it and sends it when the turn is over (the mock world
// queues too). ↑ in an empty box opens the newest queued message, Esc stops, Esc Esc opens Rewind,
// Shift+Tab cycles the permission mode. The text you leave in the box stays with the session.
import { memo, useEffect, useRef, useState } from "react"
import { REAL } from "@/backend/mode"
import type { ID, PermissionMode } from "@/lib/model"
import { getApp, useApp } from "@/store/app"
import { takeImages } from "@/features/composer/images"
import { addSessionFolder, removeSessionFolder, sendMessage, setSessionSettings, takeOverSession } from "@/store/actions"
import { runInTerminal, runSlashInTerminal } from "@/features/terminal/terminals"
import { MOD } from "@/components/common/bits"
import { capabilities } from "@/lib/status"
import { PromptBox, type PromptValue } from "@/features/composer/PromptBox"
import { EffortPicker, ModePicker, ModelExtras, ModelPicker } from "@/features/composer/Pickers"
import { ContextRing } from "@/features/composer/ContextRing"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { FolderPlus, LoaderCircle } from "lucide-react"
import { plural } from "@/lib/format"
import {
  cancelQueueEdit,
  editQueuedInBox,
  getUiValue,
  interruptSession,
  markSteered,
  queueMessage,
  saveQueueEdit,
  setDraft,
  useDraft,
  useQueued,
  useQueueEdit,
  useSteerPending,
} from "../sessionStore"

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"]
const EMPTY_FILES: string[] = []
/** Rewind prefills already put into a box (each remounts the composer once) */
const usedPrefill = new Map<ID, number>()

const withNames = (text: string, attachments: string[]) => (attachments.length ? `${text}\n\n${attachments.map((a) => `[attached: ${a}]`).join("\n")}` : text)

/** A reply to a terminal session: typed into its terminal, or (when that can't be done) a copy here. */
function replyToTerminal(id: ID, text: string, attachments: string[], way: string | null) {
  // a headless session the app started before it restarted: taken back (nothing is lost) once its
  // turn is over; while it works the message waits in the queue
  if (way === "headless") {
    const s = getApp().sessions[id]
    if (s && s.status !== "idle" && s.status !== "done_unseen") return void queueMessage(id, text, attachments)
    const { images, rest } = takeImages(attachments)
    takeOverSession(id, withNames(text, rest), images)
    return
  }
  if (way) {
    void import("@/backend/real").then((r) =>
      r.realInject(id, withNames(text, attachments)).catch((e) => r.realNotice(id, `Could not type into its terminal: ${String(e)}`)),
    )
    return
  }
  // no way into that terminal: say how to get one, keep the text (Fork in the session menu makes a copy)
  void import("@/backend/real").then((r) =>
    r.realNotice(id, "This terminal can't be typed into from the app. Turn on Settings → Sessions → Sync terminal sessions, then start claude there again (claude --resume picks this conversation up); or answer in the terminal. Fork in the session menu continues it as a copy here."),
  )
  return false
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
  const draft = useDraft(sessionId)
  const queued = useQueued(sessionId)
  const edit = useQueueEdit(sessionId)
  const steering = useSteerPending(sessionId)
  const lastEsc = useRef(0)
  // Rewind puts a prompt back here (the session view remounts the composer for each one)
  useEffect(() => {
    const p = getUiValue<{ n: number; text: string } | null>(`prefill:${sessionId}`, null)
    if (!p || usedPrefill.get(sessionId) === p.n) return
    usedPrefill.set(sessionId, p.n)
    cancelQueueEdit(sessionId)
    setDraft(sessionId, { text: p.text, attachments: [] })
  }, [sessionId])
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
  const headless = takeOver && injectWay === "headless"
  // a queued message open in the box (if it went out meanwhile, saving sends the edit as a new one)
  const editing = !!edit

  const placeholder = editing
    ? "Edit the queued message"
    : takeOver && !headless
      ? injectWay
        ? `Reply: typed into its terminal (${injectWay})`
        : "Reply in the terminal, or turn on Settings → Sessions → Sync terminal sessions"
      : working
        ? headless
          ? "Add a note — sent when Claude finishes this turn"
          : steering
            ? "Add another note"
            : "Add a note — Claude reads it after the current step"
        : "Reply to Claude…"
  const canStop = working && caps.interrupt
  const hint = editing
    ? "Enter saves · Esc cancels · empty removes it"
    : [
        working && !REAL ? `Enter queues · ${MOD}+Enter sends now` : "Enter sends · Shift+Enter new line",
        queued.length && !draft.text ? "↑ edits the queue" : "",
        canStop && !draft.text ? "Esc stops" : "",
      ]
        .filter(Boolean)
        .join(" · ")

  const submit = (text: string, attachments: string[], how: "queue" | "now") => {
    if (editing) {
      saveQueueEdit(sessionId, text, attachments)
      return false
    }
    if (/^!\s*\S/.test(text) && !attachments.length) return void runInTerminal(text.replace(/^!\s*/, "").trim())
    if (!attachments.length && runSlashInTerminal(text, sessionId)) return
    if (takeOver) return replyToTerminal(sessionId, text, attachments, injectWay)
    sendMessage(sessionId, text, how, attachments)
    // a session the app runs read it after its current step (steering): say so until it moves on
    if (REAL && working && control === "owned") markSteered(sessionId)
  }

  return (
    <div className="mx-auto w-full max-w-[var(--chat-w)] px-5 pb-3">
      <PromptBox
        files={files}
        value={draft}
        onValueChange={(fn: (v: PromptValue) => PromptValue) => setDraft(sessionId, fn)}
        editing={editing}
        placeholder={placeholder}
        hint={hint}
        keysHint={`${!working ? "Enter sends, Shift+Enter adds a line." : REAL && !headless ? "Enter adds a note Claude reads after its current step, Escape stops." : `Enter queues, ${MOD}+Enter sends now, Escape stops.`} Up arrow in an empty box edits the newest queued message. Slash for commands, at sign to mention a file, ! runs a command in the terminal.${locked ? "" : " Shift+Tab changes the permission mode."}`}
        sendHint={takeOver && !headless ? (injectWay ? `Send to ${injectWay} · Enter` : "Not synced") : working ? (headless || !REAL ? "Queue · Enter" : "Send now · Enter") : "Send · Enter"}
        busy={canStop}
        onStop={() => interruptSession(sessionId)}
        onSubmit={submit}
        onEscape={() => {
          if (!edit) return false
          cancelQueueEdit(sessionId)
          return true
        }}
        onEscapeEmpty={(e) => {
          if (canStop) {
            e.preventDefault()
            interruptSession(sessionId)
          } else if (caps.changeSettings) {
            // Esc Esc opens Rewind (Claude Code CLI)
            const now = e.timeStamp
            if (now - lastEsc.current < 500) {
              e.preventDefault()
              window.dispatchEvent(new CustomEvent("sd:rewind", { detail: sessionId }))
              lastEsc.current = 0
            } else lastEsc.current = now
          }
        }}
        onArrowUpEmpty={() => editQueuedInBox(sessionId)}
        onShiftTab={locked ? undefined : () => setSessionSettings(sessionId, { permissionMode: MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length] })}
        folders={
          locked
            ? undefined
            : {
                candidates: repoOrder.filter((id) => id !== repoId).map((id) => ({ id, name: repos[id].name })),
                added: repoOrder.filter((id) => dirs?.includes(repos[id].rootPath)),
                onAdd: (id: ID) => addSessionFolder(sessionId, id),
                onRemove: (id: ID) => removeSessionFolder(sessionId, id),
                // a running session's extra folders are a quiet note under the box, not chips in it
                chips: false,
              }
        }
        header={
          steering && (
            <div role="status" className="flex h-8 items-center gap-2 border-b border-border px-4 text-xs text-muted-foreground">
              <LoaderCircle size={14} className="shrink-0 animate-spin-steps text-st-working" />
              Claude reads your message after the current step
            </div>
          )
        }
        footer={
          <>
            <FoldersNote ids={repoOrder.filter((id) => dirs?.includes(repos[id].rootPath))} names={repos} />
            {/* Claude Code desktop: permission mode, model and effort under the box, then context */}
            <ModePicker value={mode} onChange={(permissionMode) => setSessionSettings(sessionId, { permissionMode })} disabled={locked} disabledReason={lockReason} />
            <ModelPicker
              value={model}
              onChange={(m) => setSessionSettings(sessionId, { model: m })}
              disabled={locked}
              disabledReason={lockReason}
              extra={<ModelExtras model={model} fast={!!fast} ultra={!!ultra} style={style} onChange={(patch) => setSessionSettings(sessionId, patch)} />}
            />
            <EffortPicker value={effort} model={model} onChange={(e) => setSessionSettings(sessionId, { effort: e })} disabled={locked} disabledReason={lockReason} />
            <ContextRing sessionId={sessionId} canCompact={!locked} />
          </>
        }
      />
    </div>
  )
})

/** The extra folders a running session sees (`--add-dir`), as a quiet count with their names on hover. */
function FoldersNote({ ids, names }: { ids: ID[]; names: Record<ID, { name: string }> }) {
  if (!ids.length) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground/70 outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <FolderPlus size={14} />
          {plural(ids.length, "folder")}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        Also sees {ids.map((id) => names[id].name).join(", ")}. Change it under + → Add folder.
      </TooltipContent>
    </Tooltip>
  )
}
