// The terminal dock at the bottom of the panel (Ctrl+`, like VS Code and Zed). It shows the shell of
// what is on screen (the session's folder) and follows you to the next session; shells keep running
// while it is closed. Drag its top edge to resize.
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Check, ChevronDown, SquareTerminal, X, Trash2 } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { useApp } from "@/store/app"
import { homePath } from "@/lib/format"
import { closeTerminal, currentPlace, currentShellId, enableGpu, entryOf, hideTerminal, keyOf, loadShells, loadXterm, setTerminalHeight, show, switchShell, useTerminal, type ShellChoice } from "./terminals"

// xterm is preloaded while the app is idle, so the first Ctrl+` opens at once
if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 2000))
  idle(() => void loadXterm())
}

export function TerminalDock() {
  const open = useTerminal((s) => s.open)
  if (!open) return null
  return <Dock />
}

function Dock() {
  const key = useTerminal((s) => s.key)
  const saved = useApp((s) => s.settings.terminalHeight)
  const [drag, setDrag] = useState<number | null>(null)
  const height = drag ?? saved
  const route = useApp((s) => s.route)
  // a string, so the selector is stable between renders
  const want = useApp(() => keyOf(currentPlace()))
  const box = useRef<HTMLDivElement>(null)

  // follow the screen: another session's folder gets its own shell
  useEffect(() => {
    if (want !== useTerminal.getState().key) void show(currentPlace())
  }, [want, route])

  // attach the folder's terminal and keep it fitted to the dock
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !key) return
    let cancelled = false
    let ro: ResizeObserver | undefined
    const attach = () => {
      const e = entryOf(key)
      if (!e) return false
      if (e.host.parentElement !== el) {
        el.replaceChildren(e.host)
        if (!e.term.element) e.term.open(e.host)
      }
      const fit = () => {
        try {
          e.fit.fit()
        } catch {
          /* not laid out yet */
        }
      }
      fit()
      // GPU drawing, then the shell, now that it knows its real size (no 80×24 start and redraw)
      enableGpu(e)
      e.start()
      // a resize settles before the terminal reflows: each column change rewraps the whole
      // scrollback and makes Claude Code redraw its screen (VS Code debounces the same way)
      let timer = 0
      ro = new ResizeObserver(() => {
        window.clearTimeout(timer)
        timer = window.setTimeout(fit, 90)
      })
      ro.observe(el)
      // the terminal takes the keyboard when you open it, not when it follows you to another
      // session (you were typing in that session's prompt box)
      const a = document.activeElement as HTMLElement | null
      const typingElsewhere = !!a && a !== document.body && !el.contains(a) && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")
      if (!typingElsewhere) e.term.focus()
      return true
    }
    if (!attach()) {
      // still starting: attach as soon as it exists
      const t = setInterval(() => {
        if (cancelled || attach()) clearInterval(t)
      }, 16)
      return () => {
        cancelled = true
        clearInterval(t)
        ro?.disconnect()
      }
    }
    return () => ro?.disconnect()
  }, [key])

  const place = entryOf(key)?.place ?? currentPlace()
  return (
    <section aria-label="Terminal" className="flex shrink-0 flex-col border-t bg-background" style={{ height }}>
      <Resizer height={height} onDrag={setDrag} />
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground">
        <SquareTerminal className="size-3.5" />
        <span className="truncate font-mono" title={place.cwd}>
          {place.host ? `${place.host}:` : ""}
          {homePath(place.cwd)}
        </span>
        <span className="ml-auto" />
        {!place.host && key && <ShellPicker termKey={key} />}
        <Button size="icon-xs" variant="ghost" aria-label="Kill this shell" title="Kill this shell" onClick={() => key && void closeTerminal(key)}>
          <Trash2 />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Hide the terminal" title="Hide · Ctrl+`" onClick={hideTerminal}>
          <X />
        </Button>
      </div>
      <div ref={box} data-terminal-box className="min-h-0 flex-1 pb-1 pl-3" />
    </section>
  )
}

/** Drag the top edge to resize (min 120 px, max 80% of the window); saved when you let go. */
function Resizer({ height, onDrag }: { height: number; onDrag: (h: number | null) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the terminal"
      className="-mt-1 h-2 shrink-0 cursor-ns-resize"
      onPointerDown={(e) => {
        e.preventDefault()
        const startY = e.clientY
        const target = e.currentTarget
        target.setPointerCapture(e.pointerId)
        let last = height
        let frame = 0
        // at most one new height a frame (each one lays the whole window out again)
        const move = (ev: PointerEvent) => {
          last = Math.min(window.innerHeight * 0.8, Math.max(120, height + startY - ev.clientY))
          frame ||= requestAnimationFrame(() => {
            frame = 0
            onDrag(last)
          })
        }
        const up = () => {
          if (frame) cancelAnimationFrame(frame)
          target.removeEventListener("pointermove", move)
          target.removeEventListener("pointerup", up)
          setTerminalHeight(last)
          onDrag(null)
        }
        target.addEventListener("pointermove", move)
        target.addEventListener("pointerup", up)
      }}
    />
  )
}

/** Which shell this terminal runs (bash, zsh, fish… or PowerShell, Git Bash, WSL, cmd on Windows). */
function ShellPicker({ termKey }: { termKey: string }) {
  const [list, setList] = useState<ShellChoice[]>([])
  const picked = useApp((s) => s.settings.terminalShell)
  useEffect(() => {
    void loadShells().then(setList)
  }, [])
  if (list.length < 2) return null
  const current = currentShellId(list, picked)
  const label = list.find((s) => s.id === current)?.label ?? "Shell"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" className="gap-1 font-normal" title="The shell this terminal runs" aria-label={`Shell: ${label}`}>
          {label}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {list.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => s.id !== current && void switchShell(termKey, s.id)}>
            {s.label}
            {s.id === current && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
