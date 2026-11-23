# Session Dashboard

A desktop app for running many Claude Code sessions at once. It finds every session on your machine (and on
your servers over ssh), shows at a glance which ones need you, and lets you answer, review and switch between
them as fast as terminal tabs.

Built with Tauri 2, React 19 and shadcn/ui. Runs on Linux, macOS and Windows.

## What it does

- **Overview.** One tree for everything that runs: a main agent on top, a column per repository, each
  session as a card with what it is doing right now. What needs you is the only thing in colour.
- **Needs you.** Permission prompts, questions, plan approvals and errors are counted in the header.
  `Ctrl+J` jumps to the one waiting longest, and routine permissions can be answered right on the card.
  Requests that are hard to undo (force pushes, recursive deletes, secrets, deploys) get their own card:
  the effect spelled out, no "always allow", never a single keypress.
- **Calm notifications.** Only what blocks a session notifies, after 10 quiet seconds (a prompt you answer
  in the terminal never pings), at most a few an hour; the rest arrive as one summary. Finished work is a
  dot in the list; working sessions spin.
- **Sessions like Claude Code desktop.** A chat per session with readable work summaries
  ("Edited 2 files, ran a command +38 −17"), a live activity line, the plan as a checklist, and a details
  panel with the context window breakdown, changes, pull request status and plan limits.
- **Back in context.** Return to a session after a while and a card says what you last asked and what
  happened since. The details panel tells whether tests or checks ran after the last edit, and a banner
  offers "Step back" when the same step has failed three times in a row. A long, much-steered session
  can start fresh: a new session in the same folder, opened with an editable brief built from the old
  one (no model call).
- **Parallel work without collisions.** Two sessions editing the same files in one repository are flagged
  on their cards: in the same folder they overwrite each other, in separate worktrees a merge conflict
  waits. Dev servers a session started show as `:5173` chips that open in the browser, and a working
  session that has written nothing for five minutes says so.
- **After a restart.** The sessions that were running when the app closed are offered back in one go.
- **At the usage limit.** Sessions that stopped at the plan's limit are listed with the reset time;
  tick the ones that should go on and they continue one by one after the reset, or right away on
  another account ("Switch and continue", the account with the most room first).
- **Accounts by e-mail.** Bottom left shows the account the app runs on, its plan and 5-hour use; one
  click switches the whole app to another one (Ctrl+K too). New sessions start on it, and a session
  continues on it with your next message: same session, same history, all in `~/.claude`. Settings →
  Accounts adds one with no command to type (`claude setup-token` runs in a terminal of its own; the
  token is checked against the API, then goes to the system's credential store, never into the app's
  settings; a session that gets a 401 stops and says to sign in again), shows each account's
  limits and when its token ends, and can switch accounts by itself at the limit.
- **Pull requests.** Status and checks in the details panel; a red check's failing log lines go to the
  session with one click.
- **Permissions you granted.** Settings → Permissions lists every "always allow" rule from your user and
  project settings, the ones that allow something hard to undo first, and removes one with a click.
- **Finds sessions by itself.** Sessions started in any terminal show up on their own, grouped by
  repository (worktrees, servers and cloud sessions of one repo share a column). Optional hooks make their
  states exact and let you answer a terminal session's permission prompt from the app.
- **Terminal sync.** Turn on Settings → Sessions → Sync terminal sessions and every `claude` you start
  in any terminal (Zed, GNOME Terminal, iTerm, Konsole…) stays one session with the app: replies you
  write in the app are typed into that terminal, and nothing is closed or copied.
- **Built-in terminal.** `` Ctrl+` `` opens a real shell in the session's folder. `! command` in the prompt
  box runs there, and Claude Code commands that need its own interface (`/mcp`, `/login`, `/config`)
  open in it.
- **Usage.** Tokens, value at API prices, prompts and sessions per day, week, month, year or all time,
  an activity heatmap, per-model breakdown, where the value goes (cache reads, cache writes, output), and
  your plan's 5-hour and weekly limits over time. The history is kept in its own ledger, so it survives
  Claude Code cleaning up old transcripts. "Last 5 hours by session" shows which session uses the plan's
  5-hour window. Next to the prompt box, a session whose prompt cache has expired says what the next
  message costs to re-read the conversation.
- **Review.** Files that deserve a look first (secrets, CI, migrations, auth, dependencies) lead the list
  and tests come last; files not opened yet carry a dot; very large diffs suggest going turn by turn.
  Approving a plan can allow the checks it names (tests, builds) for the rest of the session.
- **Git loose ends.** Worktrees and branches with uncommitted or unpushed work, per repository.
- **Find any old session.** Every transcript's conversation is indexed once (seconds), then kept up to
  date: `Ctrl+K` finds what was said in any session, in any language, and opens the chat at that
  message; History lists every session by day; each project shows its latest finished sessions under
  its running ones; old chats continue when you type into them.
- **The chat of Claude Code desktop.** Permission prompts, questions and plans in the conversation,
  queued messages you can edit or send now, Rewind (files and conversation, with Claude Code's own
  snapshots) and Fork from any message, Find in chat, prompt history, attached files by path.
- **Fast.** Sessions switch instantly, chats load from the end of their transcript, and nothing polls
  harder than it has to.

## Drive it from Claude Code and scripts

Settings → Sessions → **Let Claude Code drive the app** gives every Claude Code session the app's tools (an MCP server named `session-dashboard`): start a session the app runs, message it, read it, wait for it, stop it, show it. A session started this way is an ordinary session of the app: listed, restored after a restart, its permission prompts answered by you. Sessions the app runs also accept messages from your other sessions (Claude Code's SendMessage).

The same from a terminal or a script, with the `sd` command (the app binary under that name):

```
sd new --dir ~/repo --name "Fix login" --prompt "Find why the login loops"
sd send "Fix login" "Also add a test"
sd wait "Fix login"        # 0 done, 2 waiting for you, 1 error
sd read "Fix login" --last 5
sd list
```

A session is named by its id, an id prefix or a unique part of its title.

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl+Tab` | Previous session (hold `Ctrl` for the recent list) |
| `Ctrl+J` | Session waiting longest for you |
| `Ctrl+1` … `Ctrl+9`, `Ctrl+0` | Session by position, overview |
| `Alt+↑` / `Alt+↓` | Up / down the session list |
| `Ctrl+K` | Search sessions and what was said in them (opens the chat at the message) |
| `Ctrl+Shift+H` | History: every past session, by day |
| `Ctrl+F` | Find in the chat on screen |
| `Enter` / `Ctrl+Enter` / `Ctrl+Alt+Enter` | Send · interrupt and send · send in a forked session |
| `↑` / `↓` in the prompt box | Earlier prompts of the session |
| `Ctrl+Enter` / `Ctrl+Shift+Enter` on a request | Allow once · always allow |
| `Ctrl+O` | Transcript view: Normal, Thinking, Verbose |
| `Ctrl+N` | New session |
| `` Ctrl+` `` | Terminal |
| `Ctrl+B` | Show / hide the session list |
| `Ctrl+Shift+M` / `I` / `E` | Permission mode, model, effort |
| `?` | All shortcuts |

## Download

Installers for Linux (`.AppImage`, `.deb`, `.rpm`), macOS (Apple silicon and Intel) and Windows are on the
[Releases](https://github.com/shamilbasarov/SessionDashboard/releases/latest) page. They are not signed
yet: on macOS open it once, then System Settings → Privacy & Security → "Open Anyway"; on Windows choose
"More info → Run anyway".

## Requirements

- [Claude Code](https://code.claude.com) installed and signed in (`claude` on your `PATH`)
- Optional: `gh` (GitHub CLI) for pull request status, `ssh` for sessions on servers
- Windows: Git for Windows (Claude Code needs it too); the built-in terminal opens PowerShell

## Build and run

```bash
# Linux (Fedora) system libraries for Tauri
sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install -y c-development

bun install
bun run tauri dev        # development window
bun run install:local    # release build, installed for the current user with a menu entry
```

`bun run dev` serves a browser preview with demo data at http://localhost:3000.

## Development

```bash
bun run typecheck        # TypeScript
bun run lint             # ESLint
bun run check:ui         # end-to-end checks against the browser preview (needs `bun run dev`)
cd src-tauri && cargo test --lib
```

## Credits

Built on [create-tauri-ui](https://github.com/agmmnn/tauri-ui) and [shadcn/ui](https://ui.shadcn.com).
Code adapted from other open-source projects is listed with its license in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
