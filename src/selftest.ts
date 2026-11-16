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
  // with a stand-in claude (SD_CLAUDE_BIN, test runs only): a session the app runs streams its
  // answer through the batched events and ends idle with the whole text
  if (await invoke<boolean>("sd_fake_claude").catch(() => false)) {
    await step("stream: an app-run session's reply arrives whole through the batches", async () => {
      const { realStart } = await import("@/backend/real")
      await until(() => getApp().ready, 30000)
      const id = realStart({ cwd: "/tmp", prompt: "say hi" })
      const t0 = performance.now()
      const text = await until(() => {
        const t = getApp().transcripts[id]
        const s = getApp().sessions[id]
        const done = s && s.status !== "working" && s.status !== "starting"
        const last = t?.order.map((x) => t.items[x]).filter((x) => x?.type === "agent_message").at(-1)
        return done && last && last.type === "agent_message" && last.text.endsWith("SD-FAKE-DONE") ? last.text : null
      }, 20000)
      const t = getApp().transcripts[id]
      const live = t.order.filter((x) => x.startsWith("live:")).length
      if (live) throw new Error(`${live} streaming placeholders left`)
      return `${text.split(" ").length} words, ${t.order.length} items, status ${getApp().sessions[id].status}, ${Math.round(performance.now() - t0)} ms`
    })
    // a session in the middle of a long turn (the stand-in streams for ~12 s when asked for
    // "long"), past its first 5 s (before that a new message replaces the turn: rapid follow-up)
    const settled = async (id: string) => {
      await until(() => getApp().sessions[id]?.status === "working" && getApp().transcripts[id]?.order.some((x) => x.startsWith("live:")), 10000)
      const turn = getApp().transcripts[id].turns.at(-1)!
      await until(() => Date.now() - Date.parse(turn.startedAt) > 5300, 8000)
    }
    const busy = async (id: string, text = "long turn please") => {
      const { sendMessage } = await import("@/store/actions")
      await until(() => getApp().sessions[id]?.status === "idle" || getApp().sessions[id]?.status === "done_unseen", 25000)
      sendMessage(id, text)
      await settled(id)
    }
    const said = (id: string, text: string) => getApp().transcripts[id]?.order.map((x) => getApp().transcripts[id].items[x]).filter((x) => x?.type === "user_message" && x.text === text) ?? []
    await step("queue: Enter mid-turn waits at the end of the chat, then joins the turn (once)", async () => {
      const { realStart } = await import("@/backend/real")
      const { sendMessage } = await import("@/store/actions")
      const id = realStart({ cwd: "/tmp", prompt: "long turn please" })
      await settled(id)
      sendMessage(id, "also check the docs")
      const queued = await until(() => getApp().transcripts[id]?.queued.length === 1 && "waiting", 3000)
      const t0 = performance.now()
      await until(() => getApp().transcripts[id]?.queued.length === 0, 5000)
      const shown = said(id, "also check the docs")
      if (shown.length !== 1) throw new Error(`shown ${shown.length} times (the replayed echo must not add one)`)
      const steer = shown[0]
      if (steer?.type !== "user_message" || !steer.steer) throw new Error("the message did not join the running turn")
      ;(window as unknown as { __q: string }).__q = id
      return `${queued}, taken in after ${Math.round(performance.now() - t0)} ms, shown once in the turn`
    })
    await step("queue: Remove and Esc take a waiting message back (cancel_async_message)", async () => {
      const id = (window as unknown as { __q: string }).__q
      const { sendMessage } = await import("@/store/actions")
      const { realCancelQueued } = await import("@/backend/real")
      const { takeBackWaiting, getDraft, setDraft } = await import("@/features/session-view/sessionStore")
      await busy(id)
      sendMessage(id, "never mind this one")
      const q = await until(() => getApp().transcripts[id]?.queued[0], 3000)
      const ok = await realCancelQueued(id, q.id)
      if (!ok || getApp().transcripts[id].queued.length) throw new Error(`cancelled ${ok}, left ${getApp().transcripts[id].queued.length}`)
      sendMessage(id, "back into the box")
      await until(() => getApp().transcripts[id]?.queued.length === 1, 3000)
      if (!takeBackWaiting(id)) throw new Error("Esc found nothing waiting")
      await until(() => getDraft(id).text === "back into the box", 3000)
      if (getApp().transcripts[id].queued.length) throw new Error("still waiting after Esc")
      setDraft(id, { text: "", attachments: [] })
      return "removed; Esc put the text back in the box"
    })
    await step("send now: a waiting message is read next (interrupt send_now)", async () => {
      const id = (window as unknown as { __q: string }).__q
      const { sendMessage } = await import("@/store/actions")
      const { sendWaitingNow } = await import("@/features/session-view/sessionStore")
      await busy(id)
      sendMessage(id, "read this now")
      const q = await until(() => getApp().transcripts[id]?.queued[0], 3000)
      const t0 = performance.now()
      sendWaitingNow(id, q.id)
      await until(() => said(id, "read this now").length === 1 && getApp().transcripts[id].queued.length === 0, 4000)
      return `in the chat ${Math.round(performance.now() - t0)} ms after Send now`
    })
    await step("later: Ctrl+Enter holds the message until the turn is over", async () => {
      const id = (window as unknown as { __q: string }).__q
      const { queueMessage, getUiValue } = await import("@/features/session-view/sessionStore")
      await busy(id)
      queueMessage(id, "after this turn")
      const held = getUiValue<unknown[]>(`outbox:${id}`, []).length
      if (held !== 1 || getApp().transcripts[id].queued.length) throw new Error(`outbox ${held}, sent ${getApp().transcripts[id].queued.length}`)
      const turns = getApp().transcripts[id].turns.length
      await until(() => said(id, "after this turn").length === 1, 15000)
      const t = getApp().transcripts[id]
      const turn = t.turns.find((x) => x.itemIds.some((i) => (t.items[i] as { text?: string })?.text === "after this turn"))
      if (!turn || t.turns.indexOf(turn) < turns) throw new Error("it did not start a turn of its own")
      return "sent when the turn ended, as a turn of its own"
    })
    await step("rapid follow-up: a message right after the turn began replaces it (priority now)", async () => {
      const id = (window as unknown as { __q: string }).__q
      const { sendMessage } = await import("@/store/actions")
      await until(() => getApp().sessions[id]?.status === "idle" || getApp().sessions[id]?.status === "done_unseen", 25000)
      sendMessage(id, "long turn please")
      await until(() => getApp().sessions[id]?.status === "working", 5000)
      const t0 = performance.now()
      sendMessage(id, "oh, and use the docs")
      await until(() => said(id, "oh, and use the docs").length === 1, 5000)
      const ms = Math.round(performance.now() - t0)
      if (getApp().sessions[id].status === "error") throw new Error("the replaced turn shows as failed")
      await until(() => getApp().sessions[id]?.status !== "working" && getApp().sessions[id]?.status !== "starting", 20000)
      const t = getApp().transcripts[id]
      const replaced = t.turns.filter((x) => x.itemIds.some((i) => (t.items[i] as { text?: string })?.text === "long turn please")).at(-1)
      if (replaced?.status === "failed") throw new Error("the replaced turn is marked failed")
      return `the follow-up started ${ms} ms later as a turn of its own; the replaced turn ${replaced?.status}`
    })
    await step("stop: Stop ends the turn at once; a waiting message runs next", async () => {
      const id = (window as unknown as { __q: string }).__q
      const { sendMessage } = await import("@/store/actions")
      const { interruptSession } = await import("@/features/session-view/sessionStore")
      await busy(id)
      sendMessage(id, "do this instead")
      await until(() => getApp().transcripts[id]?.queued.length === 1, 3000)
      const t0 = performance.now()
      interruptSession(id)
      // stopped: the turn ended (failed or not) and the waiting message starts a turn of its own
      await until(() => said(id, "do this instead").length === 1, 5000)
      const stopMs = Math.round(performance.now() - t0)
      await until(() => getApp().sessions[id]?.status !== "working" && getApp().sessions[id]?.status !== "starting", 15000)
      return `stopped and the waiting message started ${stopMs} ms after Stop; session ${getApp().sessions[id].status}`
    })
    await step("stop: a claude that does not answer Stop is ended; what waited goes back to the box", async () => {
      const id = (window as unknown as { __q: string }).__q
      const { sendMessage } = await import("@/store/actions")
      const { interruptSession, getDraft, clearStopping } = await import("@/features/session-view/sessionStore")
      await busy(id, "long deaf turn")
      sendMessage(id, "kept for later")
      await until(() => getApp().transcripts[id]?.queued.length === 1, 3000)
      const t0 = performance.now()
      interruptSession(id)
      await until(() => getApp().sessions[id]?.status !== "working" && getApp().sessions[id]?.status !== "starting", 8000)
      const ms = Math.round(performance.now() - t0)
      await until(() => getDraft(id).text.includes("kept for later"), 3000)
      clearStopping(id)
      const t = getApp().transcripts[id]
      if (!t.order.some((x) => (t.items[x] as { text?: string })?.text?.startsWith("Claude did not answer Stop"))) throw new Error("no note in the chat")
      return `ended ${ms} ms after Stop; the waiting message is back in the box, a note says why`
    })
    log("done")
    return
  }
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

  await step("usage: last 5 hours by session (detail filled once)", async () => {
    const { recentBySession } = await import("@/features/usage/usageData")
    const l = await invoke<{ hours: Record<string, { sm?: Record<string, unknown> }>; sessions: string[]; d?: number }>("usage_scan")
    if (l.d !== 1) throw new Error(`detail flag ${l.d}`)
    const r = recentBySession(l as never)
    const withDetail = Object.values(l.hours).filter((h) => h.sm && Object.keys(h.sm).length).length
    return `${withDetail} hours with per-session detail; last 5 h: ${r.rows.length} sessions, $${r.total.toFixed(2)}, top ${Math.round((r.rows[0]?.share ?? 0) * 100)}%`
  })

  await step("accounts: another config folder is read and dropped again", async () => {
    // a folder that does not exist is ignored; the list goes back to the settings' own after
    await invoke("claude_set_config_dirs", { dirs: ["/tmp/sd-no-such-claude-dir"] })
    const n = (await invoke<unknown[]>("claude_scan")).length
    await invoke("claude_set_config_dirs", { dirs: getApp().settings.claudeConfigDirs ?? [] })
    return `${n} transcripts with an extra (missing) folder set`
  })

  await step("slash: /mcp goes to Claude Code's menu", async () => {
    const { terminalCommandFor } = await import("@/features/terminal/slash")
    const c = terminalCommandFor("/mcp")
    if (c?.run !== "SD_HIDE=1 claude /mcp") throw new Error(String(c?.run))
    return c.run
  })
  await step("search: every session's conversation, by words in any language", async () => {
    const { realSearch } = await import("@/backend/real")
    const t0 = performance.now()
    const hits = await realSearch("the", 40)
    const first = Math.round(performance.now() - t0)
    const t1 = performance.now()
    const again = await realSearch("the", 40)
    const second = Math.round(performance.now() - t1)
    if (!hits.length || hits.length !== again.length) throw new Error(`hits ${hits.length} / ${again.length}`)
    const known = hits.filter((h) => getApp().sessions[h.sessionId]).length
    return `${hits.length} sessions (${known} in the list), first ${first} ms (index), again ${second} ms; e.g. "${hits[0].before.slice(-30)}[${hits[0].matched}]${hits[0].after.slice(0, 30)}"`
  })

  await step("search: open an old chat at the message (reads back far enough)", async () => {
    const { realSearch, realLoadTo, ensureRealTranscript } = await import("@/backend/real")
    // the oldest match in a big local session: most likely outside the window that opens first
    const hits = (await realSearch("the", 40)).filter((h) => {
      const x = getApp().sessions[h.sessionId]
      return x && !x.machine
    })
    const h = hits.at(-1)
    if (!h) throw new Error("no local hit")
    ensureRealTranscript(h.sessionId)
    await until(() => getApp().transcripts[h.sessionId], 30000)
    const ok = await realLoadTo(h.sessionId, h.uuid)
    if (!ok) throw new Error(`message ${h.uuid} not in the chat after reading back`)
    return `${getApp().transcripts[h.sessionId].order.length} items, ${h.uuid.slice(0, 8)} on screen`
  })

  await step("attachments: a file is kept where sessions can read it", async () => {
    const path = await invoke<string>("save_attachment", { name: "../notes?.txt", data: btoa("sd-attach-ok") })
    if (!/attachments\/[0-9a-f]{8}\/\.\._notes_\.txt$|attachments\/[0-9a-f]{8}\/notes_\.txt$|attachments\/[0-9a-f]{8}\/[^/]+$/.test(path)) throw new Error(path)
    return path
  })

  await step("titles: names given with /rename win", async () => {
    const st = getApp()
    const named = Object.values(st.sessions).filter((x) => x.title.endsWith("(copy)") || x.titleSource === "custom").length
    return `${named} sessions with a name of their own`
  })
  log("done")
}
