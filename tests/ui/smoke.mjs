// UI smoke tests: the app's mock world (src/mocks/world.ts) in headless Chromium, with Playwright.
//
//   bun run test:ui                 starts Vite, runs these, stops Vite (tests/ui/run.mjs)
//   node tests/ui/smoke.mjs [name…] against a server already running at UI_BASE; names filter
//                                   tests by substring
//
//   UI_BASE      the app's URL (default http://127.0.0.1:5191/)
//   PW_CHROMIUM  the Chromium (headless shell) binary; default: the newest one Playwright
//                downloaded to ~/.cache/ms-playwright
//
// Every test runs in a fresh browser context (fresh storage, a fresh mock world) and fails on any
// console error or uncaught page error. The mock engine keeps changing the working sessions while
// a test runs, so the tests use sessions at rest (idle or past: the engine never touches those)
// and check presence rather than exact counts. Screenshots of failures go to $TMPDIR/sd-ui-smoke.
import { chromium } from "playwright"
import { globSync, mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const BASE = process.env.UI_BASE ?? "http://127.0.0.1:5191/"
const APP = new URL("?mock&debug=off", BASE).href
const SHOTS = join(tmpdir(), "sd-ui-smoke")
const ONLY = process.argv.slice(2)

/** PW_CHROMIUM, else the newest headless shell in Playwright's cache, else Playwright's own default. */
function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright")
  const rev = (p) => Number(/chromium_headless_shell-(\d+)/.exec(p)?.[1] ?? 0)
  const found = globSync("chromium_headless_shell-*/*/chrome-headless-shell", { cwd: cache }).sort((a, b) => rev(b) - rev(a))
  return found.length ? join(cache, found[0]) : undefined
}

// Stable sessions of the mock world (seeded, so the same every load). Neither is ever working, so
// the mock engine leaves them alone.
const IDLE = "Fix hydration warning on tickets page" // live, idle, web-app
const PAST = "Clean up logging" // past (stopped), infra
const LONG_PATH = "~/Desktop/Git/acme/frontend-worktrees/feature-order-detail-page"

// ---------------------------------------------------------------- harness
const tests = []
const test = (name, fn) => tests.push({ name, fn })

class Fail extends Error {}
function assert(cond, message) {
  if (!cond) throw new Fail(message)
}

/** Poll `fn` until it returns something truthy; fail with `message` (and the last value) if it never does. */
async function eventually(fn, message, timeout = 5000) {
  const end = Date.now() + timeout
  let last
  for (;;) {
    last = await fn().catch((e) => e)
    if (last && !(last instanceof Error)) return last
    if (Date.now() > end) throw new Fail(`${message} (last: ${last instanceof Error ? last.message.split("\n")[0] : JSON.stringify(last)})`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Load the app's mock world and wait until the session list has its sessions. */
async function load(page) {
  await page.goto(APP, { timeout: 30000 })
  await page.locator('nav[aria-label="Sessions"]:not([aria-busy])').waitFor({ timeout: 30000 })
}

const sidebar = (page) => page.getByRole("navigation", { name: "Sessions" })
/**
 * Elements whose `title` is `text`. The app's own tooltips (src/components/title-tooltips.ts) move
 * `title` to `data-sd-title` once the pointer has been over an element, so both count.
 */
const titled = (text) => `:is([title="${text}"], [data-sd-title="${text}"])`
/** A session's row in the sidebar, by its exact title. */
const row = (page, title) => sidebar(page).locator(`[data-sidebar="menu-button"]${titled(title)}`)
const glyphLabel = (page, title) => row(page, title).getByRole("img").getAttribute("aria-label")

// ---------------------------------------------------------------- tests
test("overview: repo columns, session cards and the need-you chip", async (page) => {
  for (const repo of ["api-gateway", "web-app", "ticketing", "llm-router", "infra"]) {
    const col = page.getByRole("region", { name: repo, exact: true })
    await col.waitFor()
    assert((await col.getByRole("heading", { name: repo }).count()) === 1, `column ${repo} has no heading`)
    assert((await col.getByRole("button", { name: /^Open / }).count()) > 0, `column ${repo} has no session cards`)
  }
  assert(await page.getByRole("button", { name: `Open ${IDLE}`, exact: true }).isVisible(), `no card for "${IDLE}"`)
  const chip = page.getByRole("button", { name: /^\d+\s*need you$/ })
  await chip.waitFor()
  assert(Number(/\d+/.exec(await chip.innerText())?.[0]) > 0, "need-you chip shows no count")
})

test("session: opening one from the sidebar shows its chat and the composer", async (page) => {
  await row(page, IDLE).click()
  await eventually(async () => (await page.evaluate(() => location.hash)).startsWith("#/session/"), "route did not change to the session")
  const log = page.getByRole("log", { name: "Session transcript" })
  await eventually(async () => (await log.innerText()).includes(IDLE), "transcript does not show the session's first prompt")
  await page.getByRole("textbox", { name: "Message Claude" }).waitFor()
  assert((await row(page, IDLE).getAttribute("aria-current")) === "page", "the opened session's row is not marked current")
})

test("status glyphs: every sidebar glyph is named; sessions at rest say how their work ended", async (page) => {
  const labels = await sidebar(page)
    .getByRole("img")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))
  assert(labels.length >= 10, `only ${labels.length} status glyphs in the sidebar`)
  const unnamed = labels.filter((l) => !l.trim()).length
  assert(!unnamed, `${unnamed} status glyphs without an aria-label`)
  // outcomes of the seeded mock world (src/mocks/world.ts: from each session's id and diff)
  for (const want of ["Done", "Branch merged", /^\d+ commits? not pushed$/]) {
    assert(labels.some((l) => (typeof want === "string" ? l === want : want.test(l))), `no glyph labelled ${want} (labels: ${[...new Set(labels)].join(", ")})`)
  }
  assert(/^\d+ commits? not pushed$/.test(await glyphLabel(page, IDLE)), `"${IDLE}" does not show its unpushed commits`)
})

test("context menu: Open, Rename, Mark as done, Archive; Mark as done and Not done", async (page) => {
  const before = await glyphLabel(page, IDLE)
  await row(page, IDLE).click({ button: "right" })
  const menu = page.getByRole("menu")
  await menu.waitFor()
  for (const name of [/^Open$/, /^Rename/, /^Mark as done$/, /^Archive$/]) {
    assert((await menu.getByRole("menuitem", { name }).count()) === 1, `context menu has no ${name} item`)
  }
  await menu.getByRole("menuitem", { name: "Mark as done" }).click()
  await menu.waitFor({ state: "detached" })
  await eventually(async () => (await glyphLabel(page, IDLE)) === "Marked done", 'glyph did not change to "Marked done"')

  await row(page, IDLE).click({ button: "right" })
  await menu.getByRole("menuitem", { name: "Not done" }).click()
  await eventually(async () => {
    const l = await glyphLabel(page, IDLE)
    return l && l !== "Marked done"
  }, `glyph still says "Marked done" after Not done (was "${before}")`)
})

test("new session: a long typed path keeps its last folder visible in the folder picker", async (page) => {
  await page.getByRole("button", { name: "New session", exact: true }).click()
  const trigger = page.getByRole("button", { name: /^Folder:/ })
  await trigger.click()
  const input = page.getByPlaceholder("Find a project or type a path")
  await input.waitFor()

  // the path as typed, and one so deep that it cannot fit: its middle gives way, never the end
  const deep = `~/Desktop/Git/acme/${"nested-directory/".repeat(8)}feature-order-detail-page`
  for (const path of [LONG_PATH, deep]) {
    await input.fill(path)
    const group = page.getByRole("group", { name: "Open folder" })
    const text = group.getByRole("option").locator(titled(path))
    await eventually(async () => (await text.count()) === 1, `no "Open folder" row for ${path}`)
    const shown = await text.evaluate((el) => {
      const [dir, leaf] = [el.firstElementChild, el.lastElementChild]
      const box = leaf.getBoundingClientRect()
      const outer = el.closest("[role=option]").getBoundingClientRect()
      return {
        leaf: leaf.textContent,
        leafClipped: leaf.scrollWidth > leaf.clientWidth + 1 || box.left < outer.left || box.right > outer.right + 1,
        dirClipped: dir.scrollWidth > dir.clientWidth + 1,
      }
    })
    assert(shown.leaf === "/feature-order-detail-page", `last folder reads "${shown.leaf}"`)
    assert(!shown.leafClipped, `last folder is cut off for ${path}`)
    if (path === deep) assert(shown.dirClipped, "a path too long for the row was not shortened in the middle")
  }
  await page.keyboard.press("Escape")
  await input.waitFor({ state: "detached" })
})

test("settings: every section of the settings dialog opens", async (page) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  const nav = dialog.getByRole("navigation", { name: "Settings sections" })
  await nav.waitFor()
  const pane = nav.locator("xpath=following-sibling::div[1]")
  const sections = await nav.getByRole("button").allInnerTexts()
  assert(sections.length >= 4, `only ${sections.length} settings sections: ${sections.join(", ")}`)
  for (const name of sections) {
    const link = nav.getByRole("button", { name, exact: true })
    await link.click()
    await eventually(async () => (await link.getAttribute("aria-current")) === "page", `section "${name}" is not current after a click`)
    await eventually(async () => (await pane.innerText()).trim().length > 20, `section "${name}" is empty`)
  }
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
})

test("palette and switcher: Ctrl+K searches, Ctrl+Tab lists recent sessions, Escape closes both", async (page) => {
  await page.keyboard.press("Control+k")
  const palette = page.getByRole("dialog", { name: "Search" })
  await palette.waitFor()
  const input = palette.getByPlaceholder("Search sessions and what was said in them")
  await eventually(() => input.evaluate((el) => el === document.activeElement), "search box is not focused")
  await input.fill("hydration")
  await palette.getByRole("option", { name: new RegExp(IDLE) }).first().waitFor()
  await page.keyboard.press("Escape")
  await palette.waitFor({ state: "detached" })

  // two sessions visited, then Ctrl held: the recent list shows; Escape cancels and stays put
  await row(page, IDLE).click()
  await row(page, PAST).click()
  await eventually(async () => (await row(page, PAST).getAttribute("aria-current")) === "page", `"${PAST}" did not open`)
  const where = await page.evaluate(() => location.hash)
  await page.keyboard.down("Control")
  await page.keyboard.press("Tab")
  const recent = page.getByRole("listbox", { name: "Recent sessions" })
  await recent.waitFor()
  assert((await recent.getByRole("option").count()) >= 2, "recent list has fewer than 2 sessions")
  await page.keyboard.press("Escape")
  await recent.waitFor({ state: "detached" })
  await page.keyboard.up("Control")
  assert((await page.evaluate(() => location.hash)) === where, "Escape in the switcher still switched sessions")
})

test("rename: F2 and double-click open an input; Escape keeps the title", async (page) => {
  const name = page.getByRole("textbox", { name: "Session name" })
  for (const start of ["F2", "double-click"]) {
    if (start === "F2") {
      await row(page, PAST).focus()
      await page.keyboard.press("F2")
    } else {
      await row(page, PAST).dblclick()
    }
    await name.waitFor()
    await eventually(() => name.evaluate((el) => el === document.activeElement), `${start}: the name input is not focused`)
    assert((await name.inputValue()) === PAST, `${start}: the input does not start from the title`)
    await name.fill("Something else entirely")
    await page.keyboard.press("Escape")
    await name.waitFor({ state: "detached" })
    assert((await row(page, PAST).count()) === 1, `${start}: Escape changed the title`)
    assert((await sidebar(page).locator(titled("Something else entirely")).count()) === 0, `${start}: the draft title was kept`)
  }
})

// ---------------------------------------------------------------- runner
const selected = tests.filter((t) => !ONLY.length || ONLY.some((o) => t.name.includes(o)))
const browser = await chromium.launch({ executablePath: chromiumPath() })
let failed = 0
const started = Date.now()
for (const t of selected) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const problems = []
  page.on("console", (m) => m.type() === "error" && problems.push(`console error: ${m.text()}`))
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`))
  const t0 = Date.now()
  try {
    await load(page)
    await Promise.race([t.fn(page), new Promise((_, reject) => setTimeout(() => reject(new Fail("timed out after 30 s")), 30000))])
    if (problems.length) throw new Fail(problems.join("\n    "))
    console.log(`PASS  ${t.name} (${Date.now() - t0} ms)`)
  } catch (e) {
    failed++
    mkdirSync(SHOTS, { recursive: true })
    const shot = join(SHOTS, `${t.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`)
    await page.screenshot({ path: shot }).catch(() => {})
    const why = [e instanceof Fail ? e.message : (e?.stack ?? String(e)), ...problems.filter((p) => !String(e?.message).includes(p))]
    console.log(`FAIL  ${t.name} (${Date.now() - t0} ms)\n    ${why.join("\n    ")}\n    screenshot: ${shot}`)
  } finally {
    await context.close().catch(() => {})
  }
}
await browser.close()
console.log(`\n${selected.length - failed}/${selected.length} passed in ${((Date.now() - started) / 1000).toFixed(1)} s`)
process.exit(failed ? 1 : 0)
