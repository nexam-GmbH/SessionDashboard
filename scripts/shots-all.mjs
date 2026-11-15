// Dev tool: screenshot suite for every screen and important state (design QA).
// Node + Playwright with the system Chrome (one browser at a time, low RAM).
//
// Usage:
//   node scripts/shots-all.mjs <outDir> [--only=<substr,substr>] [--w=1440 --h=900]
//
// Writes <outDir>/<NN-name>.png, <outDir>/index.md (file → what it shows) and
// <outDir>/console.log (page errors/warnings, prefixed with the shot that produced them).
// Session ids are generated at runtime, so they are discovered inside the page (store
// module through the Vite dev server).
import { chromium } from "playwright"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const outDir = args.find((a) => !a.startsWith("--"))
if (!outDir) {
  console.error("usage: node scripts/shots-all.mjs <outDir> [--only=a,b] [--w=1440] [--h=900]")
  process.exit(1)
}
const flag = (name) => args.find((a) => a.startsWith(`--${name}`))?.split("=")[1]
const ONLY = (flag("only") ?? "").split(",").filter(Boolean)
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

/** Find session ids by role in the running app (store module via Vite). */
async function discover() {
  return page.evaluate(async () => {
    const mod = (path) => performance.getEntriesByType("resource").map((e) => e.name).findLast((n) => new URL(n).pathname === path) ?? path
    const m = await import(mod("/src/store/app.ts"))
    const s = m.getApp()
    const all = Object.values(s.sessions)
    const has = (t) => all.find((x) => x.title.toLowerCase().includes(t.toLowerCase()) && !x.archived && x.control !== "history")?.id
    const live = all.filter((x) => !x.archived && x.control !== "history")
    return {
      main: s.mainSessionId,
      bash: has("Fix auth retry"),
      edit: has("Update model mapping"),
      question: has("Rewrite pricing page copy"),
      plan: has("Bump Postgres"),
      error: has("SLA breach"),
      observed: live.find((x) => x.control === "observed")?.id,
      working: has("rate limiter"),
      child: live.find((x) => x.title === "Roll out ticket-schema v3")?.id,
      history: all.find((x) => x.control === "history" && !x.archived)?.id,
      review: live.filter((x) => x.diff?.filesChanged > 0).sort((a, b) => b.diff.filesChanged - a.diff.filesChanged)[0]?.id,
      order: live.map((x) => x.id),
    }
  })
}

const Q = "?engine=off&debug=off"
await load(Q, "#/")
const ids = await discover()
writeFileSync(join(outDir, "ids.json"), JSON.stringify(ids, null, 2))
console.log("ids", ids)
const modDown = () => page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true })))
const modUp = () => page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" })))

// ---------------- overview ----------------
await shot("overview", "Overview: main agent → repos → sessions (the sketch)", async () => {
  await go("#/")
})
await shot("overview-hover", "Overview: hovering a working card", async () => {
  await go("#/")
  await page.locator(".ov-item", { hasText: "Add rate limiter" }).first().hover()
  await wait(300)
})
await shot("overview-1280", "Overview at 1280 px", async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await go("#/")
  await wait(300)
})
if (want("overview-1280")) await page.setViewportSize({ width: W, height: H })

// ---------------- session screen ----------------
const sessionShots = [
  ["session-main", "Session: main agent (delegation)", ids.main],
  ["session-working", "Session: working", ids.working],
  ["session-perm-bash", "Session: Bash permission in the dock", ids.bash],
  ["session-perm-edit", "Session: Edit permission (diff preview)", ids.edit],
  ["session-question", "Session: AskUserQuestion card", ids.question],
  ["session-plan", "Session: plan approval", ids.plan],
  ["session-error", "Session: error", ids.error],
  ["session-child", "Session: a subagent waits for permission (activity bar)", ids.child],
  ["session-observed", "Session: observed (running in your terminal)", ids.observed],
  ["session-history", "Session: past session (Resume / Fork)", ids.history],
]
for (const [name, desc, id] of sessionShots) {
  await shot(name, `${desc} (${id ?? "not found"})`, async () => {
    if (!id) throw new Error("session id not discovered")
    await go(`#/session/${id}`)
    await wait(900)
  })
}

await shot("list-peek", "Session list: hover card (where it is, branch, changes)", async () => {
  await go(`#/session/${ids.main}`)
  await page.locator('nav[aria-label="Sessions"] button:visible', { hasText: "Add rate limiter" }).first().hover()
  await wait(1100)
})
await shot("list-ctrl-hints", "Session list: Ctrl held shows the Ctrl+number hints", async () => {
  await go(`#/session/${ids.main}`)
  await modDown()
  await wait(600)
})
if (want("list-ctrl-hints")) await modUp()
await shot("switcher", "Ctrl+Tab held: recent sessions", async () => {
  for (const id of [ids.working, ids.question, ids.error, ids.bash]) await go(`#/session/${id}`)
  await page.keyboard.down("Control")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Tab")
  await wait(400)
})
if (want("switcher")) {
  await page.keyboard.press("Escape")
  await page.keyboard.up("Control")
}

await shot("session-rewind", `Session: Rewind dialog (${ids.bash})`, async () => {
  await go(`#/session/${ids.bash}`)
  await wait(700)
  await page.locator('button[aria-label="More actions"]:visible').first().click()
  await wait(200)
  await page.getByRole("menuitem", { name: /Rewind/ }).click()
  await wait(500)
})
if (want("session-rewind")) {
  await page.keyboard.press("Escape")
  await wait(200)
}

// ---------------- review ----------------
await shot("review-session", `Review: single session (${ids.review})`, async () => {
  await go(`#/review/${ids.review}`)
  await wait(1200)
})
await shot("review-main", "Review: main agent across delegated sessions", async () => {
  await go(`#/review/${ids.main}`)
  await wait(1200)
})

// ---------------- palette, dialogs, menus ----------------
await shot("palette-empty", "Ctrl+K: sessions, most urgent first", async () => {
  await go(`#/session/${ids.main}`)
  await page.keyboard.press("Control+k")
  await wait(400)
})
await shot("palette-query", "Ctrl+K with query 'ticket'", async () => {
  await page.keyboard.press("Control+k")
  await wait(300)
  await page.keyboard.type("ticket")
  await wait(400)
})
await shot("new-session", "New session screen (Ctrl+N): prompt box, folder, worktree, mode, model, effort, past sessions", async () => {
  await page.keyboard.press("Escape")
  await go("#/new")
  await wait(500)
})
await shot("new-session-folder", "New session: folder picker (recent projects, open any folder)", async () => {
  await go("#/new")
  await page.click('[data-new-session] button[aria-label^="Folder:"]')
  await wait(300)
})
await shot("new-session-more", "New session: More options (title, agent, MCP, instructions, background, CLI)", async () => {
  await go("#/new")
  await page.locator("[data-new-session] button", { hasText: "More options" }).first().click()
  await wait(300)
})
await shot("composer-plus", "Prompt box: + menu (files or photos, add folder, mention, slash commands)", async () => {
  await go(`#/session/${ids.working}`)
  await wait(500)
  await page.locator('[data-session-view] button[aria-label="Add"]:visible').first().click()
  await wait(300)
})
await shot("composer-mode", "Prompt box: permission mode menu (Ctrl+Shift+M)", async () => {
  await go(`#/session/${ids.working}`)
  await wait(400)
  await page.keyboard.press("Control+Shift+m")
  await wait(300)
})
await shot("composer-model", "Prompt box: model menu (Ctrl+Shift+I)", async () => {
  await go(`#/session/${ids.working}`)
  await wait(400)
  await page.locator('[data-session-view] button[aria-label^="Model:"]:visible').first().click()
  await wait(300)
})
await shot("composer-context", "Prompt box: context ring details", async () => {
  await go(`#/session/${ids.main}`)
  await wait(400)
  await page.locator('[data-session-view] button[aria-label^="Context"]:visible').first().click()
  await wait(300)
})
await shot("terminal-session", "A session started in a terminal appears by itself (new project 'scratch')", async () => {
  await page.keyboard.press("Escape")
  await page.evaluate(async () => {
    const mod = (path) => performance.getEntriesByType("resource").map((e) => e.name).findLast((n) => new URL(n).pathname === path) ?? path
    const a = await import(mod("/src/store/actions.ts"))
    a.addDiscoveredSession("~/code/scratch", "Try the new streaming API")
  })
  await go("#/")
  await wait(500)
})
await shot("more-menu", "Top bar ⋯ menu", async () => {
  await go("#/")
  await page.click('header button[aria-label="More"]')
  await wait(300)
})
await shot("shortcuts", "? keyboard shortcuts", async () => {
  await go("#/")
  await page.keyboard.press("Shift+?")
  await wait(300)
})
await shot("toast", "Toast after archiving (Undo)", async () => {
  await go(`#/session/${ids.observed}`)
  await page.locator('button[aria-label="More actions"]:visible').first().click()
  await page.getByRole("menuitem", { name: "Archive" }).click()
  await wait(500)
})

// ---------------- archive, settings ----------------
await shot("archive", "Archive screen", async () => {
  await go("#/archive")
  await wait(300)
})
await shot("settings", "Settings (one page)", async () => {
  await go("#/settings")
  await wait(300)
})
await shot("settings-add-repos", "Settings: Add folder dialog (repo scan)", async () => {
  await go("#/settings")
  await page.click('button[title^="Add a folder"]')
  await wait(300)
})

// ---------------- first run ----------------
await shot("onboarding", "Onboarding: first-run Add your repositories (?onboarding=1)", async () => {
  await load(`${Q}&onboarding=1`, "#/")
  await wait(500)
})

writeFileSync(
  join(outDir, "index.md"),
  [
    `# Screenshot suite (${new Date().toISOString()})`,
    "",
    `Viewport ${W}×${H}, base ${BASE}.`,
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
