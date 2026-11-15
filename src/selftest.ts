// A self-test of the real desktop paths, run only when the app is started with SD_SELFTEST=1 (a
// test copy). Each step logs "[selftest] PASS|FAIL …" to the app's log file.
import { invoke } from "@tauri-apps/api/core"
import { getApp } from "@/store/app"

const log = (m: string) => (window as unknown as { __sdLog?: (m: string, level?: number) => void }).__sdLog?.(`[selftest] ${m}`, 3)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function step(name: string, fn: () => Promise<string>) {
  const t = performance.now()
  try {
    const detail = await fn()
    log(`PASS ${name} (${Math.round(performance.now() - t)} ms) ${detail}`)
  } catch (e) {
    log(`FAIL ${name} (${Math.round(performance.now() - t)} ms) ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function until<T>(f: () => T | undefined | null | false, ms: number): Promise<T> {
  const end = performance.now() + ms
  for (;;) {
    const v = f()
    if (v) return v
    if (performance.now() > end) throw new Error("timed out")
    await sleep(50)
  }
}

export async function runSelftest() {
  log("start")
  await step("discovery", async () => {
    const n = await until(() => {
      const s = getApp()
      return s.ready && Object.keys(s.sessions).length
    }, 30000)
    return `${n} sessions, ${getApp().repoOrder.length} projects`
  })

  await step("terminal: real shell runs a command", async () => {
    const t = await import("@/features/terminal/terminals")
    const e = await t.show({ cwd: "/tmp" })
    const started = performance.now()
    await until(() => e.alive && e.term.buffer.active.length > 0, 5000)
    await t.runInTerminal("echo sd-$((6*7)) && pwd", { cwd: "/tmp" })
    const text = () => {
      const b = e.term.buffer.active
      let out = ""
      for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? "") + "\n"
      return out
    }
    await until(() => /sd-42/.test(text()) && /\/tmp/.test(text().split("sd-42").pop() ?? ""), 8000)
    const ms = Math.round(performance.now() - started)
    t.hideTerminal()
    return `output back in ${ms} ms`
  })

  await step("terminal: a burst of output (20k lines)", async () => {
    const t = await import("@/features/terminal/terminals")
    const e = await t.show({ cwd: "/tmp" })
    const t0 = performance.now()
    await t.runInTerminal("seq 1 20000 && echo sd-burst-done", { cwd: "/tmp" })
    await until(() => {
      const b = e.term.buffer.active
      for (let i = Math.max(0, b.length - 5); i < b.length; i++) if (b.getLine(i)?.translateToString(true).includes("sd-burst-done") && !b.getLine(i)?.translateToString(true).includes("echo")) return true
      return false
    }, 20000)
    const ms = Math.round(performance.now() - t0)
    t.hideTerminal()
    return `${ms} ms`
  })

  await step("usage: limits", async () => {
    const r = await invoke<{ usage?: { rate_limits?: { five_hour?: { utilization?: number }; seven_day?: { utilization?: number } } } }>("usage_limits")
    const rl = r.usage?.rate_limits
    if (rl?.five_hour?.utilization == null) throw new Error("no five_hour in the answer")
    return `5h ${rl.five_hour.utilization}% · week ${rl.seven_day?.utilization}%`
  })

  await step("usage: scan (all transcripts, first time)", async () => {
    const l = await invoke<{ hours: Record<string, { m: Record<string, { i: number; o: number; w5: number; w1: number; r: number }> }> }>("usage_scan")
    let tok = 0
    for (const h of Object.values(l.hours)) for (const x of Object.values(h.m)) tok += x.i + x.o + x.w5 + x.w1 + x.r
    return `${Object.keys(l.hours).length} hours, ${(tok / 1e9).toFixed(2)}B tokens`
  })

  await step("usage: scan again (only new lines)", async () => {
    await invoke("usage_scan")
    return "ok"
  })

  await step("pr status (gh)", async () => {
    const cwd = Object.values(getApp().sessions).find((x) => !x.machine && x.control !== "history")?.cwd ?? "."
    const pr = await invoke<{ number?: number; state?: string } | null>("pr_status", { cwd })
    return pr ? `#${pr.number} ${pr.state}` : "no PR for that branch"
  })

  await step("transcript: open the biggest live session", async () => {
    const s = getApp()
    const live = Object.values(s.sessions).filter((x) => x.control !== "history" && !x.machine)
    const pick = live.sort((a, b) => b.usage.costUsd - a.usage.costUsd)[0] ?? Object.values(s.sessions)[0]
    if (!pick) throw new Error("no session")
    const { ensureRealTranscript } = await import("@/backend/real")
    ensureRealTranscript(pick.id)
    const t = await until(() => getApp().transcripts[pick.id], 30000)
    return `${t.order.length} items for "${pick.title.slice(0, 40)}"`
  })

  await step("signals: cache, checks and loops read from real transcripts", async () => {
    const { verification, stuck } = await import("@/features/session-view/signals")
    const { cacheCost } = await import("@/features/usage/usageData")
    const { ensureRealTranscript } = await import("@/backend/real")
    // the few most recent live sessions, so their records are this Claude Code's format
    const live = Object.values(getApp().sessions)
      .filter((x) => x.control !== "history" && !x.machine)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 4)
    for (const x of live) ensureRealTranscript(x.id)
    await until(() => live.every((x) => getApp().transcripts[x.id]), 30000)
    const t0 = performance.now()
    const out: string[] = []
    let withCache = 0
    for (const x of live) {
      const t = getApp().transcripts[x.id]
      const v = verification(t)
      const st = stuck(t)
      const c = t.lastCall
      if (c) {
        withCache++
        if (!(c.tokens > 0 && (c.ttl === 300 || c.ttl === 3600) && cacheCost(c.model, c.tokens, c.ttl))) throw new Error(`bad cache record ${JSON.stringify(c)}`)
      }
      out.push(`${v.state}${st ? `/stuck×${st.count}` : ""}${c ? `/${Math.round(c.tokens / 1000)}k@${c.ttl}s` : ""}`)
    }
    if (live.length && !withCache) throw new Error("no session has a last-call cache record")
    return `${out.join(" ")} in ${Math.round(performance.now() - t0)} ms`
  })

  await step("permissions: read rule files, add and remove a rule", async () => {
    const st = getApp()
    const projects = [...new Set(Object.values(st.repos).filter((r) => !r.machine && !r.isHome).map((r) => r.rootPath))]
    const files = await invoke<{ path: string; allow: string[] }[]>("claude_permission_rules", { projects })
    // a scratch project of its own: the real settings files are only read
    const dir = `/tmp/sd-selftest-${Date.now()}`
    const read = () => invoke<{ allow: string[] }[]>("claude_permission_rules", { projects: [dir] }).then((f) => f[0]?.allow ?? [])
    const path = `${dir}/.claude/settings.local.json`
    await invoke("claude_permission_rule", { path, list: "allow", rule: "Bash(ls:*)", add: true })
    await invoke("claude_permission_rule", { path, list: "allow", rule: "Bash(rm:*)", add: true })
    const added = await read()
    await invoke("claude_permission_rule", { path, list: "allow", rule: "Bash(rm:*)", add: false })
    const removed = await read()
    let refused = false
    await invoke("claude_permission_rule", { path: "/etc/hosts", list: "allow", rule: "x", add: true }).catch(() => (refused = true))
    if (!added.includes("Bash(rm:*)") || removed.includes("Bash(rm:*)") || !refused) throw new Error(`added ${added} removed ${removed} refused ${refused}`)
    return `${files.length} rule files, ${files.reduce((n, f) => n + f.allow.length, 0)} allow rules; edit round trip ok`
  })

  await step("discovery: files edited lately, overlaps between sessions", async () => {
    const { selectOverlaps } = await import("@/store/selectors")
    const st = getApp()
    const withEdits = Object.values(st.sessions).filter((x) => x.editedPaths?.length)
    const t0 = performance.now()
    const o = selectOverlaps(st)
    return `${withEdits.length} sessions with recent edits, ${o.size} overlapping, ${Math.round((performance.now() - t0) * 10) / 10} ms`
  })

  await step("ports: what live sessions serve", async () => {
    const t0 = performance.now()
    const ports = await invoke<Record<string, number[]>>("session_ports")
    const days = await invoke<number | null>("claude_user_setting", { key: "cleanupPeriodDays" })
    return `${Object.keys(ports).length} sessions serving (${Object.values(ports).flat().join(", ") || "none"}) in ${Math.round(performance.now() - t0)} ms; cleanupPeriodDays ${days ?? "default"}`
  })

  await step("slash: /mcp goes to Claude Code's menu", async () => {
    const { terminalCommandFor } = await import("@/features/terminal/slash")
    const c = terminalCommandFor("/mcp")
    if (c?.run !== "SD_HIDE=1 claude /mcp") throw new Error(String(c?.run))
    return c.run
  })
  log("done")
}
