// UI regression tests: the app's mock world (src/mocks/world.ts) in headless Chromium, with
// Playwright. Every flow a user goes through in the browser preview: the overview, sessions and
// their chat, answering requests, new sessions, archive, pins, workspaces, History, Review, Usage,
// settings, keys and a narrow window.
//
//   bun run test:ui                 starts Vite, runs these, stops Vite (tests/ui/run.mjs)
//   node tests/ui/smoke.mjs [name…] against a server already running at UI_BASE; names filter
//                                   tests by substring
//
//   UI_BASE      the app's URL (default http://127.0.0.1:5191/)
//   UI_WORKERS   tests run side by side in this many browser contexts (default 3)
//   UI_TRACE     failed (default): a failed test runs once more with a Playwright trace (open with
//                `bunx playwright show-trace <file>`); all: every test traced; off: no traces
//   PW_CHROMIUM  the Chromium (headless shell) binary; default: the newest one Playwright
//                downloaded to ~/.cache/ms-playwright, else the system's Google Chrome
//
// How the tests stay reliable (after Playwright's own guidance: playwright.dev/docs/best-practices,
// /docs/actionability, /docs/test-assertions, /docs/trace-viewer):
// - each test is independent: a fresh browser context (fresh storage, a fresh mock world), its
//   own settings seeded through localStorage when it needs them, no order between tests;
// - elements are found the way a user finds them: by role and accessible name or label, rarely by
//   CSS, by position only where the order is what is tested;
// - no fixed sleeps: actions auto-wait for actionable elements, and every check is a retrying
//   ("web-first") assertion that polls until it holds or times out (see expect* below);
// - the mock engine keeps changing the working sessions, and every ~50 s one of them starts
//   waiting: tests use sessions at rest (idle or past: the engine never touches those), and tests
//   that count turn the engine off (?engine=off);
// - any console error or uncaught page error fails the test;
// - a failure leaves a screenshot, and a trace of the test run once more, in $TMPDIR/sd-ui-smoke
//   (tracing every test is slow; a pass on that second run is reported as flaky, still a failure).
import { chromium } from "playwright"
import { existsSync, globSync, mkdirSync } from "node:fs"
import { cpus, homedir, tmpdir } from "node:os"
import { join } from "node:path"

const BASE = process.env.UI_BASE ?? "http://127.0.0.1:5191/"
const APP = new URL("?mock&debug=off", BASE).href
const SHOTS = join(tmpdir(), "sd-ui-smoke")
const ONLY = process.argv.slice(2)
const WORKERS = Math.max(1, Number(process.env.UI_WORKERS ?? Math.min(3, Math.ceil(cpus().length / 4))))
const TRACE = process.env.UI_TRACE ?? "failed"

/** PW_CHROMIUM, else the newest headless shell in Playwright's cache, else the system's Chrome, else Playwright's default. */
function browserOptions() {
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright")
  const rev = (p) => Number(/chromium_headless_shell-(\d+)/.exec(p)?.[1] ?? 0)
  const found = globSync("chromium_headless_shell-*/*/chrome-headless-shell", { cwd: cache }).sort((a, b) => rev(b) - rev(a))
  if (found.length) return { executablePath: join(cache, found[0]) }
  // the shared browser cache can be pruned by another project's `playwright install`
  if (["/usr/bin/google-chrome", "/opt/google/chrome/chrome"].some(existsSync) || process.platform !== "linux") return { channel: "chrome" }
  return {}
}

// Stable sessions of the mock world (seeded, so the same every load). None is ever working, so
// the mock engine leaves them alone.
const IDLE = "Fix hydration warning on tickets page" // live, idle, web-app
const PAST = "Clean up logging" // past (stopped), infra
const SPARE = "Rewrite pricing page copy (shorter variant)" // live, idle, web-app (a fork)
const YESTERDAY = "Rate limiting for /v1/chat" // past, api-gateway
// finished while you were elsewhere (world.ts: looked at 5 minutes after it started, Claude wrote since)
const UNREAD = "Accept ticket v3 payloads on /v2/tickets"
const LONG_PATH ="~/Desktop/Git/acme/frontend-worktrees/feature-order-detail-page"
// waiting for you (world.ts SCRIPT): each kind of request once
const PERM_BASH = "Fix auth retry double-counting attempts" // api-gateway: Bash `npm test -- retry`
const PERM_EDIT = "Update model mapping for opus-5.5" // llm-router: Edit router/mapping.py
const QUESTION = "Rewrite pricing page copy" // web-app: two questions
const PLAN = "Bump Postgres to 17 in staging" // infra: a plan to approve
const MAIN = "Roll out ticket-schema v3 across repos" // the main agent, first in the list
const REPOS = ["api-gateway", "web-app", "ticketing", "llm-router", "infra"]
// with the engine off: who needs you, per repo (permission, question, plan, error, a subagent's permission)
const NEEDS = { "api-gateway": 1, "web-app": 1, ticketing: 2, "llm-router": 1, infra: 1 }
const NEEDS_ALL = Object.values(NEEDS).reduce((a, b) => a + b, 0)
/** Settings with one workspace, Work = api-gateway and web-app, shown. */
const WORK = {
  workspaces: [{ id: "work", name: "Work", repos: ["api-gateway", "web-app"].map((n) => ({ key: `github.com/acme/${n}`, name: n })) }],
  workspace: "work",
}

// ---------------------------------------------------------------- harness
const tests = []
/**
 * A test. `opts`: `query` added to the app's URL (like "&engine=off"), `viewport`, `settings`
 * stored before the app starts, `ready` what to wait for after loading ("sessions": the session
 * list, the default; "overview": the overview's columns, for a window too narrow for the list).
 */
const test = (name, fn, opts = {}) => tests.push({ name, fn, opts })

class Fail extends Error {}
function assert(cond, message) {
  if (!cond) throw new Fail(message)
}

/** Poll `fn` until it returns something truthy; fail with `message` (and the last value) if it never does. */
async function eventually(fn, message, timeout = 10000) {
  const end = Date.now() + timeout
  let last
  for (;;) {
    last = await fn().catch((e) => e)
    if (last && !(last instanceof Error)) return last
    if (Date.now() > end) throw new Fail(`${message} (last: ${last instanceof Error ? last.message.split("\n")[0] : JSON.stringify(last)})`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

// Retrying assertions on locators ("web-first": they wait for the page to get there).
async function expectVisible(locator, message, timeout = 10000) {
  await locator.waitFor({ state: "visible", timeout }).catch((e) => {
    throw new Fail(`${message} (${e.message.split("\n")[0]})`)
  })
}
async function expectHidden(locator, message, timeout = 10000) {
  await locator.waitFor({ state: "hidden", timeout }).catch((e) => {
    throw new Fail(`${message} (${e.message.split("\n")[0]})`)
  })
}
/** Poll `fn` until its value matches `want` (a value, a RegExp or a predicate); fail with the last value. */
async function expectValue(fn, want, message, timeout = 10000) {
  const ok = (v) => (want instanceof RegExp ? want.test(String(v ?? "")) : typeof want === "function" ? want(v) : v === want)
  const end = Date.now() + timeout
  let last
  for (;;) {
    last = await fn().catch((e) => e)
    if (!(last instanceof Error) && ok(last)) return last
    if (Date.now() > end) {
      const shown = last instanceof Error ? last.message.split("\n")[0] : JSON.stringify(last)
      throw new Fail(`${message} (last: ${shown?.length > 300 ? `${shown.slice(0, 300)}…` : shown})`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}
const expectCount = (locator, n, message) => expectValue(() => locator.count(), n, `${message}: want ${n}`)
const expectAttr = (locator, name, want, message) => expectValue(() => locator.getAttribute(name, { timeout: 1000 }), want, `${message} [${name}]`)
const expectText = (locator, want, message) => expectValue(() => locator.innerText({ timeout: 1000 }), typeof want === "string" ? (t) => t.includes(want) : want, message)

/** Load the app's mock world and wait until it is on screen. */
async function load(page, opts = {}) {
  const timeout = opts.timeout ?? 60000
  await page.goto(APP + (opts.query ?? ""), { timeout })
  if (opts.ready === "overview") await page.getByRole("region", { name: REPOS[0], exact: true }).waitFor({ timeout })
  else await page.locator('nav[aria-label="Sessions"]:not([aria-busy])').waitFor({ timeout })
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
/** A project's group of rows in the sidebar. */
const group = (page, name) => sidebar(page).locator(`[data-sidebar="group"][aria-label="${name}"]`)
/** The ⋯ menu of a session's row. */
async function rowMenu(page, title) {
  const item = sidebar(page).getByRole("listitem").filter({ has: page.locator(`[data-sidebar="menu-button"]${titled(title)}`) })
  await row(page, title).hover()
  await item.getByRole("button", { name: "Session actions" }).click()
  const menu = page.getByRole("menu")
  await menu.waitFor()
  return menu
}
const hash = (page) => page.evaluate(() => location.hash)
const transcript = (page) => page.getByRole("log", { name: "Session transcript" })
const composer = (page) => page.getByRole("textbox", { name: "Message Claude" })
/** Open a session from the sidebar and wait until it is the current one. */
async function openSession(page, title) {
  await row(page, title).click()
  await expectAttr(row(page, title), "aria-current", "page", `"${title}" did not open`)
  await eventually(async () => (await hash(page)).startsWith("#/session/"), "route did not change to the session")
}
/** The top bar's "N need you" count; 0 when it is hidden. */
async function needYou(page) {
  const chip = page.getByRole("button", { name: /^\d+\s*need you$/ })
  return (await chip.count()) ? Number(/\d+/.exec(await chip.innerText())?.[0]) : 0
}
/** The overview's card of a session. */
const card = (page, title) => page.getByRole("button", { name: `Open ${title}`, exact: true }).locator("..")
async function openSettingsPage(page, name) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name, exact: true }).click()
  await expectVisible(dialog.getByRole("heading", { name, level: 2 }).last(), `settings page "${name}" did not open`)
  return dialog
}
/** Whether the page scrolls sideways (the document or the app's own panels). */
const sideways = (page) =>
  page.evaluate(() => {
    const doc = document.scrollingElement
    const over = [doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - document.body.clientWidth]
    return Math.max(...over) > 1 ? `document ${over.join("/")} px too wide` : ""
  })

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

test("bash mode: ! runs a command into the chat; an editor is offered the terminal", async (page) => {
  await row(page, IDLE).click()
  const box = page.getByRole("textbox", { name: "Message Claude" })
  const log = page.getByRole("log", { name: "Session transcript" })
  await box.waitFor()
  // "!" in an empty box is bash mode; the mock world says nothing ran (the app runs it in the folder)
  await box.fill("!")
  await box.pressSequentially("git status")
  await page.keyboard.press("Enter")
  await eventually(async () => (await log.innerText()).includes("! git status"), "the command does not show in the chat")
  await eventually(async () => (await log.innerText()).includes("Mock world: nothing ran"), "the command's output does not show")
  assert((await box.inputValue()) === "", "the box was not cleared")
  // an interactive program is not run here: one click opens it in the terminal
  await box.fill("! vim notes.md")
  await page.keyboard.press("Enter")
  await log.getByRole("button", { name: "Open in terminal" }).waitFor()
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

test("unread: bold with a filled glyph until opened; the chat opens at a line where the new part starts", async (page) => {
  // the live one (a past session of the same task is further down the list)
  const at = (title) => row(page, title).first()
  const label = (title) => at(title).getByRole("img").getAttribute("aria-label")
  const weight = (title) => at(title).locator("span.truncate").evaluate((el) => Number(getComputedStyle(el).fontWeight))
  const fill = (title) => at(title).locator("svg").evaluate((el) => el.getAttribute("fill"))
  assert((await label(UNREAD))?.endsWith(", unread"), `"${UNREAD}" is not unread: ${await label(UNREAD)}`)
  assert((await weight(UNREAD)) >= 500, `"${UNREAD}" is unread but its title is not bold`)
  assert(!["none", null].includes(await fill(UNREAD)), `"${UNREAD}" is unread but its glyph is not filled`)
  assert(!(await label(IDLE))?.includes("unread") && (await weight(IDLE)) < 500 && (await fill(IDLE)) === "none", `"${IDLE}" was read but looks unread`)

  // opened: a line before the first message newer than your last look, on screen (not scrolled past to the end)
  await at(UNREAD).click()
  await eventually(async () => (await at(UNREAD).getAttribute("aria-current")) === "page", `"${UNREAD}" did not open`)
  const where = await page.evaluate(() => location.hash)
  const log = page.getByRole("log", { name: "Session transcript" })
  const line = log.getByRole("separator", { name: "New since you last looked" })
  await line.waitFor()
  await eventually(async () => {
    const [l, b] = [await line.boundingBox(), await log.boundingBox()]
    return l && b && l.y >= b.y && l.y + l.height <= b.y + b.height
  }, "the new-since line is not in view when the chat opens")
  const older = await log.evaluate((box) => {
    const slot = box.querySelector("[data-new-since]").closest("[data-row-key]")
    const first = box.querySelector("[data-row-key]")
    return first !== slot && !!(first.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  assert(older, "the new-since line has no older messages above it")
  // seen now: the mark goes, the line stays while the chat is open
  await eventually(async () => !(await label(UNREAD))?.includes("unread"), "opening the session did not mark it read")
  assert((await line.count()) === 1, "the line went while the chat is open")

  // the next visit with nothing new: no line
  await row(page, IDLE).click()
  await eventually(async () => (await row(page, IDLE).getAttribute("aria-current")) === "page", `"${IDLE}" did not open`)
  assert((await weight(UNREAD)) < 500 && (await fill(UNREAD)) === "none", "still bold or filled after it was opened")
  await at(UNREAD).click()
  await eventually(async () => (await page.evaluate(() => location.hash)) === where, `"${UNREAD}" did not open again`)
  await eventually(async () => (await log.getByRole("separator", { name: "New since you last looked" }).count()) === 0, "the line is still there on a visit with nothing new")
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


// ---------------------------------------------------------------- chat
test("chat: a message sent to a session at rest shows in the chat and Claude's reply streams in", async (page) => {
  await openSession(page, IDLE)
  const box = composer(page)
  const log = transcript(page)
  const text = "Please also cover the empty-state branch with a test"
  await box.fill(text)
  await page.keyboard.press("Enter")
  await expectText(log, text, "the sent message does not show in the chat")
  await expectValue(() => box.inputValue(), "", "the prompt box was not cleared")
  await expectValue(() => glyphLabel(page, IDLE), "Working", "the session does not say it is working")
  // the mock reply ("On it —") keeps growing while the session works
  const reply = log.getByText(/^On it —/).last()
  await expectVisible(reply, "no reply from Claude")
  const first = (await reply.innerText()).length
  await expectValue(async () => (await reply.innerText()).length, (n) => n > first, "the reply does not stream")
})

test("chat: a link asks before it opens, and Esc closes that; no web view menu on a right-click", async (page) => {
  await openSession(page, IDLE)
  const link = transcript(page).getByRole("button", { name: "#42" }).last()
  await expectVisible(link, "no link in Claude's answer")
  await link.click()
  const dialog = page.getByRole("dialog", { name: "Open link?" })
  await expectText(dialog, "https://example.com/acme/web-app/issues/42", "the dialog does not show where the link goes")
  await page.keyboard.press("Escape")
  await expectHidden(dialog, "Esc did not close the link dialog")
  const prevented = await link.evaluate((el) => !el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))
  assert(prevented, "a right-click on the chat shows the web view's own menu")
})

test("chat: a quote in Claude's answer copies on its own, lists with their dashes", async (page) => {
  await openSession(page, IDLE)
  await page.evaluate(() => {
    window.__copied = ""
    navigator.clipboard.writeText = async (t) => void (window.__copied = t)
  })
  const quote = transcript(page).locator("blockquote").last()
  await expectVisible(quote, "no quote in Claude's answer")
  await quote.hover()
  if (process.env.UI_SHOTS) await quote.screenshot({ path: process.env.UI_SHOTS + "/quote.png" })
  await quote.getByRole("button", { name: "Copy quote" }).click()
  await expectValue(() => page.evaluate(() => window.__copied), "Shipped today:\n\n- the retry fix\n- its regression test", "the quote's Copy copied something else")
})

test("chat: reading up a reply pins its prompt as one whole line, more of it under the pointer", async (page) => {
  await openSession(page, IDLE)
  const scroller = transcript(page)
  const pinned = page.getByRole("button", { name: "Scroll to your message" })
  // read an earlier reply: its prompt scrolled out above, the end of the chat out below
  await expectValue(async () => {
    await scroller.evaluate((el) => {
      const prompts = [...el.querySelectorAll('[data-msg="user"]')]
      const p = prompts.at(-2) ?? prompts.at(-1)
      if (p) el.scrollTop += p.getBoundingClientRect().bottom - el.getBoundingClientRect().top + 60
      el.dispatchEvent(new Event("scroll"))
    })
    return pinned.isVisible()
  }, true, "the prompt is not pinned while its reply is read")
  const h = await pinned.evaluate((el) => el.getBoundingClientRect().height)
  assert(h <= 34, `the pinned prompt is ${h}px tall, more than one line`)
  if (process.env.UI_SHOTS) await page.screenshot({ path: process.env.UI_SHOTS + "/pinned.png", clip: { x: 300, y: 0, width: 1140, height: 200 } })
  await pinned.hover()
  await expectValue(() => pinned.evaluate((el) => el.getBoundingClientRect().height), (v) => v >= h - 1, "the pinned prompt shrank under the pointer")
  if (process.env.UI_SHOTS) await page.screenshot({ path: process.env.UI_SHOTS + "/pinned-hover.png", clip: { x: 300, y: 0, width: 1140, height: 200 } })
})

test("chat: a message sent while Claude works waits in the queue, and can be removed", async (page) => {
  await openSession(page, IDLE)
  const box = composer(page)
  await box.fill("First, look at the hydration warning")
  await page.keyboard.press("Enter")
  await expectValue(() => glyphLabel(page, IDLE), "Working", "the session does not say it is working")
  await box.fill("Then check the SSR logs too")
  await page.keyboard.press("Enter")
  const queue = page.getByRole("region", { name: "Queued messages" })
  await expectText(queue, "Then check the SSR logs too", "the second message is not queued")
  await queue.getByRole("button", { name: "Remove from queue" }).click()
  await expectHidden(queue, "the queued message was not removed")
  assert(!(await transcript(page).innerText()).includes("Then check the SSR logs too"), "the removed message was still sent")
})

// ---------------------------------------------------------------- requests
test("requests: Allow once and Deny on overview cards answer the permission", async (page) => {
  const before = await needYou(page)
  assert(before === NEEDS_ALL, `need-you count is ${before}, want ${NEEDS_ALL}`)
  const bash = card(page, PERM_BASH)
  await bash.getByRole("button", { name: "Allow once" }).click()
  await expectCount(bash.getByRole("button", { name: "Allow once" }), 0, "the card still offers Allow once")
  await expectValue(() => glyphLabel(page, PERM_BASH), "Working", "the allowed session does not work again")
  await expectText(bash, "Running npm test -- retry", "the card does not say the command runs")
  await expectValue(() => needYou(page), before - 1, "the need-you count did not go down")

  const edit = card(page, PERM_EDIT)
  await edit.getByRole("button", { name: "Deny" }).click()
  await expectCount(edit.getByRole("button", { name: "Deny" }), 0, "the card still offers Deny")
  await expectText(edit, "Rethinking after denial", "the card does not say Claude rethinks")
  await expectValue(() => needYou(page), before - 2, "the need-you count did not go down again")
}, { query: "&engine=off" })

test("requests: the permission card in a session allows once, or denies with what to do instead", async (page) => {
  await openSession(page, PERM_BASH)
  const req = page.getByRole("region", { name: /^Permission request/ })
  await expectText(req, "npm test -- retry", "the card does not show the command")
  await req.getByRole("button", { name: "Allow once", exact: true }).click()
  await expectHidden(req, "the card stayed after Allow once")
  await expectValue(() => glyphLabel(page, PERM_BASH), "Working", "the session does not work again")
  await expectVisible(composer(page), "the prompt box did not come back")

  await openSession(page, PERM_EDIT)
  const edit = page.getByRole("region", { name: /^Permission request/ })
  await edit.getByRole("button", { name: "More deny options" }).click()
  await page.getByRole("menuitem", { name: "Tell Claude what to do instead" }).click()
  const why = edit.getByRole("textbox", { name: "Tell Claude what to do instead" })
  await why.fill("Keep the old mapping as an alias")
  await edit.getByRole("button", { name: "Deny", exact: true }).click()
  await expectHidden(edit, "the card stayed after Deny")
  await expectValue(() => glyphLabel(page, PERM_EDIT), "Working", "the denied session does not go on")
  await page.getByRole("button", { name: "Overview", exact: true }).click()
  await expectText(card(page, PERM_EDIT), "Revising: Keep the old mapping as an alias", "Claude was not told what to do instead")
})

test("requests: Escape on a focused permission card denies it", async (page) => {
  await openSession(page, PERM_BASH)
  const req = page.getByRole("region", { name: /^Permission request/ })
  await expectVisible(req, "no permission card")
  // the card's keys arm 400 ms after it shows (a key already on its way cannot answer it)
  await req.focus()
  await expectValue(async () => {
    await page.keyboard.press("Escape")
    return req.count()
  }, 0, "Escape did not deny the request", 5000)
  await expectValue(() => glyphLabel(page, PERM_BASH), "Working", "the session does not go on")
})

test("requests: a question is answered option by option and submitted", async (page) => {
  await openSession(page, QUESTION)
  const q = page.getByRole("region", { name: "Question from Claude" })
  await expectVisible(q.getByRole("radiogroup", { name: "Where should the new pricing copy go live first?" }), "the first question is not shown")
  await q.getByRole("radio", { name: /Staging only/ }).click()
  // a single choice answers at once and moves on to the next question
  const locales = q.getByRole("group", { name: "Which locales should I update?" }).or(q.locator('[aria-label="Which locales should I update?"]'))
  await expectVisible(locales.first(), "the second question is not shown")
  await q.getByRole("checkbox", { name: /^\S*\s*en\b/ }).click()
  await q.getByRole("checkbox", { name: /^\S*\s*de\b/ }).click()
  await expectText(q, "2 selected", "the two picks are not counted")
  await q.getByRole("button", { name: "Submit" }).click()
  await expectHidden(q, "the question stayed after Submit")
  await expectValue(() => glyphLabel(page, QUESTION), "Working", "the session does not go on")
  await page.getByRole("button", { name: "Overview", exact: true }).click()
  await expectText(card(page, QUESTION), "Continuing with: Staging only", "Claude did not get the answer")
})

test("requests: a plan is approved with Accept and allow edits, which switches the mode", async (page) => {
  await openSession(page, PLAN)
  const plan = page.getByRole("region", { name: /^Plan approval/ })
  await expectText(plan, "Upgrade staging Postgres 16 → 17", "the plan is not shown")
  await expectVisible(page.getByRole("button", { name: "Mode: Plan" }), "the session is not in plan mode")
  await plan.getByRole("button", { name: "Accept and allow edits" }).click()
  await expectHidden(plan, "the plan card stayed after it was accepted")
  await expectVisible(page.getByRole("button", { name: "Mode: Accept edits" }), "the mode did not switch to Accept edits")
  await expectValue(() => glyphLabel(page, PLAN), "Working", "the session does not carry out the plan")
})

// ---------------------------------------------------------------- new session
test("new session: folder, model, effort, mode and a prompt start a session that opens and is listed", async (page) => {
  await page.getByRole("button", { name: "New session", exact: true }).click()
  await expectValue(() => hash(page), "#/new", "the New session screen did not open")
  await page.getByRole("button", { name: /^Folder:/ }).click()
  await page.getByRole("listbox", { name: "Suggestions" }).getByRole("option", { name: /^infra\b/ }).click()
  await expectVisible(page.getByRole("heading", { name: /New session in infra/ }), "the folder was not picked")

  await page.getByRole("button", { name: /^Model:/ }).click()
  await page.getByRole("menuitemradio", { name: /^Sonnet 5\.5/ }).click()
  await expectVisible(page.getByRole("button", { name: "Model: Sonnet 5.5" }), "the model was not picked")

  await page.getByRole("button", { name: /^Effort:/ }).click()
  const slider = page.getByRole("slider", { name: "Effort" })
  await slider.focus()
  await page.keyboard.press("Home")
  await page.keyboard.press("Escape")
  await expectVisible(page.getByRole("button", { name: /^Effort: Low/ }), "the effort was not set to Low")

  await page.getByRole("button", { name: /^Mode:/ }).click()
  await page.getByRole("option", { name: /^Plan\b/ }).click()
  await expectVisible(page.getByRole("button", { name: "Mode: Plan" }), "the mode was not picked")

  const prompt = "Add a smoke test for the deploy script"
  await composer(page).fill(prompt)
  await page.keyboard.press("Enter")
  await eventually(async () => (await hash(page)).startsWith("#/session/"), "the new session did not open")
  await expectAttr(row(page, prompt), "aria-current", "page", "the new session is not listed as the current one")
  await expectCount(group(page, "infra").locator(`[data-sidebar="menu-button"]${titled(prompt)}`), 1, "the new session is not under infra")
  await expectText(transcript(page), prompt, "the chat does not start with the prompt")
  for (const name of ["Model: Sonnet 5.5", "Mode: Plan", /^Effort: Low/]) {
    await expectVisible(page.getByRole("button", { name }), `the session does not keep ${name}`)
  }
  // starting → working (actions.ts: after 1.2 s)
  await expectValue(() => glyphLabel(page, prompt), "Working", "the new session does not start working")
})

// ---------------------------------------------------------------- archive, pins
test("archive: Archive hides the session, Undo brings it back; History lists the archived ones", async (page) => {
  await row(page, SPARE).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Archive" }).click()
  await expectCount(row(page, SPARE), 0, "the archived session is still listed")
  const notice = page.getByRole("region", { name: "Notifications" })
  await expectText(notice, "Archived", "no Archived notice")
  await notice.getByRole("button", { name: "Undo" }).click()
  await expectCount(row(page, SPARE), 1, "Undo did not bring the session back")

  // archived again from the row's ⋯ menu: it is in History → Archived
  await (await rowMenu(page, SPARE)).getByRole("menuitem", { name: "Archive" }).click()
  await expectCount(row(page, SPARE), 0, "the session is still listed after Archive from the ⋯ menu")
  await page.getByRole("button", { name: "History", exact: true }).click()
  await page.getByRole("tab", { name: "Archived" }).click()
  await expectAttr(page.getByRole("tab", { name: "Archived" }), "aria-selected", "true", "the Archived tab is not selected")
  await expectVisible(page.getByRole("listbox", { name: "Sessions" }).getByRole("option", { name: new RegExp(SPARE.replace(/[()]/g, "\\$&")) }), "the archived session is not in History → Archived")
})

test("pin: Pin puts a session in the Pinned group, Unpin takes it out", async (page) => {
  const pinned = sidebar(page).locator('[data-sidebar="group"][aria-label="Pinned"]')
  const inPinned = pinned.locator(`[data-sidebar="menu-button"]${titled(PAST)}`)
  await expectCount(inPinned, 0, "the session starts pinned")
  await (await rowMenu(page, PAST)).getByRole("menuitem", { name: "Pin" }).click()
  await expectCount(inPinned, 1, "the pinned session is not in the Pinned group")
  await (await rowMenu(page, PAST)).getByRole("menuitem", { name: "Unpin" }).click()
  await expectCount(inPinned, 0, "the session is still in the Pinned group after Unpin")
  await expectCount(row(page, PAST), 1, "the unpinned session is not back in its project")
})

// ---------------------------------------------------------------- workspaces
test("workspaces: New workspace picks repos; the switcher shows each workspace's need-you count", async (page) => {
  const switcher = page.getByRole("button", { name: /^Workspace:/ })
  await switcher.click()
  await page.getByRole("menuitem", { name: /New workspace/ }).click()
  const dialog = page.getByRole("dialog", { name: "New workspace" })
  const create = dialog.getByRole("button", { name: "Create" })
  assert(await create.isDisabled(), "Create is enabled with no name and no repos")
  await dialog.getByRole("textbox", { name: "Workspace name" }).fill("Work")
  assert(await create.isDisabled(), "Create is enabled with no repos")
  await dialog.getByRole("textbox", { name: "Find a repository" }).fill("web")
  await expectCount(dialog.getByRole("checkbox"), 1, "the repository filter does not narrow the list")
  await dialog.getByRole("checkbox", { name: /^web-app/ }).click()
  await dialog.getByRole("textbox", { name: "Find a repository" }).fill("")
  await dialog.getByRole("checkbox", { name: /^api-gateway/ }).click()
  await expectText(dialog, "2 picked", "the picks are not counted")
  await create.click()
  await expectHidden(dialog, "the dialog stayed after Create")

  // the new workspace is shown: its repos only, its own count, the rest waiting elsewhere
  await expectAttr(switcher, "aria-label", "Workspace: Work", "the new workspace is not the shown one")
  for (const name of REPOS) await expectCount(group(page, name), ["api-gateway", "web-app"].includes(name) ? 1 : 0, `sidebar group ${name}`)
  const mine = NEEDS["api-gateway"] + NEEDS["web-app"]
  await expectValue(() => needYou(page), mine, "the need-you count is not the workspace's")
  await expectText(switcher, `${NEEDS_ALL - mine} waiting in other workspaces`, "the switcher does not say what waits elsewhere")
  await switcher.click()
  await expectVisible(page.getByRole("menuitem", { name: new RegExp(`^Work\\s*${mine} need you`) }), "the menu does not show Work's count")
  await page.getByRole("menuitem", { name: "All workspaces" }).click()
  await expectAttr(switcher, "aria-label", "Workspace: All", "All workspaces is not shown")
  for (const name of REPOS) await expectCount(group(page, name), 1, `sidebar group ${name} under All workspaces`)
  await expectValue(() => needYou(page), NEEDS_ALL, "the need-you count is not everyone's")
  // Alt+1: the first workspace
  await page.keyboard.press("Alt+1")
  await expectAttr(switcher, "aria-label", "Workspace: Work", "Alt+1 did not show the first workspace")
}, { query: "&engine=off" })

test("workspaces: Edit workspace removes a repo on Save, keeps it on Cancel; Delete shows everything", async (page) => {
  await expectCount(group(page, "web-app"), 1, "the seeded workspace does not show web-app")
  await expectCount(group(page, "infra"), 0, "the seeded workspace shows infra")
  await page.getByRole("button", { name: /^Workspace:/ }).click()
  await page.getByRole("menuitem", { name: "Edit workspaces" }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await expectText(settings, "Workspaces", "Edit workspaces does not open the workspaces")
  const edit = page.getByRole("dialog", { name: "Edit Work" })
  const webApp = edit.getByRole("checkbox", { name: /^web-app/ })

  await settings.getByRole("button", { name: "Edit", exact: true }).click()
  await expectAttr(webApp, "aria-checked", "true", "web-app is not picked in the workspace")
  await webApp.click()
  await expectAttr(webApp, "aria-checked", "false", "web-app did not get unpicked")
  await edit.getByRole("button", { name: "Cancel" }).click()
  await expectHidden(edit, "Cancel did not close the dialog")
  // (the session list is behind the modal Settings dialog, out of the accessibility tree: the
  // workspace's row in Settings tells meanwhile)
  await expectText(settings, "2 repos", "Cancel still changed the workspace")

  await settings.getByRole("button", { name: "Edit", exact: true }).click()
  await webApp.click()
  await edit.getByRole("button", { name: "Save" }).click()
  await expectHidden(edit, "Save did not close the dialog")
  await expectText(settings, "1 repo", "the workspace row does not say 1 repo after Save")
  await page.keyboard.press("Escape")
  await expectHidden(settings, "Escape did not close Settings")
  await expectCount(group(page, "web-app"), 0, "Save did not remove web-app")
  await expectCount(group(page, "api-gateway"), 1, "Save removed api-gateway too")

  await page.getByRole("button", { name: /^Workspace:/ }).click()
  await page.getByRole("menuitem", { name: "Edit workspaces" }).click()
  await settings.getByRole("button", { name: "Delete Work" }).click()
  await expectCount(settings.getByRole("button", { name: "Delete Work" }), 0, "the workspace was not deleted")
  await page.keyboard.press("Escape")
  await expectHidden(settings, "Escape did not close Settings")
  await expectAttr(page.getByRole("button", { name: /^Workspace:/ }), "aria-label", "Workspace: All", "deleting the shown workspace did not show everything")
  for (const name of REPOS) await expectCount(group(page, name), 1, `sidebar group ${name} after Delete`)
}, { query: "&engine=off", settings: WORK })

// ---------------------------------------------------------------- history, palette
test("history: search finds a past session, the project filter narrows, a click opens it", async (page) => {
  await page.getByRole("button", { name: "History", exact: true }).click()
  await expectValue(() => hash(page), "#/history", "History did not open")
  const list = page.getByRole("listbox", { name: "Sessions" })
  const opt = (title) => list.getByRole("option", { name: new RegExp(title.replace(/[/()]/g, "\\$&")) })
  await page.getByRole("combobox", { name: "Project" }).selectOption({ label: "infra" })
  await expectVisible(opt(PAST), `"${PAST}" is not listed under infra`)
  await expectCount(opt(YESTERDAY), 0, "an api-gateway session is listed under infra")
  await page.getByRole("combobox", { name: "Project" }).selectOption({ label: "All projects" })

  await page.getByRole("textbox", { name: "Search sessions" }).fill("rate limiting for")
  await expectVisible(opt(YESTERDAY), `search does not find "${YESTERDAY}"`)
  await expectCount(opt(PAST), 0, "search keeps sessions that do not match")
  await opt(YESTERDAY).first().click()
  await eventually(async () => (await hash(page)).startsWith("#/session/"), "the past session did not open")
  await expectText(transcript(page), YESTERDAY, "the chat of the past session does not show")
})

test("palette: a search result opens its session with Enter", async (page) => {
  await page.keyboard.press("Control+k")
  const palette = page.getByRole("dialog", { name: "Search" })
  const input = palette.getByPlaceholder("Search sessions and what was said in them")
  await input.fill("PodDisruptionBudget")
  await expectVisible(palette.getByRole("option", { name: /PodDisruptionBudget for the gateway/ }).first(), "no result")
  await page.keyboard.press("Enter")
  await expectHidden(palette, "the palette stayed open")
  await expectAttr(row(page, "PodDisruptionBudget for the gateway"), "aria-current", "page", "Enter did not open the session")
})

test("rename: F2, a new name and Enter rename the session in the list and the header", async (page) => {
  await openSession(page, SPARE)
  await row(page, SPARE).focus()
  await page.keyboard.press("F2")
  const name = page.getByRole("textbox", { name: "Session name" })
  await name.fill("Shorter pricing copy")
  await page.keyboard.press("Enter")
  await expectHidden(name, "the name input stayed")
  await expectCount(row(page, "Shorter pricing copy"), 1, "the list does not show the new name")
  await expectCount(row(page, SPARE), 0, "the list still shows the old name")
  await expectVisible(page.locator("header").getByRole("button", { name: "Shorter pricing copy" }), "the header does not show the new name")
})

// ---------------------------------------------------------------- review, details
test("review: the changes open with a file tree and a diff per file; filter and select files", async (page) => {
  await openSession(page, IDLE)
  await page.getByRole("button", { name: "Review changes" }).click()
  await eventually(async () => (await hash(page)).startsWith("#/review/"), "Review did not open")
  const tree = page.getByRole("tree", { name: "Changed files" })
  const files = tree.getByRole("treeitem")
  await expectValue(() => files.count(), (n) => n >= 2, "the file tree lists fewer than 2 files")
  const n = await files.count()
  await expectValue(() => page.getByRole("button", { name: /^Collapse / }).count(), n, "not every file has a diff")
  await expectValue(() => page.locator("main main").getByRole("code").count(), (c) => c >= n, "the diffs show no code")
  await expectAttr(files.first(), "aria-selected", "true", "the first file is not selected")
  await files.nth(1).click()
  await expectAttr(files.nth(1), "aria-selected", "true", "a clicked file is not selected")
  await page.getByRole("textbox", { name: "Filter files" }).fill("tickets")
  await expectValue(() => files.count(), (c) => c >= 1 && c < n, "the filter does not narrow the tree")
}, { query: "&engine=off" })

test("details: the panel toggles with its button and Ctrl+.; its sections fold", async (page) => {
  await openSession(page, IDLE)
  const panel = page.getByRole("complementary", { name: "Session details" })
  const toggle = page.getByRole("button", { name: "Session details" })
  await expectVisible(panel, "the details panel is not open")
  for (const name of ["Environment", /^Context/, "Changes", "Checks"]) {
    await expectVisible(panel.getByRole("region", { name }), `the panel has no ${name} section`)
  }
  // folded, the header also shows a summary (its name grows)
  const env = panel.getByRole("button", { name: /^Environment/ })
  await env.click()
  await expectAttr(env, "aria-expanded", "false", "Environment did not fold")
  await env.click()
  await expectAttr(env, "aria-expanded", "true", "Environment did not unfold")
  await toggle.click()
  await expectHidden(panel, "the panel did not close")
  await expectAttr(toggle, "aria-pressed", "false", "the toggle does not say closed")
  await page.keyboard.press("Control+Period")
  await expectVisible(panel, "Ctrl+. did not open the panel")
  await expectAttr(toggle, "aria-pressed", "true", "the toggle does not say open")
})

// ---------------------------------------------------------------- keys
test("keys: Ctrl+J cycles through the sessions that need you; the need-you chip does the same", async (page) => {
  const seen = new Set()
  for (let i = 0; i < NEEDS_ALL; i++) {
    const before = await hash(page)
    await page.keyboard.press("Control+j")
    const at = await expectValue(() => hash(page), (h) => h.startsWith("#/session/") && h !== before, `Ctrl+J #${i + 1} did not move to a session`)
    seen.add(at)
  }
  assert(seen.size === NEEDS_ALL, `Ctrl+J visited ${seen.size} sessions, want ${NEEDS_ALL}`)
  const label = await page.getByRole("button", { name: /^\d+\s*need you$/ }).getAttribute("aria-keyshortcuts")
  assert(label === "Control+J", `the chip does not name its key: ${label}`)
  const before = await hash(page)
  await page.getByRole("button", { name: /^\d+\s*need you$/ }).click()
  await expectValue(() => hash(page), (h) => h.startsWith("#/session/") && h !== before, "the chip did not move on")
}, { query: "&engine=off" })

test("keys: Ctrl+number opens the session at that place, Ctrl+0 the overview; Ctrl held shows the numbers", async (page) => {
  await page.keyboard.down("Control")
  await expectValue(() => sidebar(page).locator("[data-sidebar=menu-badge]").count(), (n) => n >= 9, "holding Ctrl shows no number hints")
  await page.keyboard.press("Digit1")
  await page.keyboard.up("Control")
  await expectAttr(row(page, MAIN), "aria-current", "page", "Ctrl+1 did not open the first session")
  // the second place: the first live session of the first project in the list
  const second = await sidebar(page).locator('[data-sidebar="group"]').nth(1).locator('[data-sidebar="menu-button"]').first().getAttribute("title")
  await page.keyboard.press("Control+2")
  await expectAttr(row(page, second).first(), "aria-current", "page", `Ctrl+2 did not open "${second}"`)
  await page.keyboard.press("Control+0")
  await expectValue(() => hash(page), (h) => h === "#/" || h === "", "Ctrl+0 did not open the overview")
  await expectVisible(page.getByRole("heading", { name: "Overview", level: 1 }), "the overview is not shown")
}, { query: "&engine=off" })

test("keys: Ctrl+B hides and shows the session list, Ctrl+N new session, Ctrl+, settings, Ctrl+Shift+H history", async (page) => {
  const bar = page.locator('[data-slot="sidebar"][data-state]')
  await expectAttr(bar, "data-state", "expanded", "the list does not start shown")
  await page.keyboard.press("Control+b")
  await expectAttr(bar, "data-state", "collapsed", "Ctrl+B did not hide the list")
  await page.keyboard.press("Control+b")
  await expectAttr(bar, "data-state", "expanded", "Ctrl+B did not show the list again")
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  await expectAttr(bar, "data-state", "collapsed", "the sidebar button did not hide the list")
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  await expectAttr(bar, "data-state", "expanded", "the sidebar button did not show the list")

  await page.keyboard.press("Control+n")
  await expectValue(() => hash(page), /^#\/new/, "Ctrl+N did not open New session")
  await expectVisible(composer(page), "New session has no prompt box")
  await page.keyboard.press("Control+Shift+KeyH")
  await expectValue(() => hash(page), "#/history", "Ctrl+Shift+H did not open History")
  await page.keyboard.press("Control+Comma")
  await expectVisible(page.getByRole("dialog", { name: "Settings" }), "Ctrl+, did not open Settings")
  await page.keyboard.press("Escape")
  await expectHidden(page.getByRole("dialog", { name: "Settings" }), "Escape did not close Settings")
})

test("keys: Alt+Down and Alt+Up step through the sessions in list order", async (page) => {
  await page.keyboard.press("Control+1")
  await expectAttr(row(page, MAIN), "aria-current", "page", "Ctrl+1 did not open the first session")
  const first = await hash(page)
  await page.keyboard.press("Alt+ArrowDown")
  const next = await expectValue(() => hash(page), (h) => h.startsWith("#/session/") && h !== first, "Alt+Down did not move on")
  await page.keyboard.press("Alt+ArrowUp")
  await expectValue(() => hash(page), first, "Alt+Up did not go back")
  assert(next !== first, "Alt+Down stayed")
}, { query: "&engine=off" })

test("terminal: Ctrl+` and the Terminal button open and hide the dock with a preview shell", async (page) => {
  const dock = page.getByRole("region", { name: "Terminal" })
  const button = page.getByRole("button", { name: "Terminal", exact: true })
  await openSession(page, IDLE)
  await page.keyboard.press("Control+Backquote")
  await expectVisible(dock, "Ctrl+` did not open the terminal")
  await expectAttr(button, "aria-pressed", "true", "the Terminal button does not say open")
  await expectVisible(dock.locator(".xterm"), "the terminal has no shell")
  await page.keyboard.press("Control+Backquote")
  await expectHidden(dock, "Ctrl+` did not hide the terminal")
  await button.click()
  await expectVisible(dock, "the Terminal button did not open the terminal")
  await dock.getByRole("button", { name: "Hide the terminal" }).click()
  await expectHidden(dock, "Hide did not hide the terminal")
  await expectAttr(button, "aria-pressed", "false", "the Terminal button does not say hidden")
})

// ---------------------------------------------------------------- usage, settings
test("usage: the screen opens with its numbers, limits, charts and a range switch", async (page) => {
  await page.getByRole("button", { name: "Usage", exact: true }).click()
  await expectValue(() => hash(page), "#/usage", "Usage did not open")
  await expectVisible(page.getByRole("heading", { name: "Usage", level: 1 }), "no Usage heading")
  const range = page.getByRole("radiogroup", { name: "Range" })
  await expectAttr(range.getByRole("radio", { name: "30 days" }), "aria-checked", "true", "30 days is not the default range")
  await range.getByRole("radio", { name: "7 days" }).click()
  await expectAttr(range.getByRole("radio", { name: "7 days" }), "aria-checked", "true", "the range did not switch")
  await expectVisible(page.getByRole("meter", { name: "Current session (5 h)" }), "no 5-hour limit meter")
  await expectVisible(page.getByRole("meter", { name: "This week" }), "no weekly limit meter")
  await expectVisible(page.getByRole("table").first(), "no daily table")
  await expectValue(() => page.getByRole("table").first().getByRole("row").count(), (n) => n > 2, "the daily table is empty")
})

test("settings: Interface size zooms the whole window, from the menu and Ctrl+=/Ctrl+−, and is kept", async (page) => {
  const zoom = () => page.evaluate(() => document.documentElement.style.zoom || "1")
  const dialog = await openSettingsPage(page, "Window")
  await dialog.getByRole("combobox", { name: /^Interface size/ }).click()
  await page.getByRole("option", { name: "120%" }).click()
  await expectValue(zoom, "1.2", "the window did not zoom to 120%")
  await page.keyboard.press("Escape")
  await expectHidden(dialog, "Escape did not close Settings")
  await page.keyboard.press("Control+Minus")
  await expectValue(zoom, "1.1", "Ctrl+− did not make it smaller")
  await page.keyboard.press("Control+Equal")
  await page.keyboard.press("Control+Equal")
  await expectValue(zoom, "1.3", "Ctrl+= did not make it larger")
  await page.reload()
  await page.locator('nav[aria-label="Sessions"]:not([aria-busy])').waitFor()
  await expectValue(zoom, "1.3", "the size was not kept after a reload")
})

test("settings: Reduce motion stops the spinners and is kept", async (page) => {
  const reduced = () => page.evaluate(() => "reduceMotion" in document.documentElement.dataset)
  assert(!(await reduced()), "motion starts reduced")
  const dialog = await openSettingsPage(page, "Window")
  const sw = dialog.getByRole("switch", { name: "Reduce motion" })
  await sw.click()
  await expectAttr(sw, "aria-checked", "true", "the switch did not turn on")
  await expectValue(reduced, true, "the document is not marked reduce-motion")
  await page.reload()
  await page.locator('nav[aria-label="Sessions"]:not([aria-busy])').waitFor()
  await expectValue(reduced, true, "Reduce motion was not kept after a reload")
  await openSettingsPage(page, "Window")
  await page.getByRole("switch", { name: "Reduce motion" }).click()
  await expectValue(reduced, false, "turning it off did not bring motion back")
})

test("theme: the app is dark (it has no light theme to switch to)", async (page) => {
  const look = await page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor
    const [r, g, b] = (bg.match(/[\d.]+/g) ?? []).map(Number)
    return { dark: document.documentElement.classList.contains("dark"), scheme: getComputedStyle(document.documentElement).colorScheme, bg, lum: 0.2126 * r + 0.7152 * g + 0.0722 * b }
  })
  assert(look.dark, "the document is not in the dark theme")
  assert(look.scheme.includes("dark"), `color-scheme is "${look.scheme}"`)
  assert(look.lum < 60, `the background is not dark: ${look.bg}`)
})

// ---------------------------------------------------------------- narrow window
test("narrow window (760 px): no sideways scroll; the list opens as a sheet and opens sessions", async (page) => {
  assert(!(await sideways(page)), `the overview scrolls sideways: ${await sideways(page)}`)
  for (const name of REPOS) await expectVisible(page.getByRole("region", { name, exact: true }), `the overview has no ${name} column`)
  await expectVisible(page.getByRole("button", { name: /need you$/ }), "the need-you chip is not shown")
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  const sheet = page.getByRole("dialog").filter({ has: sidebar(page) })
  await expectVisible(sheet, "the session list does not open as a sheet")
  await row(page, IDLE).click()
  await eventually(async () => (await hash(page)).startsWith("#/session/"), "the picked session did not open")
  await expectHidden(sheet, "the sheet stayed open after a session was picked")
  await expectVisible(composer(page), "the session has no prompt box")
  await expectVisible(transcript(page), "the session has no chat")
  assert(!(await sideways(page)), `the session scrolls sideways: ${await sideways(page)}`)
  const box = await composer(page).boundingBox()
  assert(box && box.x >= 0 && box.x + box.width <= 760, `the prompt box does not fit the window: ${JSON.stringify(box)}`)
}, { viewport: { width: 760, height: 800 }, ready: "overview" })

// ---------------------------------------------------------------- runner
const selected = tests.filter((t) => !ONLY.length || ONLY.some((o) => t.name.includes(o)))
const browser = await chromium.launch(browserOptions())
const fileName = (name) => name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)

/** One test in its own context: fresh storage, a fresh mock world. */
async function run(t, trace = TRACE === "all") {
  const context = await browser.newContext({ viewport: t.opts.viewport ?? { width: 1440, height: 900 } })
  if (t.opts.settings) {
    await context.addInitScript((s) => {
      // only before the app's first start in this context: a reload keeps what the test changed
      if (!sessionStorage.getItem("sd-test-seeded")) {
        localStorage.setItem("sd.settings", JSON.stringify(s))
        sessionStorage.setItem("sd-test-seeded", "1")
      }
    }, t.opts.settings)
  }
  if (trace) await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const problems = []
  page.on("console", (m) => m.type() === "error" && problems.push(`console error: ${m.text()}`))
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`))
  const t0 = Date.now()
  let timer
  try {
    await load(page, t.opts)
    await Promise.race([t.fn(page), new Promise((_, reject) => (timer = setTimeout(() => reject(new Fail("timed out after 60 s")), 60000)))])
    if (problems.length) throw new Fail(problems.join("\n    "))
    if (trace) await context.tracing.stop()
    return { ok: true, line: `PASS  ${t.name} (${Date.now() - t0} ms)` }
  } catch (e) {
    mkdirSync(SHOTS, { recursive: true })
    const shot = join(SHOTS, `${fileName(t.name)}.png`)
    await page.screenshot({ path: shot }).catch(() => {})
    const zip = join(SHOTS, `${fileName(t.name)}.zip`)
    if (trace) await context.tracing.stop({ path: zip }).catch(() => {})
    const why = [e instanceof Fail ? e.message : (e?.stack ?? String(e)), ...problems.filter((p) => !String(e?.message).includes(p))]
    return { ok: false, line: `FAIL  ${t.name} (${Date.now() - t0} ms)\n    ${why.join("\n    ")}\n    screenshot: ${shot}`, zip: trace ? zip : undefined }
  } finally {
    clearTimeout(timer)
    await context.close().catch(() => {})
  }
}

// The first page load bundles and compiles the app (slow on a cold cache): done once, before the
// clock of any test starts.
{
  const t0 = Date.now()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const page = await context.newPage()
    const slow = { timeout: 180000 }
    await load(page, slow)
    // the lazily loaded parts too: a chat with inline diffs (and their highlighter's worker, which
    // gives up after 10 s), Review, the terminal, History and Usage
    await row(page, IDLE).click(slow)
    await transcript(page).waitFor(slow)
    await page.getByRole("button", { name: "Review changes" }).click(slow)
    await page.getByRole("tree", { name: "Changed files" }).waitFor(slow)
    await page.keyboard.press("Control+Backquote")
    await page.getByRole("region", { name: "Terminal" }).locator(".xterm").waitFor(slow)
    for (const screen of ["History", "Usage"]) {
      await page.getByRole("button", { name: screen, exact: true }).click(slow)
      await page.getByRole("heading", { name: screen, level: 1 }).last().waitFor(slow)
    }
    await page.waitForLoadState("networkidle", slow)
  } catch (e) {
    console.log(`warm-up load failed: ${e.message.split("\n")[0]}`)
  } finally {
    await context.close()
  }
  console.log(`(app loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${selected.length} tests, ${WORKERS} at a time)`)
}

let failed = 0
const started = Date.now()
const queue = [...selected]
await Promise.all(
  Array.from({ length: Math.min(WORKERS, queue.length) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const r = await run(t)
      console.log(r.line)
      if (r.ok) continue
      failed++
      // once more with a trace (tracing every test is slow): the trace shows what happened, and a
      // pass now marks the test as flaky; it still counts as failed
      if (TRACE === "off") continue
      const again = r.zip ? r : await run(t, true)
      console.log(again.ok ? `    flaky: passed when run again (${t.name})` : `    run again, failed again${again.zip ? `; trace: ${again.zip}` : ""}`)
    }
  }),
)
await browser.close()
console.log(`\n${selected.length - failed}/${selected.length} passed in ${((Date.now() - started) / 1000).toFixed(1)} s`)
process.exit(failed ? 1 : 0)
