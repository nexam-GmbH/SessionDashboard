// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-composer.tsx (AgentComposer; Apache-2.0). Modified for session-dashboard.
// The prompt box, shaped like the Claude Code desktop app: one rounded box with the attachments
// above the text, "+" (files or photos, add folder, mention a file, slash commands) at the bottom
// left and send / stop at the bottom right; the settings row (mode, model, effort, context) comes
// in as `footer` and sits under the box. Shared by the chat and the New session screen; the
// chat keeps its text per session (`value` / `onValueChange`), and its key semantics (Esc stops,
// ↑ edits a queued message, Esc Esc rewinds, Shift+Tab cycles the mode) come in through callbacks.
import { addFiles as keepFiles, addImages, imageUrl } from "./images"
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { AtSign, Check, ChevronDown, CornerDownLeft, FileText, FolderPlus, GitFork, ListPlus, LoaderCircle, Mic, Paperclip, Plus, Slash, Square, X } from "lucide-react"
import { MOD } from "@/components/common/bits"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useApp } from "@/store/app"
import type { ID } from "@/lib/model"
import { cn } from "@/lib/utils"
import { caretCoordinates } from "./caret"
import { ComposerMenu, type MenuItem } from "./ComposerMenu"
import { ComposerTextarea } from "./ComposerTextarea"
import { fuzzy, highlightRanges, SLASH_COMMANDS, triggerAt, type Trigger } from "./tokens"

/** What the box holds: the text and the names of the attached files and pictures. */
export interface PromptValue {
  text: string
  attachments: string[]
}

export interface PromptBoxProps {
  /** files of the session's repo, for @-mentions */
  files: readonly string[]
  placeholder: string
  /** screen-reader description of the keys */
  keysHint: string
  /** the keys that matter right now, shown under the box while you type in it */
  hint?: string
  /** tooltip of the send button */
  sendHint: string
  initialText?: string
  /** the box's content kept by the caller (the chat keeps one per session); else the box keeps it */
  value?: PromptValue
  onValueChange?: (update: (v: PromptValue) => PromptValue) => void
  /** a turn is running: an empty box shows Stop instead of Send */
  busy?: boolean
  /** Stop was pressed and the turn has not ended yet */
  stopping?: boolean
  onStop?: () => void
  /** a queued message is open in the box: Enter saves it (an empty box removes it) */
  editing?: boolean
  /** Enter → "queue", Ctrl/⌘+Enter → "now". Return false to keep the text in the box. */
  onSubmit: (text: string, attachments: string[], how: "queue" | "now") => boolean | void
  /** Esc (after the menus had their turn): return true when handled */
  onEscape?: (e: React.KeyboardEvent) => boolean
  /** Esc in an empty box */
  onEscapeEmpty?: (e: React.KeyboardEvent) => void
  /** ↑ in an empty box: return true when it did something (opened the newest queued message) */
  onArrowUpEmpty?: () => boolean
  onShiftTab?: () => void
  /** ↑ / ↓ through what you sent before (Claude Code's prompt history): the text to show, or null */
  onHistory?: (dir: -1 | 1, current: string) => string | null
  /** while Claude works: Ctrl+Enter (queue for later), with its name for the send button's tooltip */
  onModSend?: (text: string, attachments: string[]) => void
  modSendHint?: string
  /** Ctrl+Alt+Enter: this message starts a copy of the session (a fork) */
  onForkSend?: (text: string, attachments: string[]) => void
  /** "+ → Add folder": the repos you can add (`--add-dir`) and the ones already added */
  folders?: { candidates: { id: ID; name: string }[]; added: ID[]; onAdd: (id: ID) => void; onRemove?: (id: ID) => void; chips?: boolean }
  /** above the box's text, inside it (a note about the message being read) */
  header?: ReactNode
  /** the row under the box (mode, model, effort, context; folder and worktree on New session) */
  footer?: ReactNode
  size?: "md" | "lg"
  autoFocus?: boolean
  disabled?: boolean
}

type SpeechCtor = new () => {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
const Speech: SpeechCtor | undefined =
  typeof window !== "undefined" ? ((window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: SpeechCtor }).webkitSpeechRecognition) : undefined

const ICON_BTN =
  "inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-foreground"
/** Send: the ↵ of Claude Code desktop's prompt box, filled once there is something to send. */
const SEND_BTN =
  "inline-flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-50"
/** Stop: a round button with a square, while Claude works. */
const STOP_BTN =
  "inline-flex size-8 items-center justify-center rounded-full bg-foreground text-background outline-none transition-colors hover:bg-foreground/85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-70"

const EMPTY: PromptValue = { text: "", attachments: [] }
const isImage = (f: File) => f.type.startsWith("image/")

export function PromptBox(props: PromptBoxProps) {
  const { files, placeholder, keysHint, sendHint, busy, onStop, onSubmit, folders, header, footer, size = "md", autoFocus, disabled, editing } = props
  const fileSet = useMemo(() => new Set(files), [files])
  const repoNames = useApp((s) => s.repos)
  const [own, setOwn] = useState<PromptValue>(() => (props.initialText ? { text: props.initialText, attachments: [] } : EMPTY))
  const { text, attachments } = props.value ?? own
  const update = (fn: (v: PromptValue) => PromptValue) => (props.onValueChange ? props.onValueChange(fn) : setOwn(fn))
  const setText = (t: string) => update((v) => ({ ...v, text: t }))
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState({ left: 0, bottom: 0 })
  const [listening, setListening] = useState(false)
  // browsing the prompt history (↑ / ↓) until the text is edited
  const browsing = useRef(false)
  // Settings → "Send with": Enter (Claude Code) or Ctrl+Enter (Enter adds a line)
  const modSends = useApp((s) => s.settings.sendKey === "mod-enter")
  const [dragging, setDragging] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const speech = useRef<InstanceType<SpeechCtor> | null>(null)
  const hintId = useId()
  const [menuAria, setMenuAria] = useState<{ listId?: string; optionId?: string }>({})
  const onMenuAria = useCallback((a: { listId?: string; optionId?: string }) => {
    setMenuAria((p) => (p.listId === a.listId && p.optionId === a.optionId ? p : a))
  }, [])
  useEffect(() => () => speech.current?.stop(), [])

  // the installed claude's commands and skills (desktop app); the built-in list in the mock world
  const realCommands = useApp((s) => s.caps?.commands)
  const commands = realCommands?.length ? realCommands : SLASH_COMMANDS
  const highlights = useMemo(() => highlightRanges(text, fileSet), [text, fileSet])
  const items: MenuItem[] = useMemo(() => {
    if (!trigger) return []
    if (trigger.kind === "slash") {
      return commands.map((c) => ({ c, score: fuzzy(trigger.query, c.name) }))
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
  }, [trigger, files, commands])
  const menuOpen = !!trigger && !disabled
  const effectiveActive = activeId && items.some((i) => i.id === activeId) ? activeId : (items[0]?.id ?? null)

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

  const insertAtEnd = (token: "/" | "@") => {
    if (token === "/" && text) return taRef.current?.focus()
    const next = text && !text.endsWith(" ") ? `${text} ${token}` : `${text}${token}`
    setText(next)
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(next.length, next.length)
      syncTrigger(next, next.length)
    })
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
    // an emptied queued message is removed by "saving" it
    if ((!value && !editing) || disabled) return
    if (onSubmit(value, attachments, how) === false) return
    update(() => EMPTY)
    setTrigger(null)
  }

  const toggleDictation = () => {
    if (!Speech) return
    if (listening) {
      speech.current?.stop()
      return
    }
    const rec = new Speech()
    rec.lang = navigator.language || "en-US"
    rec.interimResults = false
    rec.continuous = true
    rec.onresult = (e) => {
      let said = ""
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) said += e.results[i][0].transcript
      if (said) update((v) => ({ ...v, text: v.text && !v.text.endsWith(" ") ? `${v.text} ${said.trim()}` : `${v.text}${said.trim()}` }))
    }
    rec.onend = () => setListening(false)
    speech.current = rec
    rec.start()
    setListening(true)
  }

  const addNames = (names: string[]) => names.length && update((v) => ({ ...v, attachments: [...v.attachments, ...names] }))
  /** files go by name; pictures go with the message (and show in the chat) */
  const addFiles = (list: File[]) => {
    const docs = list.filter((f) => !isImage(f))
    if (docs.length) void keepFiles(docs).then(addNames)
    const imgs = list.filter(isImage)
    if (imgs.length) void addImages(imgs).then(addNames)
  }
  const removeAttachment = (i: number) => update((v) => ({ ...v, attachments: v.attachments.filter((_, j) => j !== i) }))
  const showStop = busy && !text.trim() && !editing && !!onStop
  // "More send options" (Claude Code desktop): queue for later while Claude works, send in a fork
  const later = busy ? props.onModSend : undefined
  const moreSend = !editing && !disabled && !!text.trim() && !!(later || props.onForkSend)
  const sendVia = (fn: (text: string, attachments: string[]) => void) => {
    const value = text.trim()
    if (!value || disabled) return
    fn(value, attachments)
    update(() => EMPTY)
    setTrigger(null)
  }
  const folderChips = folders?.chips !== false && folders ? folders.added : []

  return (
    <div className="group/composer @container/composer flex flex-col gap-1">
      <div
        ref={boxRef}
        data-prompt-box
        className={cn(
          "relative rounded-2xl bg-card ring-1 ring-foreground/10 transition-shadow focus-within:ring-foreground/20",
          dragging && "ring-2 ring-ring",
          disabled && "opacity-60",
        )}
        onDragOver={(e) => {
          e.preventDefault()
          if (!dragging && e.dataTransfer.types.includes("Files")) setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          addFiles([...e.dataTransfer.files])
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
        {header}
        {(attachments.length > 0 || folderChips.length > 0) && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {folderChips.map((id) => (
              <Chip key={`dir:${id}`} icon={<FolderPlus size={14} />} label={repoNames[id]?.name ?? id} onRemove={folders?.onRemove ? () => folders.onRemove!(id) : undefined} />
            ))}
            {attachments.map((a, i) => (
              <Chip key={`${a}:${i}`} icon={<FileText size={14} />} thumb={imageUrl(a)} label={a} onRemove={() => removeAttachment(i)} />
            ))}
          </div>
        )}
        <ComposerTextarea
          ref={taRef}
          value={text}
          rows={size === "lg" ? 3 : 1}
          autoFocus={autoFocus}
          disabled={disabled}
          highlights={highlights}
          maxHeight={size === "lg" ? 320 : 240}
          aria-label="Message Claude"
          aria-describedby={hintId}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={menuOpen ? menuAria.listId : undefined}
          aria-activedescendant={menuOpen ? menuAria.optionId : undefined}
          placeholder={placeholder}
          className={cn("px-4 pt-3 pb-1 text-sm leading-[22px]", size === "lg" && "min-h-[88px]")}
          onChange={(e) => {
            browsing.current = false
            setText(e.target.value)
            syncTrigger(e.target.value, e.target.selectionStart)
          }}
          onSelect={(e) => {
            const ta = e.currentTarget
            if (trigger && (ta.selectionStart < trigger.start || ta.selectionStart > trigger.end + 1)) setTrigger(null)
          }}
          onBlur={() => setTrigger(null)}
          onPaste={(e) => {
            const imgs = [...e.clipboardData.files].filter(isImage)
            if (imgs.length) {
              e.preventDefault()
              addFiles(imgs)
            }
          }}
          onKeyDown={(e) => {
            // a CJK input method is composing: Enter confirms the word, it never sends (keyCode 229: WebKit's composing key)
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
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
                // a command typed in full: Enter runs it, like in Claude Code (not "complete, then Enter again")
                const typed = item?.type === "command" && e.key === "Enter" && text.trim() === item.label
                if (item && !typed) {
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
            const mod = e.metaKey || e.ctrlKey
            if (e.key === "Enter" && mod && e.altKey && props.onForkSend) {
              // Ctrl+Alt+Enter: send in a forked session (Claude Code desktop)
              e.preventDefault()
              const value = text.trim()
              if (value && !editing && !disabled) {
                props.onForkSend(value, attachments)
                update(() => EMPTY)
              }
            } else if (e.key === "Enter" && mod && !modSends && busy && props.onModSend && !editing) {
              // Ctrl+Enter while Claude works: queued for later (Claude Code desktop)
              e.preventDefault()
              const value = text.trim()
              if (value && !disabled) {
                props.onModSend(value, attachments)
                update(() => EMPTY)
                setTrigger(null)
              }
            } else if (e.key === "Enter" && !e.shiftKey && (modSends ? mod : true)) {
              e.preventDefault()
              submit(mod ? "now" : "queue")
            } else if (e.key === "Escape") {
              if (props.onEscape?.(e)) e.preventDefault()
              else if (!text) props.onEscapeEmpty?.(e)
            } else if (e.key === "ArrowUp" && !e.shiftKey && !mod && !e.altKey) {
              // the newest queued message first, then what you sent before (only from the first line)
              const ta = e.currentTarget
              const onFirstLine = !text.slice(0, ta.selectionStart).includes("\n")
              if (!text && props.onArrowUpEmpty?.()) e.preventDefault()
              else if (props.onHistory && onFirstLine && (!text || browsing.current)) {
                const prev = props.onHistory(-1, text)
                if (prev !== null) {
                  e.preventDefault()
                  browsing.current = true
                  update((v) => ({ ...v, text: prev }))
                  requestAnimationFrame(() => taRef.current?.setSelectionRange(0, 0))
                }
              }
            } else if (e.key === "ArrowDown" && browsing.current && props.onHistory && !mod && !e.altKey) {
              const ta = e.currentTarget
              if (!text.slice(ta.selectionEnd).includes("\n")) {
                const next = props.onHistory(1, text)
                if (next !== null) {
                  e.preventDefault()
                  update((v) => ({ ...v, text: next }))
                  if (!next) browsing.current = false
                  requestAnimationFrame(() => taRef.current?.setSelectionRange(next.length, next.length))
                }
              }
            } else if (e.key === "Tab" && e.shiftKey && props.onShiftTab) {
              e.preventDefault()
              props.onShiftTab()
            }
          }}
        />
        <span id={hintId} className="sr-only">
          {keysHint}
        </span>
        <div className="flex items-center gap-1 px-2 pt-1 pb-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])])
              e.target.value = ""
            }}
          />
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Add" disabled={disabled} className={ICON_BTN}>
                    <Plus size={16} />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">Add files, photos, commands</TooltipContent>
            </Tooltip>
            <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-56">
              <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                <Paperclip /> Add files or photos
              </DropdownMenuItem>
              {folders && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <FolderPlus /> Add folder
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-52">
                    {folders.candidates.length ? (
                      folders.candidates.map((f) => {
                        const on = folders.added.includes(f.id)
                        return (
                          <DropdownMenuItem key={f.id} disabled={on && !folders.onRemove} onSelect={() => (on ? folders.onRemove?.(f.id) : folders.onAdd(f.id))}>
                            <span className="flex-1">{f.name}</span>
                            {on && <Check className="text-foreground" />}
                          </DropdownMenuItem>
                        )
                      })
                    ) : (
                      <DropdownMenuItem disabled>No other projects</DropdownMenuItem>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setTimeout(() => insertAtEnd("@"), 0)}>
                <AtSign /> Mention a file
                <DropdownMenuShortcut>@</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTimeout(() => insertAtEnd("/"), 0)}>
                <Slash /> Slash commands
                <DropdownMenuShortcut>/</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="flex-1" />
          {Speech && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label={listening ? "Stop dictation" : "Dictate"} aria-pressed={listening} disabled={disabled} onClick={toggleDictation} className={cn(ICON_BTN, listening && "text-st-error-fg")}>
                  <Mic size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{listening ? "Stop dictation" : "Dictate"}</TooltipContent>
            </Tooltip>
          )}
          {moreSend && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label="More send options" title="More send options" className={cn(ICON_BTN, "size-7 rounded-full")}>
                  <ChevronDown size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-80">
                {later && (
                  <DropdownMenuItem onSelect={() => sendVia(later)}>
                    <ListPlus /> {props.modSendHint ?? "Queue for later"}
                    {!modSends && <DropdownMenuShortcut>{MOD}+Enter</DropdownMenuShortcut>}
                  </DropdownMenuItem>
                )}
                {props.onForkSend && (
                  <DropdownMenuItem onSelect={() => sendVia(props.onForkSend!)}>
                    <GitFork /> Send in a forked session
                    <DropdownMenuShortcut>{MOD}+Alt+Enter</DropdownMenuShortcut>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {showStop ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label={props.stopping ? "Stopping" : "Stop"} aria-busy={props.stopping || undefined} disabled={props.stopping} onClick={onStop} className={STOP_BTN}>
                  {props.stopping ? <LoaderCircle size={14} className="animate-spin-steps" /> : <Square size={10} fill="currentColor" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{props.stopping ? "Stopping…" : "Stop · Esc"}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={editing ? "Save queued message" : "Send"}
                  disabled={(!text.trim() && !editing) || disabled}
                  onClick={() => submit("queue")}
                  className={cn(SEND_BTN, text.trim() && "bg-foreground text-background hover:bg-foreground/85 hover:text-background")}
                >
                  {editing ? <Check size={16} strokeWidth={2.4} /> : <CornerDownLeft size={16} strokeWidth={2.2} />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="flex flex-col gap-0.5">
                {editing ? (
                  "Save · Enter"
                ) : busy && props.onModSend && !modSends ? (
                  <>
                    <span>{sendHint}</span>
                    <span className="text-background/70">
                      {props.modSendHint ?? "Queue for later"} · {MOD}+Enter
                    </span>
                    {props.onForkSend && <span className="text-background/70">Send in a forked session · {MOD}+Alt+Enter</span>}
                  </>
                ) : (
                  <>
                    <span>{sendHint}</span>
                    {props.onForkSend && (
                      <span className="flex items-center gap-1 text-background/70">
                        <GitFork size={11} /> Send in a forked session · {MOD}+Alt+Enter
                      </span>
                    )}
                  </>
                )}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      {footer && <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-1">{footer}</div>}
    </div>
  )
}

/** An attachment above the text: a picture's thumbnail (bigger on hover) or a file's name. */
function Chip({ icon, thumb, label, onRemove }: { icon: ReactNode; thumb?: string; label: string; onRemove?: () => void }) {
  const chip = (
    <span className="inline-flex h-8 max-w-64 min-w-0 items-center gap-2 rounded-lg bg-muted pr-1 pl-1 text-xs text-muted-foreground ring-1 ring-foreground/10">
      {thumb ? (
        <img src={thumb} alt="" className="size-6 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/70">{icon}</span>
      )}
      <span className="min-w-0 truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onRemove}
        >
          <X size={14} />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  )
  if (!thumb) return chip
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" className="p-1">
        <img src={thumb} alt={label} className="max-h-60 max-w-60 rounded-md object-contain" />
      </TooltipContent>
    </Tooltip>
  )
}
