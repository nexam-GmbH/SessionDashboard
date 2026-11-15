// Adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-composer.tsx (AgentComposer; Apache-2.0). Modified for session-dashboard.
// The prompt box, shaped like the Claude Code desktop app (RESEARCH §11): an auto-growing box with
// "+" (files or photos, add folder, mention a file, slash commands) at the bottom left, dictation
// and send / stop at the bottom right, and the settings row (mode, model, effort, context) passed
// in as `footer` and drawn under the box. Shared by the chat and the New session screen; the
// session-only key semantics (queue vs. send now, Esc interrupt, ↑ edit queued, Esc Esc rewind,
// Shift+Tab mode) come in through callbacks.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowUp, AtSign, Check, FolderPlus, Mic, Paperclip, Plus, Slash, Square, X } from "lucide-react"
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

export interface PromptBoxProps {
  /** files of the session's repo, for @-mentions */
  files: readonly string[]
  placeholder: string
  /** screen-reader description of the keys */
  keysHint: string
  /** tooltip of the send button */
  sendHint: string
  initialText?: string
  /** a turn is running: an empty box shows Stop instead of Send */
  busy?: boolean
  onStop?: () => void
  /** Enter → "queue", Ctrl/⌘+Enter → "now". Return false to keep the text in the box. */
  onSubmit: (text: string, attachments: string[], how: "queue" | "now") => boolean | void
  /** Esc in an empty box (after the menus had their turn) */
  onEscapeEmpty?: (e: React.KeyboardEvent) => void
  /** ↑ in an empty box: text to edit (the last queued message) */
  onArrowUpEmpty?: () => string | undefined
  onShiftTab?: () => void
  /** "+ → Add folder": the repos you can add (`--add-dir`) and the ones already added */
  folders?: { candidates: { id: ID; name: string }[]; added: ID[]; onAdd: (id: ID) => void; onRemove?: (id: ID) => void; chips?: boolean }
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
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground"

export function PromptBox(props: PromptBoxProps) {
  const { files, placeholder, keysHint, sendHint, busy, onStop, onSubmit, folders, footer, size = "md", autoFocus, disabled } = props
  const fileSet = useMemo(() => new Set(files), [files])
  const repoNames = useApp((s) => s.repos)
  const [text, setText] = useState(props.initialText ?? "")
  const [attachments, setAttachments] = useState<string[]>([])
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState({ left: 0, bottom: 0 })
  const [listening, setListening] = useState(false)
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
    const next = token === "/" && text ? text : text && !text.endsWith(" ") ? `${text} ${token}` : `${text}${token}`
    if (token === "/" && text) return taRef.current?.focus()
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
    if (!value || disabled) return
    if (onSubmit(value, attachments, how) === false) return
    setText("")
    setAttachments([])
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
      if (said) setText((t) => (t && !t.endsWith(" ") ? `${t} ${said.trim()}` : `${t}${said.trim()}`))
    }
    rec.onend = () => setListening(false)
    speech.current = rec
    rec.start()
    setListening(true)
  }

  const addFiles = (names: string[]) => names.length && setAttachments((a) => [...a, ...names])
  const showStop = busy && !text.trim() && !!onStop

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={boxRef}
        data-prompt-box
        className={cn(
          "relative rounded-lg border border-border bg-muted transition-colors focus-within:border-input",
          disabled && "opacity-60",
        )}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          addFiles([...e.dataTransfer.files].map((f) => f.name))
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
        {(attachments.length > 0 || (folders?.chips !== false && folders && folders.added.length > 0)) && (
          <div className="flex flex-wrap gap-1 px-3 pt-2.5">
            {folders?.chips !== false && folders?.added.map((id) => (
              <Chip key={`dir:${id}`} icon={<FolderPlus size={11} />} label={repoNames[id]?.name ?? id} onRemove={folders.onRemove ? () => folders.onRemove!(id) : undefined} />
            ))}
            {attachments.map((a, i) => (
              <Chip key={`${a}:${i}`} icon={<Paperclip size={11} />} label={a} mono onRemove={() => setAttachments((x) => x.filter((_, j) => j !== i))} />
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
          className={cn("px-3.5 pt-3 pb-1", size === "lg" ? "min-h-[84px] text-sm leading-[22px]" : "text-sm leading-[21px]")}
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
              addFiles(imgs.map((f, i) => f.name || `pasted-image-${attachments.length + i + 1}.png`))
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
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit(e.metaKey || e.ctrlKey ? "now" : "queue")
            } else if (e.key === "Escape" && !text) {
              props.onEscapeEmpty?.(e)
            } else if (e.key === "ArrowUp" && !text && props.onArrowUpEmpty) {
              const prev = props.onArrowUpEmpty()
              if (prev !== undefined) {
                e.preventDefault()
                setText(prev)
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
        <div className="flex h-10 items-center gap-0.5 px-1.5 pb-1">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])].map((f) => f.name))
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
              <TooltipContent side="top">Add files, folders, commands</TooltipContent>
            </Tooltip>
            <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-60">
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
                  <Mic size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{listening ? "Stop dictation" : "Dictate"}</TooltipContent>
            </Tooltip>
          )}
          {showStop ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Stop"
                  onClick={onStop}
                  className="ml-0.5 inline-flex size-7 items-center justify-center rounded-md bg-foreground text-background outline-none hover:bg-foreground/88 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-muted"
                >
                  <Square size={10} fill="currentColor" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Stop · Esc</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Send"
                  disabled={!text.trim() || disabled}
                  onClick={() => submit("queue")}
                  className="ml-0.5 inline-flex size-7 items-center justify-center rounded-md bg-foreground text-background outline-none hover:bg-foreground/88 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-muted disabled:bg-accent disabled:text-muted-foreground/70"
                >
                  <ArrowUp size={15} strokeWidth={2.4} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{sendHint}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      {footer && <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-0.5">{footer}</div>}
    </div>
  )
}

function Chip({ icon, label, mono, onRemove }: { icon: ReactNode; label: string; mono?: boolean; onRemove?: () => void }) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1 rounded-md border border-border bg-card pr-0.5 pl-2 text-xs text-muted-foreground", mono && "font-mono")}>
      {icon}
      {label}
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          className="inline-flex size-5 items-center justify-center rounded-md outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onRemove}
        >
          <X size={11} />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  )
}
