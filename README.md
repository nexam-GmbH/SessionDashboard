# Session Dashboard

One place for all your Claude Code sessions across all your repos: an agent map (main agent → repos →
sessions → subagents), full session control (stream, tools, diffs, approvals), history and archive, a Graphify
code graph, and notifications. Tauri 2 + React 19 + TypeScript, dark, for Linux, Windows and macOS.

**Status:** Phase 1, UI only with mock data. No real Claude processes yet.

```bash
bun install
bun run dev          # browser preview at http://localhost:3000
bun run tauri dev    # native window
```

Docs: [HANDOFF.md](HANDOFF.md) (state, decisions, next steps) · [UI_PLAN.md](UI_PLAN.md) (screens, design
system, data model) · [RESEARCH.md](RESEARCH.md) (sources and licenses) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
