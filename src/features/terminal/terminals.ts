// The built-in terminal: one real shell per folder (src-tauri/src/term.rs), drawn by xterm.js (MIT).
// Shells stay alive while the dock is closed or another session is on screen, so opening it again
// is instant and keeps what you ran. In the browser preview a tiny echo shell stands in.
import { create } from "zustand"
import type { Terminal } from "@xterm/xterm"
import type { FitAddon } from "@xterm/addon-fit"
import { getApp, setApp } from "@/store/app"
import { currentSessionId } from "@/store/actions"
import { activeWorkspace } from "@/store/selectors"
import { IN_TAURI } from "@/lib/platform"
import { REAL } from "@/backend/mode"
import { terminalCommandFor } from "./slash"

export interface Place {
  /** the folder the shell starts in */
  cwd: string
  /** an ssh host: the shell runs there */
  host?: string
}

interface Entry {
  key: string
  place: Place
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  alive: boolean
  /** start the shell (once): after the dock fitted the terminal, so it starts at its real size */
  start: () => void
  /** the shell runs (or could not start) */
  ready: Promise<void>
  /** the GPU renderer was tried */
  gpu?: boolean
}

const entries = new Map<string, Entry>()

/** What the dock shows: open or not, and the terminal on screen (by key). */
export const useTerminal = create<{ open: boolean; key: string | null; exited: Record<string, boolean> }>(() => ({ open: false, key: null, exited: {} }))

export const keyOf = (p: Place) => `${p.host ?? ""}:${p.cwd}`

/** The folder of what is on screen: the session's folder, else the workspace's main folder, else ~. */
export function currentPlace(): Place {
  const s = getApp()
  const id = currentSessionId()
  const sess = id ? s.sessions[id] : undefined
  if (sess?.cwd && sess.machine !== "cloud") return { cwd: sess.cwd, host: sess.machine || undefined }
  const ws = activeWorkspace(s)
  const home = ws ? Object.values(s.repos).find((r) => r.isHome && r.workspace === ws.id)?.rootPath : undefined
  return { cwd: home ?? "~" }
}

// ---------- xterm, loaded once (preloaded while idle, so the first open is instant) ----------
let lib: Promise<{ Terminal: typeof Terminal; FitAddon: typeof FitAddon }> | null = null
export function loadXterm() {
  lib ??= Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/xterm/css/xterm.css"),
    // xterm measures its cell once, when it opens: with the font not loaded yet it measures the
    // fallback and draws every glyph through font fallback afterwards
    document.fonts?.load('13px "JetBrains Mono Variable"').catch(() => undefined),
    document.fonts?.load('bold 13px "JetBrains Mono Variable"').catch(() => undefined),
  ]).then(([x, f]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon }))
  return lib
}

/**
 * Draw with the GPU (WebGL), as VS Code's terminal does: the DOM renderer re-lays out spans for
 * every line of output, which WebKitGTK feels. If WebGL can't start or its context is lost, the
 * terminal goes on with the DOM renderer.
 */
export function enableGpu(e: Entry) {
  if (e.gpu || !e.term.element) return
  e.gpu = true
  void import("@xterm/addon-webgl")
    .then(({ WebglAddon }) => {
      try {
        const gl = new WebglAddon()
        gl.onContextLoss(() => gl.dispose())
        e.term.loadAddon(gl)
      } catch {
        /* no WebGL here: the DOM renderer stays */
      }
    })
    .catch(() => undefined)
}

function css(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

const THEME = () => ({
  background: "#0a0a0a",
  foreground: "#fafafa",
  cursor: "#fafafa",
  cursorAccent: "#0a0a0a",
  selectionBackground: "rgba(250,250,250,0.22)",
  black: "#262626",
  brightBlack: "#737373",
  red: css("--st-error", "#e5484d"),
  brightRed: css("--st-error-fg", "#ff9592"),
  green: css("--st-done", "#30a46c"),
  brightGreen: css("--st-done-fg", "#3dd68c"),
  yellow: css("--st-input", "#ffc53d"),
  brightYellow: css("--st-input-fg", "#ffca16"),
  blue: css("--st-working", "#0090ff"),
  brightBlue: css("--st-working-fg", "#70b8ff"),
  magenta: "#ab4aba",
  brightMagenta: "#d19dff",
  cyan: "#12a594",
  brightCyan: "#0bd8b6",
  white: "#d4d4d4",
  brightWhite: "#fafafa",
})

/** Keys the app keeps while you type in the terminal; everything else (Ctrl+K, Ctrl+B…) goes to the shell. */
function appKey(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return false
  if (e.code === "Backquote" || e.code === "Tab") return true
  if (!e.shiftKey && !e.altKey && /^Digit\d$/.test(e.code)) return true
  if (!e.shiftKey && e.code === "KeyJ") return true
  return false
}

async function create_(place: Place): Promise<Entry> {
  const { Terminal, FitAddon } = await loadXterm()
  const key = keyOf(place)
  const term = new Terminal({
    fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: false,
    scrollback: 5000,
    allowProposedApi: false,
    // box drawing and blocks (Claude Code's own frames) drawn by the renderer, not by font fallback
    customGlyphs: true,
    allowTransparency: false,
    theme: THEME(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const host = document.createElement("div")
  host.className = "h-full w-full"
  host.dataset.terminal = key
  let started = false
  let ready!: () => void
  const entry: Entry = {
    key,
    place,
    term,
    fit,
    host,
    alive: true,
    ready: new Promise<void>((r) => (ready = r)),
    start: () => {
      if (started) return
      started = true
      if (IN_TAURI && REAL) void connect(entry).finally(ready)
      else {
        fakeShell(entry)
        ready()
      }
    },
  }
  entries.set(key, entry)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true
    // Ctrl+Shift+C copies the selection, Ctrl+Shift+V pastes (like a terminal emulator)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyC" && term.hasSelection()) {
      void navigator.clipboard?.writeText(term.getSelection())
      return false
    }
    return !appKey(e)
  })
  // the dock starts it once fitted; a terminal that never gets on screen starts anyway
  setTimeout(entry.start, 1500)
  return entry
}

async function connect(entry: Entry) {
  const { invoke, Channel } = await import("@tauri-apps/api/core")
  const { term, key, place } = entry
  const ch = new Channel<ArrayBuffer>()
  ch.onmessage = (buf) => {
    const bytes = new Uint8Array(buf)
    if (!bytes.length) {
      entry.alive = false
      term.write("\r\n\x1b[2m[process exited · Enter restarts]\x1b[0m\r\n")
      useTerminal.setState((s) => ({ exited: { ...s.exited, [key]: true } }))
      return
    }
    // xterm takes the UTF-8 bytes as they are (it handles characters split across messages)
    term.write(bytes)
  }
  term.onData((data) => {
    if (!entry.alive) {
      if (data === "\r") void restart(key)
      return
    }
    invoke("term_write", { key, data }).catch(() => undefined)
  })
  term.onResize(({ cols, rows }) => {
    if (entry.alive) invoke("term_resize", { key, cols, rows }).catch(() => undefined)
  })
  try {
    await invoke("term_open", { key, cwd: place.cwd, host: place.host ?? null, cols: term.cols, rows: term.rows, onData: ch })
  } catch (e) {
    entry.alive = false
    term.write(`\x1b[31mCould not start a shell: ${String(e)}\x1b[0m\r\n`)
  }
}

/** Browser preview: echoes what you type and "runs" it, so the dock can be used and tested. */
function fakeShell(entry: Entry) {
  const { term, place } = entry
  let line = ""
  const prompt = () => term.write(`\x1b[2m${place.cwd}\x1b[0m $ `)
  term.write("\x1b[2mPreview shell (the desktop app runs your real shell here)\x1b[0m\r\n")
  prompt()
  term.onData((d) => {
    if (d === "\r") {
      term.write("\r\n")
      if (line.trim()) term.write(`ran: ${line}\r\n`)
      line = ""
      prompt()
    } else if (d === "\x7f") {
      if (line) {
        line = line.slice(0, -1)
        term.write("\b \b")
      }
    } else if (d >= " ") {
      line += d
      term.write(d)
    }
  })
}

async function restart(key: string) {
  const old = entries.get(key)
  if (!old) return
  old.term.dispose()
  old.host.remove()
  entries.delete(key)
  useTerminal.setState((s) => ({ exited: { ...s.exited, [key]: false } }))
  await show(old.place)
}

const pending = new Map<string, Promise<Entry>>()

/** The terminal for a folder, started on first use. */
export async function ensure(place: Place): Promise<Entry> {
  const key = keyOf(place)
  const hit = entries.get(key)
  if (hit) return hit
  let p = pending.get(key)
  if (!p) {
    p = create_(place).finally(() => pending.delete(key))
    pending.set(key, p)
  }
  return p
}

/** Open the dock on a folder's terminal (the one on screen by default). */
export async function show(place: Place = currentPlace()) {
  const key = keyOf(place)
  useTerminal.setState({ open: true, key })
  return ensure(place)
}

export function hideTerminal() {
  useTerminal.setState({ open: false })
  // back from signing in to MCP servers: the session reconnects the ones that were down
  const id = mcpPending
  mcpPending = null
  if (id && REAL) void import("@/backend/real").then((r) => r.realMcpRefresh(id))
}

let mcpPending: string | null = null

/**
 * A slash command that needs Claude Code's terminal UI (/mcp, /login, /config…): run it in the
 * terminal of the session's folder. False when the session can run it itself.
 */
export function runSlashInTerminal(text: string, sessionId?: string): boolean {
  const c = terminalCommandFor(text)
  if (!c) return false
  if (c.mcp && sessionId) mcpPending = sessionId
  void runInTerminal(c.run)
  return true
}

export function toggleTerminal() {
  if (useTerminal.getState().open) {
    hideTerminal()
    // back to the prompt box of what is on screen
    requestAnimationFrame(() => (document.querySelector<HTMLElement>("[data-session-view]:not([hidden]) textarea") ?? undefined)?.focus())
  } else void show().then((e) => e.term.focus())
}

/** Run a command in the terminal of what is on screen (a `! command` in the prompt box or in a reply). */
export async function runInTerminal(command: string, place: Place = currentPlace()) {
  const e = await show(place)
  await e.ready
  if (!e.alive) return
  e.term.focus()
  if (IN_TAURI && REAL) {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("term_write", { key: e.key, data: `${command}\r` }).catch(() => undefined)
  } else e.term.paste(`${command}\r`)
}

/** Close a folder's shell for good. */
export async function closeTerminal(key: string) {
  const e = entries.get(key)
  if (!e) return
  e.term.dispose()
  e.host.remove()
  entries.delete(key)
  if (IN_TAURI && REAL) {
    const { invoke } = await import("@tauri-apps/api/core")
    invoke("term_close", { key }).catch(() => undefined)
  }
  useTerminal.setState((s) => ({ key: s.key === key ? null : s.key, open: s.key === key ? false : s.open }))
}

export const entryOf = (key: string | null) => (key ? entries.get(key) : undefined)

/** Dock height in px, remembered. */
export function setTerminalHeight(h: number) {
  setApp((s) => ({ settings: { ...s.settings, terminalHeight: Math.round(h) } }))
}
