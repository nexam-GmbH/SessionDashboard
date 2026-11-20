// `! command` in the prompt box, as Claude Code's bash mode: run once in the session's folder, shown
// in the chat, and read by Claude with your next message (src/backend/real.ts realShell). A program
// that wants a terminal (an editor, a pager, a remote login, a REPL) goes to the terminal dock.
import { REAL } from "@/backend/mode"
import type { ID } from "@/lib/model"
import { getApp, setApp } from "@/store/app"
import { addShellRun, emptyTranscript, newMapState, setShellRun } from "@/backend/mapTranscript"

/** Always need a terminal. */
const SCREEN = new Set(["ssh", "mosh", "telnet", "vim", "vi", "nvim", "nano", "emacs", "micro", "hx", "top", "htop", "btop", "less", "more", "man", "tmux", "screen", "watch"])
/** Need one when started bare (a REPL or a shell). */
const BARE = new Set(["claude", "python", "python3", "node", "bun", "deno", "irb", "ghci", "psql", "mysql", "sqlite3", "redis-cli", "bash", "zsh", "sh", "fish", "pwsh", "powershell", "nu"])
/** ssh options that take a value. */
const SSH_ARG = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w", "-B"])

/** Whether a command is an interactive program that only works in a terminal. */
export function needsTerminal(command: string): boolean {
  const words = command.trim().split(/\s+/)
  // VAR=value in front of it
  while (words.length > 1 && /^[A-Za-z_]\w*=/.test(words[0])) words.shift()
  const [first = "", ...args] = words
  const name = first.split(/[\\/]/).pop()!.replace(/\.exe$/i, "").toLowerCase()
  if (name === "ssh") {
    // `ssh host` logs in; `ssh host cmd` just runs cmd there
    let positional = 0
    for (let i = 0; i < args.length; i++) {
      if (SSH_ARG.has(args[i])) i++
      else if (!args[i].startsWith("-")) positional++
    }
    return positional <= 1
  }
  if (name === "emacs" && args.some((a) => a === "--batch" || a === "-batch")) return false
  if (SCREEN.has(name)) return true
  return BARE.has(name) && !args.length
}

/** Run `! command` for a session (the mock world shows what it would do). */
export function runShell(sessionId: ID, command: string) {
  const interactive = needsTerminal(command)
  if (REAL) return void import("@/backend/real").then((r) => r.realShell(sessionId, command, interactive))
  const id = `shell:${crypto.randomUUID()}`
  const patch = (f: (t: ReturnType<typeof emptyTranscript>) => ReturnType<typeof emptyTranscript>) =>
    setApp((s) => ({ transcripts: { ...s.transcripts, [sessionId]: f(s.transcripts[sessionId] ?? emptyTranscript(sessionId)) } }))
  patch((t) => addShellRun(t, newMapState(), id, command, interactive ? { stdout: "", stderr: "", needsTerminal: true } : { stdout: "", stderr: "", running: true }))
  if (interactive) return
  const cwd = getApp().sessions[sessionId]?.cwd ?? "~"
  setTimeout(() => patch((t) => setShellRun(t, id, { stdout: `Mock world: nothing ran. In the desktop app \`${command}\` runs in ${cwd} and Claude reads its output with your next message.`, stderr: "", code: 0 })), 600)
}
