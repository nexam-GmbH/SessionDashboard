import { OS } from "@/lib/platform"
// Claude Code commands that need its full-screen terminal UI (menus, sign-in). Sessions the app runs
// are headless (`claude -p`), where these only print a summary ("Use /mcp in the terminal"), so the
// app opens Claude Code's real menu in its own terminal instead, in the session's folder
// (`claude /mcp` starts straight in the menu; Esc closes it, Ctrl+C twice leaves claude).

const TUI = new Set([
  "mcp",
  "login",
  "logout",
  "config",
  "settings",
  "permissions",
  "agents",
  "hooks",
  "doctor",
  "plugin",
  "plugins",
  "ide",
  "terminal-setup",
  "install-github-app",
  "memory",
  "theme",
  "statusline",
  "privacy-settings",
])

// how the commands the app types are written: the built-in terminal's shell (Settings → Terminal
// shell): PowerShell by default on Windows, a POSIX shell elsewhere; Git Bash and WSL are POSIX too
export type ShellFamily = "posix" | "powershell" | "cmd"
let family: ShellFamily = OS === "windows" ? "powershell" : "posix"
export function setShellFamily(f: ShellFamily) {
  family = f
}
const q = (s: string) => (family === "cmd" ? `"${s.replace(/"/g, '""')}"` : family === "powershell" ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`)
/** claude with SD_HIDE=1 (left out of the session list), in the terminal's shell syntax */
const hidden = (args: string) =>
  family === "powershell" ? `$env:SD_HIDE='1'; claude ${args}; $env:SD_HIDE=$null` : family === "cmd" ? `set SD_HIDE=1 && claude ${args} & set SD_HIDE=` : `env SD_HIDE=1 claude ${args}`

/** What the installed claude itself reports as bound to its terminal UI (system/init of a session the app runs). */
let reported: Set<string> | null = null
export function setTerminalCommands(list: string[] | undefined) {
  // leaving claude makes no sense for a session the app runs: /exit stays a no-op there
  if (list?.length) reported = new Set(list.map((c) => c.replace(/^\//, "")).filter((c) => c !== "exit" && c !== "quit"))
}

/**
 * The shell command for a slash command that needs the terminal, or null when the session can run it.
 * `resume`: a past session nobody runs, opened itself with the command (`claude --resume <id> /cmd`,
 * as in the CLI). `hideAs`: else the claude that runs it gets this session id, which the app hides
 * for good (no stray "session" left in the list after a /permissions).
 */
export function terminalCommandFor(text: string, opts: { resume?: string; hideAs?: string } = {}): { run: string; mcp?: boolean } | null {
  const m = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  const [, cmd, rest = ""] = m
  if (!TUI.has(cmd) && !reported?.has(cmd)) return null
  const args = rest.trim()
  const id = opts.hideAs && /^[0-9a-f-]{36}$/i.test(opts.hideAs) ? `--session-id ${opts.hideAs} ` : ""
  switch (cmd) {
    case "mcp":
      // Claude Code's own MCP menu (servers, status, Authenticate / Disable), in a claude the
      // session list leaves out (SD_HIDE); `/mcp <args>` runs the CLI's `claude mcp <args>`
      return args ? { run: `claude mcp ${args}`, mcp: true } : { run: hidden(`${id}/mcp`), mcp: true }
    case "login":
      return { run: "claude auth login" }
    case "logout":
      return { run: "claude auth logout" }
    case "doctor":
      return { run: "claude doctor" }
    default: {
      const line = q(`/${cmd}${args ? ` ${args}` : ""}`)
      // the session itself, in the terminal, with that command
      if (opts.resume && /^[0-9a-f-]{36}$/i.test(opts.resume)) return { run: `claude --resume ${opts.resume} ${line}` }
      // an interactive claude that opens with that command (left out of the session list)
      return { run: hidden(`${id}${line}`) }
    }
  }
}
