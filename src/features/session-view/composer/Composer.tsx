// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-composer.tsx (AgentComposer, AgentComposerSettings; Apache-2.0). Modified for session-dashboard.
// Semantics mirror the Claude Code CLI (RESEARCH §1.6): Enter queues while Claude is
// working, Cmd/Ctrl+Enter sends now, Up edits the last queued message, Esc in an
// empty composer interrupts, Shift+Tab cycles the permission mode. Calm rules (§2.5):
// short placeholder, attach / commands / mention as small icons, key hints in the send
// button's tooltip; the permission mode lives in the header's settings menu.
import { memo, useCallback, useId, useMemo, useRef, useState } from "react"
import { ArrowUp, AtSign, Paperclip, Slash, Square, X } from "lucide-react"
import type { ID, PermissionMode } from "@/lib/model"
import { useApp } from "@/store/app"
import { sendMessage, setSessionSettings } from "@/store/actions"
import { MOD } from "@/components/common/bits"
import { capabilities } from "@/lib/status"
import { interruptSession, takeLastQueued } from "../sessionStore"
import { Hint } from "../header/SessionHeader"
import { caretCoordinates } from "./caret"
import { ComposerMenu, type MenuItem } from "./ComposerMenu"
import { ComposerTextarea } from "./ComposerTextarea"
import { fuzzy, highlightRanges, SLASH_COMMANDS, triggerAt, type Trigger } from "./tokens"

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan"]
const EMPTY_FILES: string[] = []
const TEXT_CLASS = "px-3 pt-2 pb-0.5 text-[13px] leading-[20px]"

export const Composer = memo(function Composer({ sessionId }: { sessionId: ID }) {
  const control = useApp((s) => s.sessions[sessionId]?.control)
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const mode = useApp((s) => s.sessions[sessionId]?.permissionMode)
  const files = useApp((s) => {
    const rid = s.sessions[sessionId]?.repoId
    return rid ? (s.repoSpecs[rid]?.files ?? EMPTY_FILES) : EMPTY_FILES
  })
  const fileSet = useMemo(() => new Set(files), [files])
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<string[]>([])
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState({ left: 0, bottom: 0 })
  const taRef = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const [menuAria, setMenuAria] = useState<{ listId?: string; optionId?: string }>({})
  const onMenuAria = useCallback((a: { listId?: string; optionId?: string }) => {
    setMenuAria((p) => (p.listId === a.listId && p.optionId === a.optionId ? p : a))
  }, [])

  const highlights = useMemo(() => highlightRanges(text, fileSet), [text, fileSet])
  const items: MenuItem[] = useMemo(() => {
    if (!trigger) return []
    if (trigger.kind === "slash") {
      return SLASH_COMMANDS.map((c) => ({ c, score: fuzzy(trigger.query, c.name) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map(({ c }) => ({ id: `/${c.name}`, type: "command" as const, label: `/${c.name}`, description: c.description }))
    }
    return files
      .map((f) => ({ f, score: fuzzy(trigger.query, f) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map(({ f }) => {
        const slash = f.lastIndexOf("/")
        return { id: `@${f}`, type: "file" as const, path: f, label: f.slice(slash + 1), description: slash > 0 ? f.slice(0, slash) : "" }
      })
  }, [trigger, files])

  if (!control) return null
  const caps = capabilities(control)
  const working = status === "working" || status === "starting"
  const menuOpen = !!trigger && caps.send

  const syncTrigger = (value: string, caret: number) => {
    const t = triggerAt(value, caret)
    setTrigger(t)
    if (!t) return
    const ta = taRef.current
    const box = boxRef.current
    if (!ta || !box) return
    const c = caretCoordinates(ta, t.start)
    const taRect = ta.getBoundingClientRect()
    const boxRect = box.getBoundingClientRect()
    setAnchor({ left: taRect.left - boxRect.left + c.left, bottom: boxRect.bottom - (taRect.top + c.top) })
    setActiveId(null)
  }

  const applyItem = (item: MenuItem) => {
    if (!trigger) return
    const insert = item.type === "command" ? `${item.label} ` : `@${item.path} `
    const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end)
    const caret = trigger.start + insert.length
    setText(next)
    setTrigger(null)
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(caret, caret)
    })
  }

  const submit = (how: "queue" | "now") => {
    const value = text.trim()
    if (!value || !caps.send) return
    sendMessage(sessionId, attachments.length ? `${value}\n\n[attached: ${attachments.join(", ")}]` : value, how)
    setText("")
    setAttachments([])
    setTrigger(null)
  }

  const effectiveActive = activeId && items.some((i) => i.id === activeId) ? activeId : (items[0]?.id ?? null)

  // history: the banner above offers Resume; nothing to type into until then
  if (!caps.send) return null

  return (
    <div className="mx-auto w-full max-w-[860px] px-5 pb-3">
      <div
        ref={boxRef}
        className="relative rounded-[4px] border border-line bg-elevated transition-colors focus-within:border-brand/55"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const names = [...e.dataTransfer.files].map((f) => f.name)
          if (names.length) setAttachments((a) => [...a, ...names])
        }}
      >
        {menuOpen && (
          <ComposerMenu
            items={items}
            activeId={effectiveActive}
            kind={trigger.kind}
            left={anchor.left}
            bottom={anchor.bottom}
            onHighlight={setActiveId}
            onSelect={applyItem}
            onAria={onMenuAria}
          />
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1 px-2.5 pt-2">
            {attachments.map((a, i) => (
              <span key={`${a}:${i}`} className="inline-flex h-5 items-center gap-1 rounded-[3px] border border-line-subtle bg-chrome pr-0.5 pl-1.5 font-mono text-[11px] text-fg-muted">
                <Paperclip size={10} />
                {a}
                <button type="button" aria-label={`Remove ${a}`} className="inline-flex size-4 items-center justify-center rounded-[2px] outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-ring" onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))}>
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <ComposerTextarea
          ref={taRef}
          value={text}
          rows={1}
          highlights={highlights}
          aria-label="Message Claude"
          aria-describedby={hintId}
          // the / and @ menus: a listbox driven from the textarea (focus never leaves it)
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={menuOpen ? menuAria.listId : undefined}
          aria-activedescendant={menuOpen ? menuAria.optionId : undefined}
          placeholder={working ? "Queue a message" : "Message Claude"}
          className={TEXT_CLASS}
          onChange={(e) => {
            setText(e.target.value)
            syncTrigger(e.target.value, e.target.selectionStart)
          }}
          onSelect={(e) => {
            const ta = e.currentTarget
            if (trigger && (ta.selectionStart < trigger.start || ta.selectionStart > trigger.end + 1)) setTrigger(null)
          }}
          onBlur={() => setTrigger(null)}
          onPaste={(e) => {
            const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"))
            if (imgs.length) {
              e.preventDefault()
              setAttachments((a) => [...a, ...imgs.map((f, i) => f.name || `pasted-image-${a.length + i + 1}.png`)])
            }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (menuOpen) {
              const idx = items.findIndex((i) => i.id === effectiveActive)
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                if (!items.length) return
                const next = (idx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
                setActiveId(items[next].id)
                return
              }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                const item = items[Math.max(0, idx)]
                if (item) {
                  e.preventDefault()
                  applyItem(item)
                  return
                }
              }
              if (e.key === "Escape") {
                e.preventDefault()
                setTrigger(null)
                return
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit(e.metaKey || e.ctrlKey ? "now" : "queue")
            } else if (e.key === "Escape" && !text) {
              if (working && caps.interrupt) {
                e.preventDefault()
                interruptSession(sessionId)
              }
            } else if (e.key === "ArrowUp" && !text) {
              const prev = takeLastQueued(sessionId)
              if (prev !== undefined) {
                e.preventDefault()
                setText(prev)
              }
            } else if (e.key === "Tab" && e.shiftKey && caps.changeSettings && mode) {
              e.preventDefault()
              const i = MODE_CYCLE.indexOf(mode)
              setSessionSettings(sessionId, { permissionMode: MODE_CYCLE[(i + 1) % MODE_CYCLE.length] })
            }
          }}
        />
        <span id={hintId} className="sr-only">
          {working ? `Enter queues, ${MOD}+Enter sends now, Escape interrupts.` : "Enter sends, Shift+Enter adds a line."} Slash for commands, at sign
          to mention a file.{caps.changeSettings ? " Shift+Tab changes the permission mode; Tab moves on." : ""}
        </span>
        <div className="flex h-8 items-center gap-0.5 px-1.5 pb-0.5">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const names = [...(e.target.files ?? [])].map((f) => f.name)
              if (names.length) setAttachments((a) => [...a, ...names])
              e.target.value = ""
            }}
          />
          <Hint label="Attach · or paste / drop" side="top">
            <button type="button" aria-label="Attach" onClick={() => fileInput.current?.click()} className="inline-flex size-6 items-center justify-center rounded-[3px] text-fg-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-ring">
              <Paperclip size={13} />
            </button>
          </Hint>
          <Hint label="Commands" side="top">
            <button
              type="button"
              aria-label="Insert command"
              onClick={() => {
                if (text) return taRef.current?.focus()
                setText("/")
                requestAnimationFrame(() => {
                  taRef.current?.focus()
                  taRef.current?.setSelectionRange(1, 1)
                  syncTrigger("/", 1)
                })
              }}
              className="inline-flex size-6 items-center justify-center rounded-[3px] text-fg-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Slash size={13} />
            </button>
          </Hint>
          <Hint label="Mention a file" side="top">
            <button
              type="button"
              aria-label="Mention file"
              onClick={() => {
                const next = text && !text.endsWith(" ") ? `${text} @` : `${text}@`
                setText(next)
                requestAnimationFrame(() => {
                  taRef.current?.focus()
                  taRef.current?.setSelectionRange(next.length, next.length)
                  syncTrigger(next, next.length)
                })
              }}
              className="inline-flex size-6 items-center justify-center rounded-[3px] text-fg-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-ring"
            >
              <AtSign size={13} />
            </button>
          </Hint>
          <span className="flex-1" />
          {working && !text && caps.interrupt ? (
            <Hint label="Interrupt · Esc" side="top">
              <button type="button" aria-label="Interrupt" onClick={() => interruptSession(sessionId)} className="inline-flex size-6 items-center justify-center rounded-[4px] bg-fg text-canvas outline-none hover:bg-st-error hover:text-white focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-elevated">
                <Square size={10} fill="currentColor" />
              </button>
            </Hint>
          ) : (
            <Hint
              label={working ? `Enter queues · ${MOD}+Enter sends now${control === "observed" ? " · goes to your terminal" : ""}` : `Enter sends · Shift+Enter newline${control === "observed" ? " · goes to your terminal" : ""}`}
              side="top"
            >
              <button
                type="button"
                aria-label="Send"
                disabled={!text.trim()}
                onClick={() => submit("queue")}
                className="inline-flex size-6 items-center justify-center rounded-[4px] bg-brand text-white outline-none hover:bg-[#0588f0] focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-elevated disabled:bg-hover disabled:text-fg-faint"
              >
                <ArrowUp size={13} strokeWidth={2.5} />
              </button>
            </Hint>
          )}
        </div>
      </div>
    </div>
  )
})

