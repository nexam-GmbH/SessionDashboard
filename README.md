# Session Dashboard

A desktop app for running many Claude Code sessions at once. It finds every session on your machine (and on
your servers over ssh), shows at a glance which ones need you, and lets you answer, review and switch between
them as fast as terminal tabs.

Built with Tauri 2, React 19 and shadcn/ui. Linux first; Windows and macOS builds come from the same code.

## What it does

- **Overview.** One tree for everything that runs: a main agent on top, a column per repository, each
  session as a card with what it is doing right now. What needs you is the only thing in colour.
- **Needs you.** Permission prompts, questions, plan approvals and errors are counted in the header.
  `Ctrl+J` jumps to the next one, and permissions can be answered right on the card.
- **Sessions like Claude Code desktop.** A chat per session with readable work summaries
  ("Edited 2 files, ran a command +38 −17"), a live activity line, the plan as a checklist, and a details
  panel with the context window breakdown, changes, pull request status and plan limits.
- **Finds sessions by itself.** Sessions started in any terminal show up on their own, grouped by
  repository (worktrees, servers and cloud sessions of one repo share a column). Optional hooks make their
  states exact and let you answer a terminal session's permission prompt from the app.
- **Built-in terminal.** `` Ctrl+` `` opens a real shell in the session's folder. `! command` in the prompt
  box runs there, and Claude Code commands that need its own interface (`/mcp`, `/login`, `/config`)
  open in it.
- **Usage.** Tokens, value at API prices, prompts and sessions per day, week, month, year or all time,
  an activity heatmap, per-model breakdown, and your plan's 5-hour and weekly limits over time. The history
  is kept in its own ledger, so it survives Claude Code cleaning up old transcripts.
- **Git loose ends.** Worktrees and branches with uncommitted or unpushed work, per repository.
- **Fast.** Sessions switch instantly, chats load from the end of their transcript, and nothing polls
  harder than it has to.

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl+Tab` | Previous session (hold `Ctrl` for the recent list) |
| `Ctrl+J` | Next session that needs you |
| `Ctrl+1` … `Ctrl+9`, `Ctrl+0` | Session by position, overview |
| `Alt+↑` / `Alt+↓` | Up / down the session list |
| `Ctrl+K` | Search sessions, including past ones |
| `Ctrl+N` | New session |
| `` Ctrl+` `` | Terminal |
| `Ctrl+B` | Show / hide the session list |
| `Ctrl+Shift+M` / `I` / `E` | Permission mode, model, effort |
| `?` | All shortcuts |

## Requirements

- [Claude Code](https://code.claude.com) installed and signed in (`claude` on your `PATH`)
- Optional: `gh` (GitHub CLI) for pull request status, `ssh` for sessions on servers

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
