// Terminal panel — UI_PLAN §4.5 / RESEARCH §6.5. xterm.js 6 (MIT) with the WebGL renderer,
// falling back to the DOM renderer when the WebGL context is lost (WebKitGTK GPU issues).
// Wiring after cline/cline@72b3d71:apps/examples/desktop-app/webview/components/terminal-panel.tsx
// (Apache-2.0). Modified: Phase 1 replays a recorded Claude Code PTY session instead of a live PTY.
import { useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { getApp } from "@/store/app"
import type { ID } from "@/lib/model"
import { EmptyState } from "@/components/common/bits"

/** xterm theme from the design tokens (canvas/WebGL renderers can't read CSS variables). */
function termTheme() {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    background: v("--bg-canvas", "#111113"),
    foreground: v("--fg", "#edeef0"),
    cursor: v("--fg-muted", "#b0b4ba"),
    selectionBackground: "#0090ff55", // --brand at 33%
    black: v("--bg-chrome", "#18191b"),
    red: v("--st-error-fg", "#ff9592"),
    green: v("--st-done-fg", "#3dd68c"),
    yellow: v("--st-input-fg", "#ffca16"),
    blue: v("--link", "#70b8ff"),
    magenta: "#d19dff", // Radix purple11 (no token: terminal-only ANSI color)
    cyan: "#7ce2fe", // Radix cyan11
    white: v("--fg-muted", "#b0b4ba"),
    brightBlack: v("--st-idle", "#696e77"),
    brightWhite: v("--fg", "#edeef0"),
  }
}

const E = "\x1b["
const dim = (s: string) => `${E}2m${s}${E}0m`
const b = (s: string) => `${E}1m${s}${E}0m`
const c = (n: number, s: string) => `${E}${n}m${s}${E}0m`
// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length

/** A recorded interactive Claude Code session (what the real PTY shows). */
function recording(sessionId: ID) {
  const s = getApp().sessions[sessionId]
  if (!s) return ""
  const repo = s.repoId ? getApp().repos[s.repoId].name : "main"
  const sid = s.providerSessionIds.at(-1) ?? ""
  const file = s.repoId ? (getApp().repoSpecs[s.repoId]?.files[0] ?? "src/index.ts") : "PLAN.md"
  const lines = [
    `${c(32, "dev@workstation")} ${c(34, `~/code/${repo}`)} ${c(35, "(wt/" + s.handle + ")")} $ claude --resume ${sid.slice(0, 8)}`,
    "",
    ` ${c(33, "✻")} ${b("Welcome back!")}  ${dim(`${s.model} · ${s.permissionMode} · /help for help`)}`,
    "",
    `${c(36, ">")} ${s.firstPrompt.slice(0, 96)}${s.firstPrompt.length > 96 ? "…" : ""}`,
    "",
    `${c(37, "⏺")} I'll start by reading the module and its tests.`,
    "",
    `${c(32, "⏺")} ${b("Read")}(${file})`,
    `  ${dim("⎿")}  Read ${48 + (sid.charCodeAt(0) % 40)} lines`,
    "",
    `${c(32, "⏺")} ${b("Grep")}(pattern: "withRetry", path: ".")`,
    `  ${dim("⎿")}  Found 6 files`,
    "",
    `${c(32, "⏺")} ${b("Update")}(${file})`,
    `  ${dim("⎿")}  Updated ${file} with ${c(32, "9 additions")} and ${c(31, "5 removals")}`,
    `     ${dim("41")} ${c(31, "-    let attempt = 0")}`,
    `     ${dim("41")} ${c(32, "+    const maxAttempts = opts.maxAttempts ?? 3")}`,
    `     ${dim("42")} ${c(32, "+    for (let attempt = 1; ; attempt++) {")}`,
    "",
  ]
  if (s.status === "waiting_permission") {
    const cmd = s.waitingFor?.summary.replace(/^Bash: /, "") ?? "npm test"
    const prefix = cmd.split(" ").slice(0, 2).join(" ")
    const W = 72
    // pad by visible width (ANSI escapes take no columns)
    const row = (content: string) => ` ${c(33, "│")} ${content}${" ".repeat(Math.max(0, W - 2 - visible(content)))} ${c(33, "│")}`
    lines.push(
      `${c(33, "⏺")} ${b("Bash")}(${cmd})`,
      "",
      ` ${c(33, "╭" + "─".repeat(W) + "╮")}`,
      row(b("Bash command")),
      row(`  ${cmd}`),
      row(dim("Run the tests for the changed module")),
      row(""),
      row("Do you want to proceed?"),
      row(`${c(36, "❯")} ${c(36, "1. Yes")}`),
      row(`  2. Yes, and don't ask again for ${prefix}:* commands`),
      row(`  3. No, and tell Claude what to do differently ${dim("(esc)")}`),
      ` ${c(33, "╰" + "─".repeat(W) + "╯")}`,
    )
  } else if (s.status === "working") {
    lines.push(`${c(32, "⏺")} ${b("Bash")}(npm test -- --run)`, `  ${dim("⎿")}  Running…`, "", `${c(33, "✶")} Testing… ${dim("(esc to interrupt · 1m 12s · ↓ 3.1k tokens)")}`)
  } else {
    lines.push(
      `${c(32, "⏺")} ${b("Bash")}(npm test -- --run)`,
      `  ${dim("⎿")}   ${c(32, "✓")} test/retry.test.ts (6 tests) 41ms`,
      `       Tests  ${c(32, "10 passed")} (10)`,
      "",
      `${c(37, "⏺")} Fixed. One increment per attempt; all 10 tests pass.`,
      "",
      ` ${dim("─".repeat(74))}`,
      ` ${c(36, ">")} ${dim("Try \"how does withRetry work?\"")}`,
      ` ${dim("─".repeat(74))}`,
      `   ${dim("? for shortcuts")}${" ".repeat(40)}${dim(`${s.usage.contextPct}% context used`)}`,
    )
  }
  return lines.join("\r\n")
}

export default function TerminalPanel({ sessionId }: { sessionId: ID | null }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current || !sessionId) return
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      theme: termTheme(),
      cursorBlink: false,
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current)
    let disposed = false
    // WebGL renderer with DOM fallback (RESEARCH §6.5)
    void import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        if (disposed) return
        try {
          const webgl = new WebglAddon()
          webgl.onContextLoss(() => webgl.dispose())
          term.loadAddon(webgl)
        } catch {
          /* DOM renderer stays active */
        }
      })
      .catch(() => undefined)
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* container not measured yet */
      }
      term.write(recording(sessionId))
    })
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
    })
    ro.observe(ref.current)
    return () => {
      disposed = true
      ro.disconnect()
      term.dispose()
    }
  }, [sessionId])
  if (!sessionId) return <EmptyState>No session selected.</EmptyState>
  return <div ref={ref} className="absolute inset-0 bg-canvas py-1 pl-2" />
}
