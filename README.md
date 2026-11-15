# Session Dashboard

All your parallel Claude Code sessions in one calm window: an overview tree (main agent → repos → sessions →
subagents) that shows what needs you, and a Claude Code-style chat per session that you switch between as fast
as terminal tabs (Ctrl+Tab, Ctrl+J, Ctrl+1–9). Tauri 2 + React 19 + TypeScript, dark, for Linux, Windows and
macOS.

**Status:** Phase 1, UI only with mock data. No real Claude processes yet.

```bash
bun install
bun run dev          # browser preview at http://localhost:3000
bun run tauri dev    # native window
```

Docs: [HANDOFF.md](HANDOFF.md) (state, decisions, next steps) · [UI_PLAN.md](UI_PLAN.md) (screens, design
system, data model) · [RESEARCH.md](RESEARCH.md) (sources and licenses) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
