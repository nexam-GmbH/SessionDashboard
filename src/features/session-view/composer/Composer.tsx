// The chat's prompt box (Claude Code desktop's Code tab) with the session's settings in the row
// under it: permission mode, model, effort and the context ring. You can always write. While
// Claude works, in a session the app runs Enter sends the message at once (it waits at the end of
// the chat until Claude reads it at its next step) and Ctrl+Enter queues it for later (sent when
// the turn is over); a terminal session queues it (the mock world too). ↑ in an empty box opens
// the newest queued message; Esc takes your last waiting message back, then stops; Esc Esc opens
// Rewind; Shift+Tab cycles the permission mode. The text you leave in the box stays with the session.
import { memo, useEffect, useRef, useState, type ReactNode } from "react"
import { REAL } from "@/backend/mode"
import type { ID, PermissionMode } from "@/lib/model"
import { getApp, useApp } from "@/store/app"
import { attachmentsText, takeImages } from "@/features/composer/images"
import { addSessionFolder, forkSession, removeSessionFolder, sendMessage, setSessionSettings, takeOverSession } from "@/store/actions"
import { runInTerminal, runSlashInTerminal } from "@/features/terminal/terminals"
import { MOD } from "@/components/common/bits"
import { capabilities } from "@/lib/status"
import { PromptBox, type PromptValue } from "@/features/composer/PromptBox"
import { GHOST, ModePicker, ModelExtras, ModelPicker } from "@/features/composer/Pickers"
import { ContextRing } from "@/features/composer/ContextRing"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { FolderPlus } from "lucide-react"
import { plural } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  cancelQueueEdit,
  editQueuedInBox,
  getUiValue,
  setUiValue,
  interruptAndSend,
  interruptSession,
  queueMessage,
  saveQueueEdit,
  setDraft,
  takeBackWaiting,
  useDraft,
  useQueued,
  useQueueEdit,
  useStopping,
  useWaiting,
} from "../sessionStore"

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"]
const EMPTY_FILES: string[] = []
/** Rewind prefills already put into a box (each remounts the composer once) */
const usedPrefill = new Map<ID, number>()

const withNames = (text: string, attachments: string[]) => `${text}${attachmentsText(attachments)}`

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

/** What you sent in a session, oldest first (repeats in a row once): ↑ / ↓ and Ctrl+R go through it. */
function sentPrompts(sessionId: ID) {
  const t = getApp().transcripts[sessionId]
  const list: string[] = []
  for (const id of t?.order ?? []) {
    const it = t?.items[id]
    if (it?.type === "user_message" && it.text.trim() && list.at(-1) !== it.text) list.push(it.text)
  }
  return list
}

const WRAP = "mx-auto w-full max-w-[calc(var(--chat-w)+64px)] px-8 @max-[560px]:px-4 pb-3"

/**
 * `dock`: the request card, shown in place of the box while `docked` (Claude Code desktop keeps the
 * queue above it and the row of settings under it).
 */
export const Composer = memo(function Composer({ sessionId, dock, docked }: { sessionId: ID; dock?: ReactNode; docked?: boolean }) {
  const control = useApp((s) => s.sessions[sessionId]?.control)
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const ready = useApp((s) => {
    const x = s.sessions[sessionId]
    return !!(x?.permissionMode && x.model && x.effort)
  })
  const repoId = useApp((s) => s.sessions[sessionId]?.repoId)
  const dirs = useApp((s) => s.sessions[sessionId]?.additionalDirs)
  const repos = useApp((s) => s.repos)
  const repoOrder = useApp((s) => s.repoOrder)
  const files = useApp((s) => (repoId ? (s.repoSpecs[repoId]?.files ?? EMPTY_FILES) : EMPTY_FILES))
  const draft = useDraft(sessionId)
  const queued = useQueued(sessionId)
  const waiting = useWaiting(sessionId).length > 0
  // Settings → Send with Ctrl+Enter: that key sends, nothing is queued for later by keyboard
  const modSends = useApp((s) => s.settings.sendKey === "mod-enter")
  const edit = useQueueEdit(sessionId)
  const stopping = useStopping(sessionId) > 0
  const lastEsc = useRef(0)
  // ↑ / ↓ through what you sent in this session (newest first), like Claude Code's prompt history
  const hist = useRef<{ list: string[]; at: number; saved: string } | null>(null)
  const onHistory = (dir: -1 | 1, current: string) => {
    if (!hist.current) {
      const list = sentPrompts(sessionId)
      if (!list.length) return null
      hist.current = { list, at: list.length, saved: current }
    }
    const h = hist.current
    const at = h.at + dir
    if (at < 0) return null
    if (at >= h.list.length) {
      hist.current = null
      return dir > 0 ? { text: h.saved, at, total: h.list.length } : null
    }
    h.at = at
    return { text: h.list[at], at, total: h.list.length }
  }
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

  // nothing to write here: only the card, if one waits
  const bare = dock ? <div className={WRAP}>{dock}</div> : null
  if (!control || !ready) return bare
  const caps = capabilities(control)
  // a session in a terminal never closes because you replied here: the reply is typed into that
  // terminal when it allows it (Konsole, tmux, kitty, WezTerm, the app's terminal), else it continues
  // in a copy in this app while the terminal keeps its own. Take over (the banner) moves it on purpose.
  const takeOver = REAL && control === "observed"
  // a past session: type and it goes on (it resumes in the app with your message, as Claude Code
  // desktop continues an old chat); the banner above also offers Resume and Fork
  const past = REAL && control === "history"
  if (!caps.send && !takeOver && !past) return bare
  const working = status === "working" || status === "starting"
  // a terminal session: what you pick here applies when it moves into the app (your next message)
  const locked = !caps.changeSettings && !takeOver && !past
  const headless = takeOver && injectWay === "headless"
  // the app runs it: a message sent while Claude works goes in at once, read at its next step
  const steers = REAL && control === "owned"
  // a queued message open in the box (if it went out meanwhile, saving sends the edit as a new one)
  const editing = !!edit

  const placeholder = editing
    ? "Edit the queued message"
    : takeOver && !headless
      ? injectWay
        ? `Reply: typed into its terminal (${injectWay})`
        : "Reply in the terminal, or turn on Settings → Sessions → Sync terminal sessions"
      : working
        ? steers
          ? modSends
            ? "Add a message — Claude reads it at its next step"
            : `Enter to send, ${MOD}+Enter to queue for later`
          : "Add a message — sent when Claude finishes this turn"
        : past
          ? "Continue this session: type / for commands"
          : "Type / for commands"
  const canStop = working && caps.interrupt
  const hint = editing
    ? "Enter saves · Esc cancels · empty removes it"
    : [
        working && steers ? (modSends ? "Claude reads it at its next step" : `Enter: read at Claude's next step · ${MOD}+Enter queues for later`) : working && !REAL ? `Enter queues · ${MOD}+Enter sends now` : "Enter sends · Shift+Enter new line",
        queued.length && !draft.text ? "↑ edits the queue" : "",
        canStop && !draft.text ? (waiting ? "Esc takes your last message back" : "Esc stops") : "",
      ]
        .filter(Boolean)
        .join(" · ")

  const submit = (text: string, attachments: string[], how: "queue" | "now") => {
    hist.current = null
    // the chat scrolls to its end to show what you sent
    setUiValue(`sent:${sessionId}`, Date.now())
    if (editing) {
      saveQueueEdit(sessionId, text, attachments)
      return false
    }
    if (/^!\s*\S/.test(text) && !attachments.length) return void runInTerminal(text.replace(/^!\s*/, "").trim())
    if (!attachments.length && runSlashInTerminal(text, sessionId)) return
    if (takeOver) return replyToTerminal(sessionId, text, attachments, injectWay)
    sendMessage(sessionId, text, how, attachments)
  }

  return (
    <div className={WRAP}>
      <PromptBox
        files={files}
        dock={dock}
        docked={docked}
        shell
        history={() => sentPrompts(sessionId).reverse()}
        value={draft}
        onValueChange={(fn: (v: PromptValue) => PromptValue) => setDraft(sessionId, fn)}
        editing={editing}
        placeholder={placeholder}
        placeholderShort={working && steers && !modSends && !editing && !takeOver ? `${MOD}+Enter to queue` : undefined}
        hint={hint}
        keysHint={`${!working ? "Enter sends, Shift+Enter adds a line." : steers ? `Enter sends a message Claude reads at its next step, ${MOD}+Enter queues it for later, Escape takes your last waiting message back or stops.` : REAL ? "Enter queues, Escape stops." : `Enter queues, ${MOD}+Enter sends now, Escape stops.`} Up arrow in an empty box edits the newest queued message. Slash for commands, at sign to mention a file, ! runs a command in the terminal.${locked ? "" : " Shift+Tab changes the permission mode."}`}
        sendHint={takeOver && !headless ? (injectWay ? `Send to ${injectWay} · Enter` : "Not synced") : working && !steers ? "Queue · Enter" : "Send · Enter"}
        busy={canStop}
        stopping={stopping}
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
            // a held key does not stop Claude after taking the message back
            if (e.repeat) return
            if (!takeBackWaiting(sessionId)) interruptSession(sessionId)
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
        onHistory={onHistory}
        onModSend={
          canStop && !takeOver
            ? (text, attachments) => {
                hist.current = null
                setUiValue(`sent:${sessionId}`, Date.now())
                if (steers) queueMessage(sessionId, text, attachments)
                else interruptAndSend(sessionId, text, attachments)
              }
            : undefined
        }
        modSendHint={steers ? "Queue for later" : "Interrupt and send"}
        onForkSend={
          caps.send && !takeOver
            ? (text) => {
                hist.current = null
                forkSession(sessionId, text)
              }
            : undefined
        }
        onShiftTab={
          locked
            ? undefined
            : () => {
                const cur = getApp().sessions[sessionId]?.permissionMode ?? "default"
                setSessionSettings(sessionId, { permissionMode: MODE_CYCLE[(MODE_CYCLE.indexOf(cur) + 1) % MODE_CYCLE.length] })
              }
        }
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

        footer={<ChinSettings sessionId={sessionId} locked={locked} />}
      />
    </div>
  )
})

const lockReason = "Runs in your terminal: change it there"

/**
 * Mode, model and effort, context: its own component, so typing in the box (which re-renders the
 * composer on every key) leaves these alone.
 */
const ChinSettings = memo(function ChinSettings({ sessionId, locked }: { sessionId: ID; locked: boolean }) {
  const mode = useApp((s) => s.sessions[sessionId]?.permissionMode)
  const model = useApp((s) => s.sessions[sessionId]?.model)
  const effort = useApp((s) => s.sessions[sessionId]?.effort)
  const fast = useApp((s) => s.sessions[sessionId]?.fastMode)
  const ultra = useApp((s) => s.sessions[sessionId]?.ultracode)
  const style = useApp((s) => s.sessions[sessionId]?.outputStyle)
  const dirs = useApp((s) => s.sessions[sessionId]?.additionalDirs)
  const repos = useApp((s) => s.repos)
  const repoOrder = useApp((s) => s.repoOrder)
  if (!mode || !model || !effort) return null
  return (
    <>
      {/* Claude Code desktop: the permission mode on the left under the box; model and effort, and context on the right */}
      <ModePicker value={mode} onChange={(permissionMode) => setSessionSettings(sessionId, { permissionMode })} disabled={locked} disabledReason={lockReason} />
      <FoldersNote ids={repoOrder.filter((id) => dirs?.includes(repos[id].rootPath))} names={repos} />
      <span className="flex-1" />
      <ModelPicker
        value={model}
        onChange={(m) => setSessionSettings(sessionId, { model: m })}
        effort={effort}
        onEffort={(e) => setSessionSettings(sessionId, { effort: e })}
        fast={!!fast}
        disabled={locked}
        disabledReason={lockReason}
        extra={<ModelExtras model={model} fast={!!fast} ultra={!!ultra} style={style} onChange={(patch) => setSessionSettings(sessionId, patch)} />}
      />
      <ContextRing sessionId={sessionId} canCompact={!locked} />
    </>
  )
})

/** The extra folders a running session sees (`--add-dir`), as a quiet count with their names on hover. */
function FoldersNote({ ids, names }: { ids: ID[]; names: Record<ID, { name: string }> }) {
  if (!ids.length) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn(GHOST, "px-2 text-cc-fg3 hover:bg-transparent hover:text-cc-fg3")}>
          <FolderPlus size={12} />
          {plural(ids.length, "folder")}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        Also sees {ids.map((id) => names[id].name).join(", ")}. Change it under + → Add folder.
      </TooltipContent>
    </Tooltip>
  )
}
