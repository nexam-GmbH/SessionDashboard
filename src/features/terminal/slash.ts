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

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

/** What the installed claude itself reports as bound to its terminal UI (system/init of a session the app runs). */
let reported: Set<string> | null = null
export function setTerminalCommands(list: string[] | undefined) {
  // leaving claude makes no sense for a session the app runs: /exit stays a no-op there
  if (list?.length) reported = new Set(list.map((c) => c.replace(/^\//, "")).filter((c) => c !== "exit" && c !== "quit"))
}

/** The shell command for a slash command that needs the terminal, or null when the session can run it. */
export function terminalCommandFor(text: string): { run: string; mcp?: boolean } | null {
  const m = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  const [, cmd, rest = ""] = m
  if (!TUI.has(cmd) && !reported?.has(cmd)) return null
  const args = rest.trim()
  switch (cmd) {
    case "mcp":
      // Claude Code's own MCP menu (servers, status, Authenticate / Disable), in a claude the
      // session list leaves out (SD_HIDE); `/mcp <args>` runs the CLI's `claude mcp <args>`
      return args ? { run: `claude mcp ${args}`, mcp: true } : { run: "SD_HIDE=1 claude /mcp", mcp: true }
    case "login":
      return { run: "claude auth login" }
    case "logout":
      return { run: "claude auth logout" }
    case "doctor":
      return { run: "claude doctor" }
    default:
      // an interactive claude that opens with that command (left out of the session list)
      return { run: `SD_HIDE=1 claude ${q(`/${cmd}${args ? ` ${args}` : ""}`)}` }
  }
}
