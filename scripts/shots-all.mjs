// Dev tool: screenshot suite for every screen and important state (design QA).
// Node + Playwright with the system Chrome (one browser at a time, low RAM).
//
// Usage:
//   node scripts/shots-all.mjs <outDir> [--only=<substr,substr>] [--no-stress] [--w=1440 --h=900]
//
// Writes <outDir>/<NN-name>.png, <outDir>/index.md (file → what it shows) and
// <outDir>/console.log (page errors/warnings, prefixed with the shot that produced them).
// Session ids are generated at runtime, so they are discovered inside the page (store
// module through the Vite dev server, falling back to clicking sidebar rows by title).
import { chromium } from "playwright"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const outDir = args.find((a) => !a.startsWith("--"))
if (!outDir) {
  console.error("usage: node scripts/shots-all.mjs <outDir> [--only=a,b] [--no-stress] [--w=1440] [--h=900]")
  process.exit(1)
}
const flag = (name) => args.find((a) => a.startsWith(`--${name}`))?.split("=")[1]
const ONLY = (flag("only") ?? "").split(",").filter(Boolean)
const NO_STRESS = args.includes("--no-stress")
const W = Number(flag("w") ?? 1440)
const H = Number(flag("h") ?? 900)
const BASE = process.env.SHOT_BASE ?? "http://localhost:3000/"
mkdirSync(outDir, { recursive: true })

const logs = []
const index = []
let current = "boot"
let n = 0

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-gpu", "--ignore-gpu-blocklist"] })
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "dark" })
const page = await context.newPage()
page.setDefaultTimeout(8000)
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") logs.push(`[${current}] [${m.type()}] ${m.text()}`)
})
page.on("pageerror", (e) => logs.push(`[${current}] [pageerror] ${e.message}`))
// popups (pop-out window in the browser) are closed right away
context.on("page", (p) => {
  if (p !== page) void p.close().catch(() => {})
})

const wait = (ms) => page.waitForTimeout(ms)
const want = (name) => !ONLY.length || ONLY.some((o) => name.includes(o))

async function load(query, hash) {
  current = `load ${query}${hash}`
  await page.goto(`${BASE}${query}${hash}`, { waitUntil: "networkidle" })
  await page.waitForSelector("header", { timeout: 15000 })
  await wait(900)
}

async function go(hash) {
  await page.evaluate((h) => {
    window.location.hash = h.replace(/^#/, "")
  }, hash)
  await wait(600)
}

/** Close palette, dialogs, popovers, menus. */
async function reset() {
  for (let i = 0; i < 3; i++) {
    const open = await page.$("[role=dialog], [data-radix-popper-content-wrapper], [role=menu]")
    if (!open) break
    await page.keyboard.press("Escape")
    await wait(150)
  }
}

async function clickText(text, selector = "button") {
  // hidden tabs stay mounted under <Activity> (display:none): only click what is on screen
  const loc = page.locator(`${selector}:visible`, { hasText: text }).first()
  try {
    await loc.click({ timeout: 4000 })
    return true
  } catch (e) {
    logs.push(`[${current}] [suite] click "${text}" failed: ${e.message.split("\n")[0]}`)
    return false
  }
}

async function shot(name, desc, fn) {
  if (!want(name)) return
  n++
  const file = `${String(n).padStart(2, "0")}-${name}.png`
  current = name
  const t0 = Date.now()
  try {
    await reset()
    await fn()
    await wait(350)
    await page.screenshot({ path: join(outDir, file) })
    index.push(`| ${file} | ${desc} | ${Date.now() - t0} ms |`)
    console.log(file)
  } catch (e) {
    logs.push(`[${name}] [suite] failed: ${e.message.split("\n")[0]}`)
    index.push(`| ${file} | FAILED: ${desc} (${e.message.split("\n")[0]}) | |`)
    console.log(`FAILED ${file}: ${e.message.split("\n")[0]}`)
  }
}

/** Find session ids by role in the running app (store module via Vite, DOM fallback). */
async function discover() {
  const fromStore = await page.evaluate(async () => {
    try {
      const mod = (path) => performance.getEntriesByType("resource").map((e) => e.name).findLast((n) => new URL(n).pathname === path) ?? path
      const m = await import(mod("/src/store/app.ts"))
      const s = m.getApp()
      const all = Object.values(s.sessions)
      const has = (t) => all.find((x) => x.title.toLowerCase().includes(t.toLowerCase()))?.id
      const reqOf = (pred) => {
        const r = Object.values(s.requests).find((r) => r.state === "pending" && pred(r))
        return r?.sessionId
      }
      const live = all.filter((x) => !x.archived && x.control !== "history")
      const withDiff = live.filter((x) => x.diff?.filesChanged > 0).sort((a, b) => b.diff.filesChanged - a.diff.filesChanged)[0]?.id
      return {
        main: s.mainSessionId,
        bash: has("Fix auth retry") ?? reqOf((r) => r.subject?.type === "command"),
        edit: has("Update model mapping") ?? reqOf((r) => r.subject?.type === "tool_call"),
        question: has("Rewrite pricing page") ?? reqOf((r) => "questions" in r),
        plan: has("Bump Postgres") ?? reqOf((r) => "planMarkdown" in r),
        error: has("SLA breach") ?? live.find((x) => x.status === "error")?.id,
        observed: has("Prometheus metrics") ?? live.find((x) => x.control === "observed")?.id,
        working: has("rate limiter") ?? live.find((x) => x.status === "working")?.id,
        history: all.find((x) => x.control === "history" && !x.archived)?.id,
        review: withDiff,
      }
    } catch (e) {
      return { failed: String(e) }
    }
  })
  if (!fromStore.failed) return fromStore
  logs.push(`[discover] store import failed (${fromStore.failed}); using sidebar rows`)
  const byRow = async (title) => {
    const row = page.locator(`[title*="${title}"]`).first()
    try {
      await row.click({ timeout: 3000 })
      await row.dblclick({ timeout: 3000 })
      await wait(300)
      const h = await page.evaluate(() => location.hash)
      return h.match(/#\/session\/([^/?]+)/)?.[1]
    } catch {
      return undefined
    }
  }
  return {
    main: "s_main",
    bash: await byRow("Fix auth retry"),
    edit: await byRow("Update model mapping"),
    question: await byRow("Rewrite pricing page"),
    plan: await byRow("Bump Postgres"),
    error: await byRow("SLA breach"),
    observed: await byRow("Prometheus metrics"),
    working: await byRow("rate limiter"),
    history: undefined,
    review: undefined,
  }
}

const Q = "?engine=off&debug=off&fixture=normal"
await load(Q, "#/map")
const ids = await discover()
writeFileSync(join(outDir, "ids.json"), JSON.stringify(ids, null, 2))
console.log("ids", ids)
ids.review ??= ids.bash

// ---------------- map ----------------
await shot("map-default", "Agent map, default fit (normal fixture)", async () => {
  await go("#/map")
  await wait(800)
})
await shot("map-zoomed-out", "Agent map zoomed out (compact/overview LOD)", async () => {
  await go("#/map")
  const box = await page.locator(".react-flow").first().boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 400)
      await wait(80)
    }
  }
  await wait(600)
})
// L is owned by the map canvas (window-capture handler while the canvas or body has focus)
const toggleLinks = async () => {
  await page.locator(".sd-map-canvas:visible").first().focus()
  await page.keyboard.press("l")
}
await shot("map-links", "Agent map with repo links on (L)", async () => {
  await go("#/map")
  await toggleLinks()
  await wait(700)
})
if (want("map-links")) await toggleLinks().catch(() => {}) // links off again
await shot("map-keyboard-n", "Agent map after pressing N on the canvas (next waiting node)", async () => {
  await go("#/map")
  await page.locator(".sd-map-canvas").first().focus()
  await page.keyboard.press("n")
  await wait(900)
})
await shot("inspector-changes", `Inspector: Changes tab for a selected session (${ids.review})`, async () => {
  await go("#/map")
  const ok = await page
    .evaluate(async (id) => {
      const mod = (path) => performance.getEntriesByType("resource").map((e) => e.name).findLast((n) => new URL(n).pathname === path) ?? path
      const a = await import(mod("/src/store/actions.ts"))
      a.select({ kind: "session", id })
      return true
    }, ids.review)
    .catch(() => false)
  if (!ok) await page.locator("[title*='Fix auth retry']").first().click()
  await wait(400)
  await page.locator("button", { hasText: /^Changes( \d+)?$/ }).last().click({ timeout: 4000 })
  await wait(500)
})
if (want("inspector-changes"))
  await page
    .evaluate(async () => {
      const mod = (path) => performance.getEntriesByType("resource").map((e) => e.name).findLast((n) => new URL(n).pathname === path) ?? path
      const a = await import(mod("/src/store/actions.ts"))
      a.select(null)
    })
    .catch(() => {})

// ---------------- sessions ----------------
await shot("sessions-needs-you", "Sessions: Needs you view", async () => {
  await go("#/sessions")
  await clickText("Needs you")
})
await shot("sessions-active", "Sessions: Active view", async () => {
  await go("#/sessions")
  await clickText("Active")
})
await shot("sessions-history-grouped", "Sessions: History view grouped by repo", async () => {
  await go("#/sessions")
  await clickText("History")
  await page.click('button[aria-label="View options"]')
  await page.locator("[role=menuitemcheckbox]", { hasText: "Group by repo" }).click()
  await page.keyboard.press("Escape")
  await wait(300)
})
if (want("sessions-history-grouped")) {
  await page.click('button[aria-label="View options"]').catch(() => {})
  await page.locator("[role=menuitemcheckbox]", { hasText: "Group by repo" }).click().catch(() => {})
  await page.keyboard.press("Escape")
}
await shot("sessions-archive", "Sessions: Archive view", async () => {
  await go("#/sessions")
  await clickText("Archive")
})
await shot("sessions-hover-actions", "Sessions: History row hover (floating Resume / Archive actions)", async () => {
  await go("#/sessions")
  await clickText("History")
  const row = page.locator('[data-qa="sessions-table"] .group\\/tr').nth(2)
  await row.hover({ timeout: 4000 })
  await wait(250)
})
await shot("sessions-view-menu", "Sessions: View options (group, row height, columns)", async () => {
  await go("#/sessions")
  await page.click('button[aria-label="View options"]')
  await wait(300)
})
await page.keyboard.press("Escape")
await shot("sessions-search", "Sessions: search 'auth' across views (Active)", async () => {
  await go("#/sessions")
  await clickText("Active")
  await page.fill('[data-qa="sessions-search"]', "auth")
  await wait(300)
})
if (want("sessions-search")) {
  await page.fill('[data-qa="sessions-search"]', "").catch(() => {})
  await clickText("Needs you")
}

// ---------------- session view ----------------
const sessionShots = [
  ["session-working", "Session view: working session", ids.working],
  ["session-perm-bash", "Session view: Bash permission in the attention dock", ids.bash],
  ["session-perm-edit", "Session view: Edit permission (diff preview)", ids.edit],
  ["session-question", "Session view: AskUserQuestion card", ids.question],
  ["session-plan", "Session view: plan approval (ExitPlanMode)", ids.plan],
  ["session-error", "Session view: error notice", ids.error],
  ["session-observed", "Session view: observed / read-only banner", ids.observed],
  ["session-history", "Session view: history session (Resume / Fork)", ids.history],
]
for (const [name, desc, id] of sessionShots) {
  await shot(name, `${desc} (${id ?? "not found"})`, async () => {
    if (!id) throw new Error("session id not discovered")
    await go(`#/session/${id}`)
    await wait(900)
  })
}

// ---------------- review ----------------
await shot("review-session", `Review: single session (${ids.review})`, async () => {
  await go(`#/review/${ids.review}`)
  await wait(1200)
})
await shot("review-main", "Review: main agent cross-repo task (s_main)", async () => {
  await go("#/review/s_main")
  await wait(1200)
})

// ---------------- repo ----------------
await shot("repo-view", "Repo view: api-gateway", async () => {
  await go("#/repo/repo_api-gateway")
  await wait(500)
})
await shot("repo-view-llm-router", "Repo view: llm-router (Graphify fixture repo)", async () => {
  await go("#/repo/repo_llm-router")
  await wait(500)
})

// ---------------- code graph ----------------
await shot("graph-httpx", "Code graph: llm-router with the real httpx Graphify fixture", async () => {
  await go("#/graph/repo_llm-router")
  await wait(5500)
})
await shot("graph-selected-node", "Code graph: node selected via search (neighborhood + inspector)", async () => {
  await go("#/graph/repo_llm-router")
  await wait(400)
  const input = page.locator('input[placeholder="Find symbol or file…"]').first()
  await input.fill("Client")
  await wait(300)
  await input.press("Enter")
  await wait(1200)
})
/** viewport position of a node in the live sigma renderer (dev hook in CodeGraphView) */
const nodePos = (pick) =>
  page.evaluate((pick) => {
    const cg = window.__codeGraph
    if (!cg) return null
    const nodes = cg.graph.nodes().sort((a, b) => (cg.graph.getNodeAttribute(b, "size") ?? 0) - (cg.graph.getNodeAttribute(a, "size") ?? 0))
    const id = nodes[pick] ?? nodes[0]
    const d = cg.sigma.getNodeDisplayData(id)
    const vp = cg.sigma.framedGraphToViewport(d)
    const r = cg.sigma.getContainer().getBoundingClientRect()
    return { x: r.left + vp.x, y: r.top + vp.y }
  }, pick)
await shot("graph-hover", "Code graph: hovering a node (neighborhood highlight, label backdrop)", async () => {
  await go("#/graph/repo_llm-router")
  await page.keyboard.press("Escape")
  await wait(400)
  const p = await nodePos(3)
  if (!p) throw new Error("no __codeGraph hook")
  await page.mouse.move(p.x, p.y)
  await wait(500)
})
await page.mouse.move(5, 5)
const toggleReport = async () => {
  await page.click('button[aria-label="More"]:visible')
  await page.locator("[role=menuitemcheckbox]", { hasText: "Report" }).click()
}
await shot("graph-report", "Code graph: report panel (GRAPH_REPORT.md highlights, from the … menu)", async () => {
  await go("#/graph/repo_llm-router")
  await page.keyboard.press("Escape")
  await toggleReport()
  await wait(500)
})
if (want("graph-report")) await toggleReport().catch(() => {})
await shot("graph-filter-menu", "Code graph: Filter menu (relation + confidence)", async () => {
  await go("#/graph/repo_llm-router")
  await clickText("Filter")
  await wait(300)
})
await page.keyboard.press("Escape")
await shot("graph-synthetic", "Code graph: synthetic repo graph (api-gateway)", async () => {
  await go("#/graph/repo_api-gateway")
  await wait(6500)
})
await shot("graph-communities", "Code graph: community view (api-gateway)", async () => {
  await go("#/graph/repo_api-gateway")
  await clickText("Communities")
  await wait(1200)
})
await shot("graph-global", "Code graph: global cross-repo graph", async () => {
  await go("#/graph/global")
  await wait(6500)
})

// ---------------- settings ----------------
const SETTINGS = ["Repos", "Claude Code", "Appearance", "Notifications", "Keybindings", "Graphify", "Layouts", "About"]
for (const label of SETTINGS) {
  const slug = label.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")
  await shot(`settings-${slug}`, `Settings: ${label}`, async () => {
    await go("#/settings")
    await page.locator("nav button", { hasText: label }).first().click({ timeout: 4000 })
    await wait(250)
  })
}
await shot("settings-add-repos", "Settings: Add folder dialog (repo scan)", async () => {
  await go("#/settings")
  await page.locator("nav button", { hasText: "Repos" }).first().click()
  await page.click('button[title^="Add a folder"]')
  await wait(300)
})

// ---------------- dialogs + palette ----------------
await shot("new-session", "New session dialog", async () => {
  await go("#/map")
  await page.keyboard.press("Control+n")
  await wait(400)
})
await shot("new-session-more", "New session dialog with Options open and the CLI preview", async () => {
  await page.keyboard.press("Control+n")
  await wait(300)
  await clickText("Options")
  await clickText("CLI")
  await wait(200)
})
await shot("new-session-resume", "New session dialog: Resume tab", async () => {
  await page.keyboard.press("Control+n")
  await wait(300)
  await page.locator("[role=dialog] button", { hasText: /^Resume$/ }).first().click()
  await wait(200)
  await page.keyboard.press("ArrowDown")
  await wait(300)
})
await shot("cross-repo", "New cross-repo task dialog", async () => {
  await page.keyboard.press("Control+Shift+n")
  await wait(400)
})
await shot("palette-empty", "Command palette, empty query", async () => {
  await page.keyboard.press("Control+k")
  await wait(400)
})
await shot("palette-query", "Command palette with query 'auth'", async () => {
  await page.keyboard.press("Control+k")
  await wait(300)
  await page.keyboard.type("auth")
  await wait(300)
})
await shot("palette-commands", "Command palette in > command mode", async () => {
  await page.keyboard.press("Control+k")
  await wait(300)
  await page.keyboard.type(">")
  await wait(300)
})

// ---------------- notifications ----------------
await shot("notifications-popover", "Notifications popover (bell)", async () => {
  await go("#/map")
  await page.click('button[aria-label^="Notifications"]')
  await wait(400)
})
await shot("toast", "Toast stack (Settings → Send test notification)", async () => {
  await go("#/settings")
  await page.locator("nav button", { hasText: "Notifications" }).first().click()
  await page.click('button[title="Send a test notification"]')
  await wait(500)
})

// ---------------- bottom panel ----------------
// the collapsed panel keeps its header in the DOM (clipped), so test what is actually on screen
const panelOpen = () =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Events")
    if (!b) return false
    const r = b.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && b.contains(hit)
  })
await shot("panel-terminal", "Bottom panel: terminal replay for the Bash-permission session", async () => {
  await go(`#/session/${ids.bash}`)
  if (!(await panelOpen())) await page.keyboard.press("Control+j")
  await wait(400)
  await page.locator("button", { hasText: /^Terminal$/ }).first().click({ timeout: 4000 })
  await wait(1200)
})
await shot("panel-events", "Bottom panel: events log", async () => {
  if (!(await panelOpen())) await page.keyboard.press("Control+j")
  await wait(300)
  await page.locator("button", { hasText: /^Events$/ }).first().click({ timeout: 4000 })
  await wait(600)
})
if (await panelOpen()) await page.keyboard.press("Control+j")

// ---------------- dev ----------------
await shot("dev-webgl", "Dev: WebGL check", async () => {
  await go("#/dev/webgl")
  await page.waitForSelector("[data-ready=true]", { timeout: 15000 }).catch(() => {})
  await wait(300)
})
await shot("dev-perf", "Dev: perf harness", async () => {
  await go("#/dev/perf")
  await wait(2300)
})

// ---------------- popout + onboarding (full reloads) ----------------
await shot("popout-session", `Pop-out window route (#/popout/session/${ids.bash})`, async () => {
  await load(Q, `#/popout/session/${ids.bash}`)
  await wait(800)
})
await shot("onboarding", "Onboarding: first-run Add your repositories (?onboarding=1)", async () => {
  await load(`${Q}&onboarding=1`, "#/map")
  await wait(500)
})

// ---------------- stress fixture ----------------
if (!NO_STRESS) {
  const QS = "?engine=off&debug=off&fixture=stress"
  await shot("stress-map", "Stress fixture: map + sidebar (60 repos / 400 live / 5k history)", async () => {
    await load(QS, "#/map")
    await wait(1500)
  })
  await shot("stress-sessions", "Stress fixture: Sessions → Active", async () => {
    await go("#/sessions")
    await clickText("Active")
    await wait(500)
  })
  await shot("stress-sessions-history", "Stress fixture: Sessions → History (5k rows)", async () => {
    await go("#/sessions")
    await clickText("History")
    await wait(500)
  })
  await shot("stress-palette", "Stress fixture: palette search over 5k sessions ('retry')", async () => {
    await page.keyboard.press("Control+k")
    await wait(300)
    await page.keyboard.type("retry")
    await wait(400)
  })
  await shot("stress-graph-20k", "Stress: code graph with ?graphNodes=20000 (auto community view)", async () => {
    await load(`${QS}&graphNodes=20000`, "#/graph/repo_api-gateway")
    await wait(3000)
  })
  await shot("stress-graph-drill", "Stress: 20k graph after clicking a community (subset node view)", async () => {
    const p = await nodePos(2)
    if (!p) throw new Error("no __codeGraph hook")
    await page.mouse.click(p.x, p.y)
    await wait(4500)
  })
}

writeFileSync(
  join(outDir, "index.md"),
  [
    `# Screenshot suite (${new Date().toISOString()})`,
    "",
    `Viewport ${W}×${H}, base ${BASE}. Session ids: \`${JSON.stringify(ids)}\``,
    "",
    "| File | Shows | Time |",
    "|---|---|---|",
    ...index,
    "",
    `Console: ${logs.length} warnings/errors → console.log`,
  ].join("\n"),
)
writeFileSync(join(outDir, "console.log"), logs.join("\n"))
console.log(`\n${index.length} shots → ${outDir}; console: ${logs.length} entries`)
await browser.close()
