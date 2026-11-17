// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-composer.tsx (AgentComposer; Apache-2.0). Modified for session-dashboard.
// The prompt box, shaped like the Claude Code desktop app: a raised box with the attachments above
// the text and send / stop at the end of the line (under the text once it wraps); under the box the
// "chin": "+" (files or photos, add folder, mention a file, slash commands), Dictate, then `footer`
// (mode, model and effort, context). Shared by the chat and the New session screen; the
// chat keeps its text per session (`value` / `onValueChange`), and its key semantics (Esc stops,
// ↑ edits a queued message, Esc Esc rewinds, Shift+Tab cycles the mode) come in through callbacks.
import { addFiles as keepFiles, addImages, imageUrl } from "./images"
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { AtSign, Check, ChevronDown, CornerDownLeft, FileText, FolderPlus, GitFork, ListPlus, LoaderCircle, Mic, Paperclip, Plus, Slash, Square, X } from "lucide-react"
import { MOD } from "@/components/common/bits"
import { Kbd } from "@/components/ui/kbd"
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
import { GHOST, PANEL } from "./Pickers"
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
  /** the placeholder when the long one does not fit */
  placeholderShort?: string
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
  /** ↑ / ↓ through what you sent before (Claude Code's prompt history): the text to show and where
   * it is in the list (`at === total`: back to the box's own text), or null */
  onHistory?: (dir: -1 | 1, current: string) => { text: string; at: number; total: number } | null
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

const ICON = cn(GHOST, "w-7")
/** Event-time clock (handlers only). */
const clock = () => Date.now()

/** The width `text` takes in the textarea's font (does it still fit on the send button's line?). */
let canvas: CanvasRenderingContext2D | null = null
function textWidth(text: string, el: HTMLElement) {
  canvas ??= document.createElement("canvas").getContext("2d")
  if (!canvas) return 0
  canvas.font = getComputedStyle(el).font
  return canvas.measureText(text).width
}

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
  // browsing the prompt history (↑ / ↓) until the text is edited: where, for the hint line
  const [recall, setRecall] = useState<{ at: number; total: number } | null>(null)
  // the text wrapped: send / stop move under it
  const [wrapped, setWrapped] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const lastPress = useRef(0)
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
  // the short placeholder where the long one would not fit
  useEffect(() => {
    const el = boxRef.current
    if (!el || !props.placeholderShort) return
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 440))
    ro.observe(el)
    return () => ro.disconnect()
  }, [props.placeholderShort])

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
    clear()
  }
  const clear = () => {
    update(() => EMPTY)
    setTrigger(null)
    setRecall(null)
    setWrapped(false)
  }
  /** Does `value` still fit on one line beside send / stop (measured at event time)? */
  const measure = (value: string) => {
    const ta = taRef.current
    const row = ta?.closest<HTMLElement>("[data-editor-row]")
    if (!ta || !row) return
    const cluster = row.querySelector<HTMLElement>("[data-cluster]")?.offsetWidth || 32
    setWrapped(!!value && (value.includes("\n") || textWidth(value, ta) > row.clientWidth - cluster - 20))
  }
  /** Send and Stop ignore a press within 500 ms of the other, so a double click can't do both. */
  const guarded = (fn: () => void) => () => {
    const now = clock()
    if (now - lastPress.current < 500) return
    lastPress.current = now
    fn()
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
    clear()
  }
  const folderChips = folders?.chips !== false && folders ? folders.added : []
  const showSend = !showStop && (!!text.trim() || !!editing)
  const stacked = size === "lg" || wrapped
  const sendLabel = editing ? "Save" : sendHint.split(" · ")[0]

  return (
    <div className="group/composer @container/composer flex flex-col gap-2">
      <div
        ref={boxRef}
        data-prompt-box
        className={cn(
          "relative flex cursor-text flex-col gap-2 rounded-[14px] bg-cc-raised p-2 text-[var(--cc-fg)] shadow-[var(--cc-shadow-composer)] transition-[box-shadow,background-color,opacity] duration-200 focus-within:shadow-[var(--cc-shadow-composer-focus)]",
          dragging && "shadow-[0_0_0_2px_var(--cc-accent)]",
          disabled && "cursor-default opacity-40",
        )}
        // a click anywhere on the box puts the caret in the text
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget || disabled) return
          e.preventDefault()
          taRef.current?.focus()
        }}
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
          <div className="flex flex-wrap gap-2 px-1 pt-1">
            {folderChips.map((id) => (
              <Tile key={`dir:${id}`} icon={<FolderPlus size={12} />} label={repoNames[id]?.name ?? id} folder onRemove={folders?.onRemove ? () => folders.onRemove!(id) : undefined} />
            ))}
            {attachments.map((a, i) => (
              <Tile key={`${a}:${i}`} icon={<FileText size={12} />} thumb={imageUrl(a)} label={a} onRemove={() => removeAttachment(i)} />
            ))}
          </div>
        )}
        <div data-editor-row className={cn("flex min-w-0 gap-1", stacked ? "flex-col gap-2" : "items-end")}>
          <ComposerTextarea
            ref={taRef}
            value={text}
            rows={size === "lg" ? 3 : 1}
            autoFocus={autoFocus}
            disabled={disabled}
            highlights={highlights}
            // 7 lines and a control's height, at most 40 % of the window (then it scrolls)
            maxHeight={size === "lg" ? 320 : Math.min(175, Math.round(window.innerHeight * 0.4))}
            aria-label="Message Claude"
            aria-describedby={hintId}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-controls={menuOpen ? menuAria.listId : undefined}
            aria-activedescendant={menuOpen ? menuAria.optionId : undefined}
            placeholder={listening ? "Listening..." : narrow && props.placeholderShort ? props.placeholderShort : placeholder}
            className={cn("px-1.5 py-[3.5px] text-[15px] leading-[21px]", size === "lg" && "min-h-[70px]", listening && "placeholder:italic")}
            onChange={(e) => {
              setRecall(null)
              setText(e.target.value)
              syncTrigger(e.target.value, e.target.selectionStart)
              measure(e.target.value)
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
              const recalled = (r: { text: string; at: number; total: number }, caret: number) => {
                update((v) => ({ ...v, text: r.text }))
                setRecall(r.at < r.total ? { at: r.at, total: r.total } : null)
                setWrapped(false)
                requestAnimationFrame(() => taRef.current?.setSelectionRange(caret, caret))
              }
              if (e.key === "Enter" && mod && e.altKey && props.onForkSend) {
                // Ctrl+Alt+Enter: send in a forked session (Claude Code desktop)
                e.preventDefault()
                if (!editing) sendVia(props.onForkSend)
              } else if (e.key === "Enter" && mod && !modSends && busy && props.onModSend && !editing) {
                // Ctrl+Enter while Claude works: queued for later (Claude Code desktop)
                e.preventDefault()
                sendVia(props.onModSend)
              } else if (e.key === "Enter" && !e.shiftKey && (modSends ? mod : true)) {
                e.preventDefault()
                submit(mod ? "now" : "queue")
              } else if (e.key === "Escape") {
                if (props.onEscape?.(e)) e.preventDefault()
                else if (!text) props.onEscapeEmpty?.(e)
              } else if (mod && !e.shiftKey && !e.altKey && (e.key === "u" || (e.key === "d" && Speech))) {
                // Ctrl+U adds files or photos, Ctrl+D dictates (Claude Code desktop)
                e.preventDefault()
                if (e.key === "u") fileInput.current?.click()
                else toggleDictation()
              } else if (e.key === "ArrowUp" && !e.shiftKey && !mod && !e.altKey) {
                // the newest queued message first, then what you sent before (only from the first line)
                const ta = e.currentTarget
                const onFirstLine = !text.slice(0, ta.selectionStart).includes("\n")
                if (!text && props.onArrowUpEmpty?.()) e.preventDefault()
                else if (props.onHistory && onFirstLine && (!text || recall)) {
                  const prev = props.onHistory(-1, text)
                  if (prev) {
                    e.preventDefault()
                    recalled(prev, 0)
                  }
                }
              } else if (e.key === "ArrowDown" && recall && props.onHistory && !mod && !e.altKey) {
                const ta = e.currentTarget
                if (!text.slice(ta.selectionEnd).includes("\n")) {
                  const next = props.onHistory(1, text)
                  if (next) {
                    e.preventDefault()
                    recalled(next, next.text.length)
                  }
                }
              } else if (e.key === "Tab" && e.shiftKey && props.onShiftTab) {
                e.preventDefault()
                props.onShiftTab()
              }
            }}
          />
          {/* send / stop: at the end of the line, under the text once it wraps; pressing them never takes focus from the text */}
          <div data-cluster className={cn("flex shrink-0 items-center justify-end gap-1", stacked && "h-7")} onMouseDown={(e) => e.preventDefault()}>
            {recall && (
              <span className="tabular min-w-0 truncate px-1 text-[13px] text-cc-fg3">
                History {recall.at + 1}/{recall.total}
              </span>
            )}
            {moreSend && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="More send options" title="More send options" className={ICON}>
                    <ChevronDown size={14} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className={cn(PANEL, "w-72")}>
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
            {showStop && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={props.stopping ? "Stopping" : "Stop"}
                    aria-keyshortcuts="Escape"
                    aria-busy={props.stopping || undefined}
                    disabled={props.stopping}
                    onClick={guarded(() => onStop?.())}
                    className={ICON}
                  >
                    {props.stopping ? <LoaderCircle size={14} className="animate-spin-steps" /> : <Square size={12} fill="currentColor" strokeWidth={0} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {props.stopping ? "Stopping…" : <>Stop <Kbd>Esc</Kbd></>}
                </TooltipContent>
              </Tooltip>
            )}
            {showSend && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" aria-label={editing ? "Save queued message" : "Send"} aria-keyshortcuts="Enter" disabled={disabled} onClick={guarded(() => submit("queue"))} className={ICON}>
                    {editing ? <Check size={16} /> : <CornerDownLeft size={16} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="flex-col items-stretch gap-1">
                  <KeyLine label={sendLabel} keys={modSends ? `${MOD}⏎` : "⏎"} />
                  {!editing && later && !modSends && <KeyLine label={props.modSendHint ?? "Queue for later"} keys={`${MOD}⏎`} />}
                  {!editing && props.onForkSend && <KeyLine label="Send in a forked session" keys={`${MOD}+Alt+⏎`} />}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        <span id={hintId} className="sr-only">
          {keysHint}
        </span>
      </div>
      {/* the chin: + and Dictate, then the caller's settings (mode, model and effort, context) */}
      <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-1 px-2 text-[13px] text-cc-fg2 @max-[400px]/composer:text-xs">
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
                <button type="button" aria-label="Add" disabled={disabled} className={ICON}>
                  <Plus size={16} />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">Add files, folders, commands</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="top" align="start" sideOffset={6} className={cn(PANEL, "w-60")}>
            <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
              <Paperclip /> Add files or photos
              <DropdownMenuShortcut>{MOD}+U</DropdownMenuShortcut>
            </DropdownMenuItem>
            {folders && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderPlus /> Add folder
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={cn(PANEL, "w-52")}>
                  {folders.candidates.length ? (
                    folders.candidates.map((f) => {
                      const on = folders.added.includes(f.id)
                      return (
                        <DropdownMenuItem key={f.id} disabled={on && !folders.onRemove} onSelect={() => (on ? folders.onRemove?.(f.id) : folders.onAdd(f.id))}>
                          <span className="flex-1">{f.name}</span>
                          {on && <Check />}
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
        {Speech && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={listening ? "Stop dictation" : "Dictate"} aria-pressed={listening} disabled={disabled} onClick={toggleDictation} className={cn(ICON, listening && "bg-cc-ghost-sel text-[var(--cc-fg)]")}>
                <Mic size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {listening ? "Stop dictation" : "Dictate"} <Kbd>{MOD}+D</Kbd>
            </TooltipContent>
          </Tooltip>
        )}
        {footer}
      </div>
    </div>
  )
}

/** One line of the send button's tooltip: what, then its key. */
function KeyLine({ label, keys }: { label: string; keys: string }) {
  return (
    <span className="flex items-center justify-between gap-4">
      {label}
      <Kbd>{keys}</Kbd>
    </span>
  )
}

/**
 * An attachment above the text (10 px radius): a picture's thumbnail (bigger on hover), or a
 * file's name with its extension as a badge; × on hover or focus removes it.
 */
function Tile({ icon, thumb, label, folder, onRemove }: { icon: ReactNode; thumb?: string; label: string; folder?: boolean; onRemove?: () => void }) {
  const dot = folder || thumb ? -1 : label.lastIndexOf(".")
  const name = dot > 0 ? label.slice(0, dot) : label
  const ext = dot > 0 ? label.slice(dot + 1).toUpperCase() : ""
  const tile = (
    <span className="group/tile relative inline-flex h-14 min-w-0 shrink-0 overflow-hidden rounded-[10px] bg-cc-wash shadow-[inset_0_0_0_1px_var(--cc-wash-2)] focus-within:shadow-[0_0_0_1px_var(--cc-accent)]">
      {thumb ? (
        <img src={thumb} alt={label} className="size-14 object-cover" />
      ) : (
        <span className="flex w-32 min-w-0 flex-col justify-between px-2 py-1.5" title={label}>
          <span className="line-clamp-2 text-xs leading-[15px] break-all text-cc-fg2">{name}</span>
          <span className="flex items-center gap-1 text-cc-fg3">
            {icon}
            {ext && <span className="rounded-sm bg-cc-wash-2 px-1 text-[10px] leading-4 font-medium">{ext.slice(0, 6)}</span>}
          </span>
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 outline-none group-hover/tile:opacity-100 focus-visible:opacity-100"
        >
          <X size={12} />
        </button>
      )}
    </span>
  )
  if (!thumb) return tile
  return (
    <Tooltip>
      <TooltipTrigger asChild>{tile}</TooltipTrigger>
      <TooltipContent side="top" className="p-1">
        <img src={thumb} alt={label} className="max-h-60 max-w-60 rounded-md object-contain" />
      </TooltipContent>
    </Tooltip>
  )
}
