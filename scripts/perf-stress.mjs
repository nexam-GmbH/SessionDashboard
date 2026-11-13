// Dev tool: performance check on the stress fixture (UI_PLAN §8 budgets), Playwright + system Chrome.
// Usage: node scripts/perf-stress.mjs [outFile.json] [--prod]
//   --prod: against a production build (SHOT_BASE=http://localhost:4173/ after `vite build` + `vite preview`);
//           skips the engine-load and code-graph parts, which need dev-only hooks.
// Measures, in the page (performance.now + rAF + longtask observer):
//  - Sessions table, History view (~4.7k rows): scroll fps, sort, view switch, search to paint
//  - Command palette: per-keystroke search over ~5.4k sessions
//  - Code graph ?graphNodes=20000: time to community view, drill into a community, camera fps
//  - Mock engine at 100 events/s with the sessions table open: fps + long tasks
// Headless Chrome on a dev machine is not WebKitGTK; treat numbers as relative, not absolute.
import { chromium } from "playwright"
import { writeFileSync } from "node:fs"

const BASE = process.env.SHOT_BASE ?? "http://localhost:3000/"
const out = process.argv.slice(2).find((a) => !a.startsWith("--"))
const PROD = process.argv.includes("--prod")
const results = {}
const logs = []

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-gpu", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`))
page.on("console", (m) => {
  if (m.type() === "error") logs.push(`[error] ${m.text()}`)
})

const INSTALL = () => {
  window.__perf = {
    longTasks: [],
    start() {
      this.longTasks = []
      try {
        this.po?.disconnect()
        this.po = new PerformanceObserver((l) => l.getEntries().forEach((e) => this.longTasks.push(Math.round(e.duration))))
        this.po.observe({ type: "longtask" })
      } catch {
        /* unsupported */
      }
    },
    frames: (ms) =>
      new Promise((resolve) => {
        const times = []
        const t0 = performance.now()
        const loop = (t) => {
          times.push(t)
          if (t - t0 < ms) requestAnimationFrame(loop)
          else {
            const d = times.slice(1).map((x, i) => x - times[i])
            d.sort((a, b) => a - b)
            resolve({ fps: Math.round((times.length - 1) / ((times.at(-1) - times[0]) / 1000)), p95FrameMs: Math.round(d[Math.floor(d.length * 0.95)] ?? 0), maxFrameMs: Math.round(d.at(-1) ?? 0) })
          }
        }
        requestAnimationFrame(loop)
      }),
    paint: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    until: (pred, timeout = 8000) =>
      new Promise((resolve) => {
        const t0 = performance.now()
        const tick = () => {
          let ok = false
          try {
            ok = pred()
          } catch {
            /* not ready */
          }
          if (ok) resolve(Math.round(performance.now() - t0))
          else if (performance.now() - t0 > timeout) resolve(-1)
          else requestAnimationFrame(tick)
        }
        tick()
      }),
    setInput(el, value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
      setter.call(el, value)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    },
  }
}

async function load(query, hash) {
  await page.goto(`${BASE}${query}${hash}`, { waitUntil: "networkidle" })
  await page.waitForSelector("header", { timeout: 20000 })
  await page.evaluate(INSTALL)
  await page.waitForTimeout(1200)
}

// ---------- sessions table ----------
await load("?engine=off&debug=off&fixture=stress", "#/sessions")
await page.locator("button", { hasText: "History" }).first().click()
await page.waitForTimeout(500)
results.sessionsTable = await page.evaluate(async () => {
  const P = window.__perf
  const el = document.querySelector('[data-qa="sessions-table"]')
  const count = () => document.querySelector('[data-qa="sessions-count"]')?.textContent
  const r = { rows: count() }
  // scroll: 3 s of continuous scrolling, ~1 viewport per 6 frames
  P.start()
  let stop = false
  const scroller = () => {
    if (stop) return
    el.scrollTop += 120
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) el.scrollTop = 0
    requestAnimationFrame(scroller)
  }
  requestAnimationFrame(scroller)
  r.scroll = await P.frames(3000)
  stop = true
  r.scroll.longTasks = P.longTasks.slice()
  el.scrollTop = 0
  await P.paint()
  // sort by "Last" (desc), then asc, then by "Changes"
  const header = (label) => [...el.querySelectorAll(".sticky > div")].find((d) => d.textContent?.trim() === label)
  const timeClick = async (label) => {
    const h = header(label)
    if (!h) return -1
    const t0 = performance.now()
    h.click()
    await P.paint()
    return Math.round(performance.now() - t0)
  }
  r.sortLastMs = await timeClick("Last")
  r.sortLastAgainMs = await timeClick("Last")
  r.sortRepoMs = await timeClick("Repo")
  // view switch Active -> History (filter + sort of 5.4k)
  const viewBtn = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label))
  let t0 = performance.now()
  viewBtn("Active").click()
  await P.paint()
  r.switchToActiveMs = Math.round(performance.now() - t0)
  t0 = performance.now()
  viewBtn("History").click()
  await P.paint()
  r.switchToHistoryMs = Math.round(performance.now() - t0)
  // search: input event to the filtered count being painted (deferred render included)
  const input = document.querySelector('[data-qa="sessions-search"]')
  // the first rendered row's title tells us the (deferred) filtered list has been painted
  const firstTitle = () => el.querySelector(".group\\/tr")?.textContent?.toLowerCase() ?? ""
  P.start()
  t0 = performance.now()
  P.setInput(input, "retry")
  r.inputCommitMs = Math.round(performance.now() - t0)
  r.searchToPaintMs = await P.until(() => firstTitle().includes("retry"))
  r.searchRows = count()
  t0 = performance.now()
  P.setInput(input, "fix flaky")
  r.search2ToPaintMs = await P.until(() => firstTitle().includes("flaky"))
  r.search2Rows = count()
  r.searchLongTasks = P.longTasks.slice()
  P.setInput(input, "")
  return r
})
console.log("sessionsTable", results.sessionsTable)

// ---------- palette ----------
results.palette = await page.evaluate(async () => {
  const P = window.__perf
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }))
  await P.until(() => document.querySelector("[cmdk-input]"))
  const input = document.querySelector("[cmdk-input]")
  const items = () => document.querySelectorAll("[cmdk-item]").length
  const per = []
  P.start()
  let q = ""
  for (const ch of "retry") {
    q += ch
    const t0 = performance.now()
    P.setInput(input, q)
    await P.paint()
    await P.paint()
    per.push(Math.round(performance.now() - t0))
  }
  const r = { perKeystrokeMs: per, maxMs: Math.max(...per), items: items(), longTasks: P.longTasks.slice() }
  // note: includes two rAF waits per keystroke; see the CPU profile for the JS cost
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  return r
})
console.log("palette", results.palette)

// ---------- engine load with sessions table open ----------
await page.keyboard.press("Escape")
if (!PROD) results.engineLoad = await page.evaluate(async () => {
  const P = window.__perf
  const a = await import("/src/store/actions.ts")
  ;[...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Active"))?.click()
  a.setEngine({ running: true, rate: 100 })
  await new Promise((r) => setTimeout(r, 500))
  P.start()
  const f = await P.frames(4000)
  a.setEngine({ running: false })
  return { rate: 100, ...f, longTasks: P.longTasks.slice() }
})
console.log("engineLoad", results.engineLoad)

// ---------- code graph 20k ----------
if (!PROD) {
const tNav = Date.now()
await page.goto(`${BASE}?engine=off&debug=off&fixture=stress&graphNodes=20000#/graph/repo_api-gateway`, { waitUntil: "domcontentloaded" })
await page.evaluate(INSTALL)
await page.waitForFunction(() => window.__codeGraph?.mode === "communities", null, { timeout: 30000 })
results.graph = { toCommunityViewMs: Date.now() - tNav }
const box = await page.evaluate(() => {
  const { sigma, graph } = window.__codeGraph
  const c = graph.nodes().sort((a, b) => graph.getNodeAttribute(b, "size") - graph.getNodeAttribute(a, "size"))[1]
  const d = sigma.getNodeDisplayData(c)
  const vp = sigma.framedGraphToViewport ? sigma.framedGraphToViewport(d) : sigma.graphToViewport(d)
  const rect = sigma.getContainer().getBoundingClientRect()
  return { x: rect.left + vp.x, y: rect.top + vp.y, node: c, label: graph.getNodeAttribute(c, "label") }
})
results.graph.drillInto = box.label
await page.evaluate(() => window.__perf.start())
const tDrill = Date.now()
await page.mouse.click(box.x, box.y)
const drilled = await page.waitForFunction(() => window.__codeGraph?.mode === "nodes" && window.__codeGraph.graph.order, null, { timeout: 20000 }).then(() => true).catch(() => false)
results.graph.drillOk = drilled
results.graph.drillMs = Date.now() - tDrill
results.graph.drilledOrder = await page.evaluate(() => window.__codeGraph?.graph.order)
results.graph.duringLayout = await page.evaluate(async () => {
  const P = window.__perf
  const cam = window.__codeGraph.sigma.getCamera()
  void cam.animate({ ratio: 0.4 }, { duration: 1500 })
  const f = await P.frames(1500)
  return { ...f, longTasks: P.longTasks.slice() }
})
await page.waitForTimeout(4500)
results.graph.afterLayout = await page.evaluate(async () => {
  const P = window.__perf
  P.start()
  const cam = window.__codeGraph.sigma.getCamera()
  void cam.animate({ ratio: 1.2, angle: 0.3 }, { duration: 2000 })
  const f = await P.frames(2000)
  return { ...f, longTasks: P.longTasks.slice() }
})
// back to the overview
await page.locator("button", { hasText: "All communities" }).click().catch(() => logs.push("no 'All communities' button"))
results.graph.backToOverviewOk = await page.waitForFunction(() => window.__codeGraph?.mode === "communities", null, { timeout: 10000 }).then(() => true).catch(() => false)
console.log("graph", results.graph)
}

results.errors = logs
if (out) writeFileSync(out, JSON.stringify(results, null, 2))
console.log(JSON.stringify({ errors: logs }, null, 2))
await browser.close()
