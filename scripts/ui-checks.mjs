// Dev tool: end-to-end UI interaction checks (Node + Playwright with the system Chrome).
//
// Usage:
//   node scripts/ui-checks.mjs [--only=<substr,substr>] [--list] [--headed] [--out=<dir>] [--a11y-report]
//
//   SHOT_BASE   dev server base URL (default http://localhost:3000/); the app runs with
//               ?engine=off&debug=off so nothing changes under the checks.
//   --only      run the checks whose name contains one of the substrings (e.g. --only=dock,plan)
//   --list      print the check names and exit
//   --headed    show the browser window
//   --out       where failure screenshots go (default $TMPDIR/sd-ui-checks)
//   --a11y-report  also print every unnamed control / missing focus indicator found on the main
//               screens, including areas the a11y checks don't gate (overview, list, shell)
//
// Prints one PASS/FAIL line per check (FAIL lines carry the reason, and a screenshot path) and
// exits non-zero when any check fails. Every check starts from a fresh page load with cleared
// storage, so checks are independent and can run in any order. Session ids are generated at
// runtime: they are discovered in the page through the store module served by Vite
// (`/src/store/app.ts`), never hardcoded. One browser, one page (low RAM).
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")
const ONLY = (flag("only") ?? "").split(",").filter(Boolean)
const BASE = process.env.SHOT_BASE ?? "http://localhost:3000/"
const QUERY = "?engine=off&debug=off"
const OUT = flag("out") ?? join(tmpdir(), "sd-ui-checks")
const A11Y_REPORT = args.includes("--a11y-report")

// ---------------------------------------------------------------- harness
const checks = []
const check = (name, fn) => checks.push({ name, fn })

class CheckError extends Error {}
function expect(cond, message) {
  if (!cond) throw new CheckError(message)
}

let page
let context
let current = "boot"
/** console errors / page errors, tagged with the check that produced them */
const problems = []
const notes = []

const wait = (ms) => page.waitForTimeout(ms)

/**
 * Full reload at `hash` (fresh mock world). Storage is cleared by an init script before any app
 * code runs on each document, so persisted settings / layouts never leak between checks.
 */
async function load(hash = "#/", query = QUERY) {
  await page.goto("about:blank")
  await page.goto(`${BASE}${query}${hash}`, { waitUntil: "networkidle" })
  await page.waitForSelector("header", { timeout: 20000 })
  await wait(700)
}

/** In-app navigation (no reload). */
async function go(hash) {
  await page.evaluate((h) => {
    window.location.hash = h.replace(/^#/, "")
  }, hash)
  await wait(600)
}

/**
 * Import a source module the way the running app did. After an HMR update Vite serves it as
 * `/src/x.ts?t=…`, and importing the bare path would create a second, empty store instance, so
 * the exact URL is taken from the page's resource timing entries.
 */
const MODULE_URL = `(path) => performance.getEntriesByType("resource").map((e) => e.name).find((n) => new URL(n).pathname === path) ?? path`

/** Run `fn(state, arg, selectors)` against the live zustand store (modules served by Vite). */
function app(fn, arg) {
  return page.evaluate(
    async ({ src, arg, moduleUrl }) => {
      const url = new Function(`return (${moduleUrl})`)()
      const m = await import(url("/src/store/app.ts"))
      const sel = await import(url("/src/store/selectors.ts"))
      const f = new Function(`return (${src})`)()
      return f(m.getApp(), arg, sel)
    },
    { src: fn.toString(), arg, moduleUrl: MODULE_URL },
  )
}

/** Call an exported store action (`/src/store/actions.ts`) in the page. */
function action(name, ...params) {
  return page.evaluate(
    async ({ name, params, moduleUrl }) => {
      const m = await import(new Function(`return (${moduleUrl})`)()("/src/store/actions.ts"))
      return m[name](...params)
    },
    { name, params, moduleUrl: MODULE_URL },
  )
}

/** Poll `fn` (async, returns truthy) until it holds or the timeout passes. */
async function until(fn, timeout = 3000, step = 100) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await wait(step)
  }
  return last
}

/** Session ids by role, discovered in the running app. */
function discover() {
  return app((s, _arg, sel) => {
    const all = Object.values(s.sessions)
    const live = all.filter((x) => !x.archived && x.control !== "history")
    const pend = Object.values(s.requests).filter((r) => r.state === "pending")
    const canApprove = (sid) => ["owned", "pty"].includes(s.sessions[sid]?.control)
    const perm = (pred) => pend.find((r) => r.type === "permission" && !r.subagentId && canApprove(r.sessionId) && pred(r))
    const bash = perm((r) => r.subject?.type === "command")
    const edit = perm((r) => r.subject?.type !== "command" && r.sessionId !== bash?.sessionId)
    const question = pend.find((r) => r.type === "question" && canApprove(r.sessionId))
    const plan = pend.find((r) => r.type === "plan" && canApprove(r.sessionId))
    const history = all.find((x) => x.title === "Rate limiting for /v1/chat" && x.control === "history" && !x.archived)
    return {
      main: s.mainSessionId,
      bash: bash?.sessionId,
      bashReq: bash?.id,
      edit: edit?.sessionId,
      editReq: edit?.id,
      question: question?.sessionId,
      questionReq: question?.id,
      plan: plan?.sessionId,
      planReq: plan?.id,
      history: history?.id,
      liveCount: live.length,
      order: sel.selectSessionOrder(s),
      needs: sel.selectNeedsYou(s),
    }
  })
}

/** Tool calls in a session's transcript that still wait (permission or answer). */
function awaitingTools(sid) {
  return app(
    (s, sid) =>
      Object.values(s.transcripts[sid]?.items ?? {})
        .filter((it) => it.type === "tool_call" && it.call.display === "awaiting_permission")
        .map((it) => it.call.name),
    sid,
  )
}

const visible = (sel) => page.locator(`${sel}:visible`)
/** An overview card (main agent or session) by its session title. */
const card = (title) => page.locator(".ov-item > div, .ov-main-wrap > div").filter({ has: page.getByRole("button", { name: `Open ${title}`, exact: true }) })
/** The session list row of a session. */
const row = (title) => visible('nav[aria-label="Sessions"] button').filter({ hasText: title }).first()
const hash = () => page.evaluate(() => location.hash)
const titleOf = (id) => app((s, id) => s.sessions[id]?.title, id)
const dialog = () => page.locator("[role=dialog]:visible").last()
const transcriptText = () => visible('[role=log][aria-label="Session transcript"]').first().innerText().catch(() => "")

/** Accessible tree of the page (Chrome's computed names and roles). */
async function axNodes() {
  const cdp = await context.newCDPSession(page)
  try {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree")
    return { cdp, nodes }
  } catch (e) {
    await cdp.detach()
    throw e
  }
}

const NAMED_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "slider", "spinbutton", "option", "treeitem", "listbox",
])

/**
 * Interactive elements without an accessible name inside `scope` (CSS selector, visible
 * elements only). Returns short descriptors (tag, classes, html snippet).
 */
async function unnamedControls(scope = "body") {
  const { cdp, nodes } = await axNodes()
  const out = []
  try {
    for (const n of nodes) {
      if (n.ignored || !n.backendDOMNodeId) continue
      const role = n.role?.value
      if (!NAMED_ROLES.has(role)) continue
      if (String(n.name?.value ?? "").trim()) continue
      const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: n.backendDOMNodeId }).catch(() => ({}))
      if (!object?.objectId) continue
      const { result } = await cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        arguments: [{ value: scope }],
        returnByValue: true,
        functionDeclaration: `function (scope) {
          const el = this.nodeType === 1 ? this : this.parentElement
          if (!el || !el.closest(scope)) return null
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          if (!r.width || !r.height || cs.visibility === "hidden") return null
          return el.outerHTML.replace(/\\s+/g, " ").slice(0, 160)
        }`,
      })
      if (result?.value) out.push(`${role}: ${result.value}`)
    }
  } finally {
    await cdp.detach()
  }
  return out
}

/**
 * Tab through up to `max` stops starting from the current focus and record what got focus and
 * whether a focus indicator is drawn (outline or box-shadow ring) — only for stops inside `scope`.
 */
async function tabWalk(max, scope = "body") {
  const stops = []
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab")
    const info = await page.evaluate((scope) => {
      const el = document.activeElement
      if (!el || el === document.body) return { body: true }
      const inScope = !!el.closest(scope)
      const cs = getComputedStyle(el)
      const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0
      const ring = cs.boxShadow && cs.boxShadow !== "none"
      // a visible change on a child (e.g. hover-revealed rows) or the border (inputs) also counts
      const border = el.matches("input, textarea, [contenteditable]") || !!el.closest("[class*='focus-within']")
      // hidden = takes focus but can't be seen: no size, off screen, clipped away, or transparent
      const r = el.getBoundingClientRect()
      let hidden = !r.width || !r.height || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight
      let opacity = 1
      for (let e = el; e; e = e.parentElement) {
        const st = getComputedStyle(e)
        opacity *= Number(st.opacity)
        if (hidden || e === el || st.overflow === "visible") continue
        const p = e.getBoundingClientRect()
        if (p.width < 1 || p.height < 1 || r.right <= p.left || r.left >= p.right || r.bottom <= p.top || r.top >= p.bottom) hidden = true
      }
      if (opacity < 0.05) hidden = true
      const label =
        el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent ?? "").trim().slice(0, 40) || el.tagName.toLowerCase()
      return { inScope, indicator: outline || ring || border, label, tag: el.tagName.toLowerCase(), hidden }
    }, scope)
    stops.push(info)
    if (info.body) break
  }
  return stops
}

// ---------------------------------------------------------------- checks
check("boot: the overview draws the tree without console errors", async () => {
  await load("#/")
  const ids = await discover()
  await page.waitForSelector(".ov-item", { timeout: 10000 })
  const cards = await page.locator(".ov-item").count()
  expect(cards === ids.order.length - 1, `${cards} session cards for ${ids.order.length - 1} live sessions`)
  expect((await page.locator(".ov-col").count()) === (await app((s) => s.repoOrder.length)), "one column per repo")
  // the session list sits beside the overview too (Ctrl+B hides it)
  expect((await visible('nav[aria-label="Sessions"]').count()) === 1, "session list missing beside the overview")
  await page.keyboard.press("Control+b")
  // the stock sidebar slides off-canvas (it stays mounted): its state says collapsed
  expect(await until(async () => ((await page.locator('[data-slot=sidebar][data-state=collapsed]').count()) === 1 ? true : null), 1500), "Ctrl+B didn't hide the session list")
  await page.keyboard.press("Control+b")
  expect(await until(async () => ((await page.locator('[data-slot=sidebar][data-state=expanded]').count()) === 1 ? true : null), 1500), "Ctrl+B didn't bring the session list back")
  const errs = problems.filter((p) => p.check === current)
  expect(!errs.length, `console errors: ${errs.map((e) => e.text).join(" | ")}`)
  return `${cards} cards`
})

check("needs-you: the top-bar count matches the store and Ctrl+J visits each one once", async () => {
  await load("#/")
  const ids = await discover()
  const label = await visible("header button").filter({ hasText: "need you" }).first().innerText()
  const shown = Number(label.replace(/\D+/g, ""))
  expect(shown === ids.needs.length, `top bar says ${shown}, store has ${ids.needs.length}`)
  const seen = []
  for (let i = 0; i < ids.needs.length + 1; i++) {
    await page.keyboard.press("Control+j")
    await wait(250)
    seen.push((await hash()).split("/")[2])
  }
  expect(JSON.stringify(seen.slice(0, ids.needs.length)) === JSON.stringify(ids.needs), `Ctrl+J order ${seen.join(",")} vs ${ids.needs.join(",")}`)
  expect(seen.at(-1) === ids.needs[0], "Ctrl+J doesn't wrap around to the first one")
  return `${shown} need you`
})

check("overview card: Allow once on a Bash permission", async () => {
  await load("#/")
  const ids = await discover()
  expect(ids.bash, "no approvable Bash permission in the fixture")
  const c = card(await titleOf(ids.bash))
  await c.waitFor({ timeout: 5000 })
  await c.getByRole("button", { name: "Allow once" }).click()
  const st = await until(() => app((s, id) => (s.sessions[id].status !== "waiting_permission" ? s.sessions[id].status : null), ids.bash))
  expect(st, "session still waiting for permission")
  expect((await hash()) === "#/", "answering on the card opened the session")
  expect((await c.getByRole("button", { name: "Allow once" }).count()) === 0, "card still shows Allow once")
  await go(`#/session/${ids.bash}`)
  await wait(500)
  const waiting = await awaitingTools(ids.bash)
  expect(!waiting.includes("Bash"), "transcript still has a Bash call awaiting approval")
  return `status → ${st}`
})

check("overview card: clicking a card opens its chat; Ctrl+0 returns", async () => {
  await load("#/")
  const ids = await discover()
  const title = await titleOf(ids.question)
  await card(title).getByRole("button", { name: `Open ${title}`, exact: true }).click()
  expect((await hash()) === `#/session/${ids.question}`, `opened ${await hash()}`)
  expect(await row(title).getAttribute("aria-current") === "page", "list row not marked current")
  await page.keyboard.press("Control+0")
  await wait(300)
  expect((await hash()) === "#/", "Ctrl+0 didn't go to the overview")
})

check("session dock: Allow once on a Bash permission", async () => {
  await load("#/")
  const ids = await discover()
  await go(`#/session/${ids.bash}`)
  const card = visible('[aria-label^="Permission request"]').first()
  await card.waitFor({ timeout: 5000 })
  expect((await awaitingTools(ids.bash)).includes("Bash"), "precondition: transcript has a Bash call awaiting approval")
  await card.getByRole("button", { name: "Allow once" }).click()
  const st = await until(() => app((s, id) => (s.sessions[id].status !== "waiting_permission" ? s.sessions[id].status : null), ids.bash))
  expect(st, "session still waiting for permission")
  expect((await visible('[aria-label^="Permission request"]').count()) === 0, "dock card still shown")
  expect(!(await awaitingTools(ids.bash)).includes("Bash"), "transcript row still awaiting")
  return `status → ${st}`
})

check("session dock: Enter approves the focused card (keyboard)", async () => {
  await load("#/")
  const ids = await discover()
  await go(`#/session/${ids.bash}`)
  await visible('[aria-label^="Permission request"]').first().waitFor({ timeout: 5000 })
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")
  expect(focused.startsWith("Permission request"), `card did not take focus (focus on "${focused}")`)
  await page.keyboard.press("Enter")
  const st = await until(() => app((s, id) => (s.sessions[id].status !== "waiting_permission" ? s.sessions[id].status : null), ids.bash))
  expect(st, "Enter did not approve")
  // keyboard users keep their place: focus moves on to the composer instead of falling to <body>
  const next = await until(() => page.evaluate(() => (document.activeElement !== document.body ? document.activeElement?.getAttribute("aria-label") : null)), 1500)
  expect(next === "Message Claude", `focus after approving: ${next ?? "<body>"}`)
  const said = await until(() => page.evaluate(() => document.querySelector("[data-session-view] [role=status]")?.textContent?.trim()), 1500)
  expect(/working/i.test(said ?? ""), `status announcer said "${said ?? ""}"`)
})

check("deny with feedback", async () => {
  await load("#/")
  const ids = await discover()
  expect(ids.edit, "no second approvable permission in the fixture")
  await go(`#/session/${ids.edit}`)
  const card = visible('[aria-label^="Permission request"]').first()
  await card.waitFor({ timeout: 5000 })
  await card.getByRole("button", { name: "Deny" }).click()
  const field = card.locator("textarea")
  await field.waitFor({ timeout: 2000 })
  await field.fill("Keep the old alias too")
  await page.keyboard.press("Control+Enter")
  const req = await until(() => app((s, id) => (s.requests[id]?.state !== "pending" ? s.requests[id] : null), ids.editReq))
  expect(req, "request still pending")
  const tool = await app((s, a) => {
    const calls = Object.values(s.transcripts[a.sid]?.items ?? {}).filter((it) => it.type === "tool_call" && it.call.name === a.tool)
    const c = calls.find((it) => it.call.display === "rejected")?.call
    return c ? { display: c.display, output: c.output ?? "" } : null
  }, { sid: ids.edit, tool: (await app((s, id) => s.requests[id].toolName, ids.editReq)) })
  expect(tool, "no rejected tool call in the transcript")
  expect(String(tool.output).includes("Keep the old alias too"), `feedback not recorded (output "${tool.output}")`)
  expect((await transcriptText()).includes("denied"), "transcript row doesn't say denied")
  expect((await visible('[aria-label^="Permission request"]').count()) === 0, "dock card still shown")
})

check("answer AskUserQuestion", async () => {
  await load("#/")
  const ids = await discover()
  expect(ids.question, "no question request in the fixture")
  await go(`#/session/${ids.question}`)
  const card = visible('[aria-label="Question from Claude"]').first()
  await card.waitFor({ timeout: 5000 })
  const total = await app((s, id) => s.requests[id].questions.length, ids.questionReq)
  for (let i = 0; i < total; i++) {
    // several questions: "‹ 1 of N ›" pages through them (a single-choice answer moves on by itself)
    if (i > 0 && !(await card.innerText()).includes(`${i + 1} of ${total}`)) await card.getByRole("button", { name: "Next question" }).click()
    await card.locator('[role=radio]:not([aria-label="Other"]), [role=checkbox]:not([aria-label="Other"])').first().click()
    await wait(200)
  }
  const submit = card.getByRole("button", { name: "Submit" })
  expect(await submit.isEnabled(), "Submit stays disabled after answering every question")
  await submit.click()
  const st = await until(() => app((s, id) => (s.sessions[id].status !== "waiting_input" ? s.sessions[id].status : null), ids.question))
  expect(st, "session still waiting for input")
  expect((await visible('[aria-label="Question from Claude"]').count()) === 0, "question card still shown")
  expect(!(await awaitingTools(ids.question)).includes("AskUserQuestion"), "transcript still waiting for the answer")
  return `${total} question(s), status → ${st}`
})

check("approve a plan (permission mode changes)", async () => {
  await load("#/")
  const ids = await discover()
  expect(ids.plan, "no plan approval in the fixture")
  const before = await app((s, id) => s.sessions[id].permissionMode, ids.plan)
  await go(`#/session/${ids.plan}`)
  const card = visible('[aria-label="Plan approval"]').first()
  await card.waitFor({ timeout: 5000 })
  await card.getByRole("button", { name: /auto-accept edits/i }).click()
  const mode = await until(() => app((s, id) => (s.sessions[id].permissionMode === "acceptEdits" ? "acceptEdits" : null), ids.plan))
  expect(mode, `mode stayed ${await app((s, id) => s.sessions[id].permissionMode, ids.plan)}`)
  expect((await visible('[aria-label="Plan approval"]').count()) === 0, "plan card still shown")
  expect(!(await awaitingTools(ids.plan)).includes("ExitPlanMode"), "plan row still awaiting approval")
  const picker = await visible('[data-session-view] button[aria-label^="Permissions:"]').first().innerText()
  expect(/accept edits/i.test(picker), `mode picker shows "${picker}"`)
  return `${before} → acceptEdits`
})

check("archive from the session menu → Undo toast → History · Archived → restore", async () => {
  await load("#/")
  const ids = await discover()
  const id = ids.order.find((x) => x !== ids.main && x !== ids.bash)
  const title = await titleOf(id)
  const archive = async () => {
    await go(`#/session/${id}`)
    await visible('button[aria-label="More actions"]').first().click()
    await page.getByRole("menuitem", { name: "Archive" }).click()
    expect(await until(() => app((s, id) => s.sessions[id].archived, id)), "session not archived")
  }
  await archive()
  expect((await hash()) === "#/", "archiving the open session didn't go back to the overview")
  expect((await card(title).count()) === 0, "archived session still on the overview")
  const toast = visible("[role=status]").filter({ hasText: "Archived" }).first()
  await toast.waitFor({ timeout: 2000 })
  expect((await toast.innerText()).includes(title), "Undo toast doesn't name the session")
  await toast.getByRole("button", { name: "Undo" }).click()
  expect(await until(() => app((s, id) => !s.sessions[id].archived, id)), "Undo didn't restore")
  await archive()
  // History → Archived
  await visible('[data-slot=sidebar-footer] button').filter({ hasText: "History" }).first().click()
  await visible('[role=tab]').filter({ hasText: "Archived" }).first().click()
  const li = visible("[role=option]").filter({ hasText: title }).first()
  await li.waitFor({ timeout: 3000 })
  await li.hover()
  await li.getByRole("button", { name: /Restore/ }).click()
  expect(await until(() => app((s, id) => !s.sessions[id].archived, id)), "Restore didn't bring it back")
  return title
})

check("search: Ctrl+K finds a past session; Resume brings it back to life", async () => {
  await load("#/")
  const ids = await discover()
  expect(ids.history, "history session missing from the fixture")
  await page.keyboard.press("Control+k")
  await dialog().getByRole("combobox").waitFor({ timeout: 3000 })
  await page.keyboard.type("Rate limiting for /v1/chat")
  const item = dialog().locator("[cmdk-item]", { hasText: "Rate limiting for /v1/chat" }).first()
  await item.waitFor({ timeout: 3000 })
  await item.click()
  expect((await hash()) === `#/session/${ids.history}`, `opened ${await hash()}`)
  await visible("[data-session-view]").getByRole("button", { name: "Resume", exact: true }).first().click()
  const control = await until(() => app((s, id) => (s.sessions[id].control === "owned" ? "owned" : null), ids.history))
  expect(control === "owned", "Resume didn't take over the session")
  expect((await row("Rate limiting for /v1/chat").count()) === 1, "resumed session not in the list")
})

check("palette: empty Ctrl+K ⏎ opens the session that needs you most", async () => {
  await load("#/")
  const ids = await discover()
  await page.keyboard.press("Control+k")
  await dialog().getByRole("combobox").waitFor({ timeout: 3000 })
  await wait(200)
  await page.keyboard.press("Enter")
  await wait(300)
  expect((await hash()) === `#/session/${ids.needs[0]}`, `opened ${await hash()}, expected ${ids.needs[0]}`)
})

check("new session screen: Ctrl+N, type, Enter starts the session with only the first prompt", async () => {
  await load("#/")
  await page.keyboard.press("Control+n")
  const screen = visible("[data-new-session]").first()
  await screen.waitFor({ timeout: 3000 })
  const box = screen.getByRole("textbox", { name: "Message Claude" })
  expect(await box.evaluate((el) => el === document.activeElement), "prompt box not focused")
  const prompt = "Add a dark mode toggle to the settings page"
  await box.fill(prompt)
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => location.hash.startsWith("#/session/"), null, { timeout: 4000 })
  const id = (await page.evaluate(() => location.hash)).split("/")[2]
  await wait(400)
  const t = await app((s, id) => {
    const tr = s.transcripts[id]
    const items = tr?.order.map((k) => tr.items[k]) ?? []
    return {
      first: s.sessions[id]?.firstPrompt,
      worktree: s.sessions[id]?.cwd.includes(".claude/worktrees/"),
      items: items.map((it) => (it.type === "agent_message" && it.id === tr.liveItemId ? "live_reply" : it.type)),
      userText: items.find((it) => it.type === "user_message")?.text,
    }
  }, id)
  expect(t.first === prompt, `firstPrompt is "${t.first}"`)
  expect(t.worktree, "default should start in its own worktree")
  const extra = t.items.slice(1).filter((x) => x !== "live_reply")
  expect(t.items[0] === "user_message" && t.userText === prompt && !extra.length, `transcript holds ${JSON.stringify(t.items)}`)
  expect((await transcriptText()).includes(prompt), "prompt not shown in the transcript")
})

check("new session screen: Open folder adds a folder that isn't a project yet and starts there", async () => {
  await load("#/new")
  const before = await app((s) => s.repoOrder.length)
  await visible('[data-new-session] button[aria-label^="Folder:"]').first().click()
  await page.keyboard.type("~/code/scratch")
  await page.locator("[cmdk-item]:visible", { hasText: "~/code/scratch" }).first().click()
  const repo = await until(() => app((s) => s.repoOrder.map((id) => s.repos[id]).find((r) => r.name === "scratch")?.id))
  expect(repo, "~/code/scratch was not added as a project")
  expect((await app((s) => s.repoOrder.length)) === before + 1, "project count did not grow by one")
  expect((await visible("[data-new-session] h1").first().innerText()).includes("scratch"), "heading doesn't name the new folder")
  await visible("[data-new-session]").getByRole("textbox", { name: "Message Claude" }).fill("Try the streaming API")
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => location.hash.startsWith("#/session/"), null, { timeout: 4000 })
  const id = (await hash()).split("/")[2]
  expect((await app((s, id) => s.sessions[id].repoId, id)) === repo, "session not in the new project")
  expect((await visible('nav[aria-label="Sessions"] [data-slot=sidebar-group][aria-label="scratch"]').count()) === 1, "new project group missing from the list")
})

check("keys work while typing: Ctrl+J and Ctrl+Shift+M from a focused prompt box", async () => {
  await load("#/")
  const ids = await discover()
  await go(`#/session/${ids.main}`)
  const box = visible("[data-session-view]").getByRole("textbox", { name: "Message Claude" }).first()
  await box.click()
  await page.keyboard.type("draft")
  await page.keyboard.press("Control+Shift+m")
  // the settings menus are searchable lists (Popover + cmdk), like Zed's agent bar
  const menu = visible("[data-slot=popover-content] [cmdk-root]").first()
  await menu.waitFor({ timeout: 1500 })
  expect((await menu.innerText()).includes("Accept edits"), "mode menu didn't open")
  await page.keyboard.press("2")
  const mode = await until(() => app((s, id) => (s.sessions[id].permissionMode === "acceptEdits" ? "acceptEdits" : null), ids.main), 1500)
  expect(mode === "acceptEdits", "digit 2 didn't pick Accept edits")
  await box.click()
  await page.keyboard.press("Control+j")
  await wait(300)
  expect((await hash()) === `#/session/${ids.needs[0]}`, `Ctrl+J from the prompt box went to ${await hash()}`)
})

check("a session started in a terminal shows up by itself, in a new project if needed", async () => {
  await load("#/")
  const before = await app((s) => ({ repos: s.repoOrder.length, live: Object.values(s.sessions).filter((x) => !x.archived && x.control !== "history").length }))
  await action("addDiscoveredSession", "~/code/blog", "Draft the release notes")
  await wait(400)
  const after = await app((s) => {
    const x = Object.values(s.sessions).find((y) => y.title === "Draft the release notes")
    return { repos: s.repoOrder.length, control: x?.control, repo: x ? s.repos[x.repoId]?.name : null }
  })
  expect(after.repos === before.repos + 1 && after.repo === "blog", `project not added (${JSON.stringify(after)})`)
  expect(after.control === "observed", `control is ${after.control}`)
  expect((await page.locator(".ov-col", { hasText: "blog" }).count()) === 1, "new project column missing on the overview")
  expect((await card("Draft the release notes").count()) === 1, "session card missing on the overview")
})

check("rewind to here: hovering a message offers it and preselects that prompt", async () => {
  await load("#/")
  const ids = await discover()
  await go(`#/session/${ids.bash}`)
  await wait(700)
  const first = await app((s, id) => {
    const t = s.transcripts[id]
    const u = t.order.map((k) => t.items[k]).find((it) => it.type === "user_message")
    return u?.text
  }, ids.bash)
  const msg = visible("[data-session-view] .group\\/user").filter({ hasText: first.slice(0, 30) }).first()
  await msg.scrollIntoViewIfNeeded()
  await msg.hover()
  await msg.getByRole("button", { name: "Rewind to here" }).click()
  const d = page.getByRole("dialog", { name: "Rewind" })
  await d.waitFor({ timeout: 2000 })
  const selected = await d.locator("[role=option][aria-selected=true]").innerText()
  expect(selected.includes(first.slice(0, 20)), `preselected "${selected.slice(0, 40)}"`)
  await page.keyboard.press("Escape")
})

check("switching: Ctrl+Tab goes back, holding Ctrl walks the recent list, Ctrl+1–9 and Alt+↓ jump", async () => {
  await load("#/")
  const ids = await discover()
  const [a, b, c] = ids.order.slice(1, 4)
  for (const id of [a, b, c]) await go(`#/session/${id}`)
  // quick Ctrl+Tab: back to the previous one, and again: forth
  await page.keyboard.press("Control+Tab")
  await wait(250)
  expect((await hash()) === `#/session/${b}`, `Ctrl+Tab went to ${await hash()}, expected ${b}`)
  await page.keyboard.press("Control+Tab")
  await wait(250)
  expect((await hash()) === `#/session/${c}`, `second Ctrl+Tab went to ${await hash()}, expected ${c}`)
  // hold Ctrl, Tab twice: the list shows, and releasing opens the second most recent
  await page.keyboard.down("Control")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Tab")
  await visible('[role=listbox][aria-label="Recent sessions"]').first().waitFor({ timeout: 1500 })
  await page.keyboard.up("Control")
  await wait(250)
  expect((await hash()) === `#/session/${a}`, `held Ctrl+Tab Tab went to ${await hash()}, expected ${a}`)
  // Ctrl+3: third session in list order
  await page.keyboard.press("Control+3")
  await wait(250)
  expect((await hash()) === `#/session/${ids.order[2]}`, `Ctrl+3 went to ${await hash()}`)
  await page.keyboard.press("Alt+ArrowDown")
  await wait(250)
  expect((await hash()) === `#/session/${ids.order[3]}`, `Alt+↓ went to ${await hash()}`)
  // switching back is instant: the view was kept mounted
  const t0 = Date.now()
  await page.keyboard.press("Control+Tab")
  await page.locator(`[data-session-view="${ids.order[2]}"]:visible`).waitFor({ timeout: 2000 })
  return `back in ${Date.now() - t0} ms`
})

check("rewind: menu → pick a prompt → transcript truncated, prompt back in composer, Undo restores", async () => {
  await load("#/")
  const ids = await discover()
  expect(ids.bash, "no session to rewind")
  await go(`#/session/${ids.bash}`)
  await page.waitForTimeout(800)
  const turnsBefore = await app((s, id) => s.transcripts[id]?.turns.length ?? 0, ids.bash)
  expect(turnsBefore >= 2, `precondition: ${turnsBefore} turns`)
  await visible('button[aria-label="More actions"]').first().click()
  await page.getByRole("menuitem", { name: /Rewind/ }).click()
  const d = page.getByRole("dialog", { name: "Rewind" })
  await d.waitFor({ timeout: 2000 })
  expect((await d.getByRole("option").count()) >= 2, "rewind list has fewer than 2 prompts")
  await page.keyboard.press("Enter")
  await d.waitFor({ state: "hidden", timeout: 2000 })
  const after = await app((s, id) => ({ turns: s.transcripts[id].turns.length, status: s.sessions[id].status }), ids.bash)
  expect(after.turns === turnsBefore - 1, `turns ${turnsBefore} → ${after.turns}`)
  expect(after.status === "idle", `status is ${after.status}`)
  const composer = await visible("textarea").first().inputValue()
  expect(composer.length > 0, "prompt not put back into the composer")
  await page.getByRole("button", { name: /^Undo/ }).first().click()
  const restored = await until(() => app((s, a) => (s.transcripts[a.id].turns.length === a.n ? s.sessions[a.id].status : null), { id: ids.bash, n: turnsBefore }))
  expect(restored === "waiting_permission", `after Undo status is ${restored}`)
  // Esc Esc in an empty composer opens it again
  await visible("textarea").first().fill("")
  await visible("textarea").first().focus()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await d.waitFor({ timeout: 2000 })
  await page.keyboard.press("Escape")
})

check("composer: attachments become chips on the message; a queued message is sent when the turn ends", async () => {
  await load("#/")
  const sid = await app((s) => Object.values(s.sessions).find((x) => !x.archived && x.control === "owned" && x.status === "done_unseen")?.id)
  expect(sid, "no finished owned session")
  await go(`#/session/${sid}`)
  await page.waitForTimeout(600)
  await page.locator('input[type="file"]').first().setInputFiles(["package.json", "README.md"])
  await visible("textarea").first().fill("Use these two files")
  await page.keyboard.press("Enter")
  const sent = await until(() => app((s, id) => { const t = s.transcripts[id]; const u = t?.order.map((x) => t.items[x]).filter((x) => x.type === "user_message").at(-1); return u?.text === "Use these two files" ? u.attachments ?? [] : null }, sid))
  expect(Array.isArray(sent) && sent.length === 2, `user message attachments: ${JSON.stringify(sent)}`)
  expect(!(await app((s, id) => s.transcripts[id].order.map((x) => s.transcripts[id].items[x]).some((x) => x.type === "user_message" && x.text.includes("[attached:")), sid)), "attachments pasted into the text")
  expect(await page.getByText("package.json", { exact: true }).first().isVisible(), "attachment chip not shown")
  // now working: Enter queues
  await visible("textarea").first().fill("And then update the changelog")
  await page.keyboard.press("Enter")
  const queued = await until(() => app((s, id) => s.transcripts[id].queued.length, sid))
  expect(queued === 1, `queue has ${queued}`)
  // the turn ends → the queued message goes out
  await page.evaluate(async ({ id, moduleUrl }) => {
    const e = await import(new Function(`return (${moduleUrl})`)()("/src/mocks/engine.ts"))
    e.enqueue({ t: "status", sid: id, status: "done_unseen", patch: { activity: undefined } })
  }, { id: sid, moduleUrl: MODULE_URL })
  const delivered = await until(() => app((s, id) => { const t = s.transcripts[id]; return t.queued.length === 0 && t.order.some((x) => t.items[x].type === "user_message" && t.items[x].text === "And then update the changelog") && s.sessions[id].status === "working" }, sid))
  expect(delivered, "queued message not delivered after the turn ended")
})

check("? opens the keyboard shortcuts overlay (Esc closes it)", async () => {
  await load("#/")
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press("Shift+Slash")
  const d = page.getByRole("dialog", { name: "Keyboard shortcuts" })
  await d.waitFor({ timeout: 2000 })
  await page.keyboard.press("Escape")
  await d.waitFor({ state: "hidden", timeout: 2000 })
})

// ---------------- accessibility (session view, cards, composer, dialogs, toasts) ----------------
check("a11y: session view controls are named and the dock is a live region", async () => {
  await load("#/")
  const ids = await discover()
  await go(`#/session/${ids.bash}`)
  await visible('[aria-label^="Permission request"]').first().waitFor({ timeout: 5000 })
  const live = await page.evaluate(() => {
    const card = document.querySelector('[aria-label^="Permission request"]')
    const region = card?.closest("[aria-live]")
    return region ? region.getAttribute("aria-live") : null
  })
  expect(live === "polite", `dock live region is ${live}`)
  const logLive = await page.evaluate(() => document.querySelector('[role=log][aria-label="Session transcript"]')?.getAttribute("aria-live"))
  expect(logLive === "off", `transcript log announces every token (aria-live=${logLive})`)
  const composer = page.getByRole("textbox", { name: "Message Claude" })
  expect((await composer.count()) > 0, "composer has no accessible name")
  const bad = await unnamedControls("[data-session-view]")
  expect(!bad.length, `unnamed controls:\n    ${bad.join("\n    ")}`)
})

check("a11y: keyboard reaches every dock option with a visible focus ring", async () => {
  await load("#/")
  const ids = await discover()
  await go(`#/session/${ids.bash}`)
  const card = visible('[aria-label^="Permission request"]').first()
  await card.waitFor({ timeout: 5000 })
  await card.focus()
  const stops = await tabWalk(12, '[aria-label^="Permission request"]')
  const inCard = stops.filter((s) => s.inScope)
  const names = inCard.map((s) => s.label)
  expect(names.some((n) => /Allow once|^Yes$/.test(n)), `Allow once not reached by Tab (${names.join(", ")})`)
  expect(names.some((n) => /Deny|No, and tell/.test(n)), `Deny not reached by Tab (${names.join(", ")})`)
  const noRing = inCard.filter((s) => !s.indicator)
  expect(!noRing.length, `no focus indicator on: ${noRing.map((s) => s.label).join(", ")}`)
  return `${inCard.length} stops in the card`
})

check("a11y: composer Tab/Shift+Tab move focus (no trap)", async () => {
  await load("#/")
  const ids = await discover()
  await go(`#/session/${ids.edit}`)
  const ta = page.getByRole("textbox", { name: "Message Claude" })
  await ta.click()
  await page.keyboard.press("Tab")
  const after = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))
  expect(after && after !== "Message Claude", "Tab stayed in the composer")
  await ta.click()
  const mode0 = await app((s, id) => s.sessions[id].permissionMode, ids.edit)
  await page.keyboard.press("Shift+Tab")
  const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))
  const mode1 = await app((s, id) => s.sessions[id].permissionMode, ids.edit)
  expect(back !== "Message Claude" || mode0 !== mode1, "Shift+Tab neither moved focus nor changed the mode")
  if (back === "Message Claude") {
    // the mode switch is spoken, and the composer's description tells how to leave it
    const said = await until(() => page.evaluate(() => document.querySelector("[data-session-view] [role=status]")?.textContent?.trim()), 1500)
    expect(/permission mode/i.test(said ?? ""), `mode change not announced ("${said ?? ""}")`)
    const desc = await ta.evaluate((el) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? "")
    expect(/Shift\+Tab/.test(desc), `composer description doesn't mention Shift+Tab ("${desc}")`)
  }
  return back === "Message Claude" ? `Shift+Tab cycles the mode (${mode0} → ${mode1}), Tab leaves` : "Shift+Tab leaves"
})

check("a11y: composer / menu is a listbox wired to the textarea; Esc closes it", async () => {
  await load("#/")
  const ids = await discover()
  await go(`#/session/${ids.edit}`)
  const ta = page.getByRole("textbox", { name: "Message Claude" })
  await ta.click()
  await page.keyboard.type("/")
  const list = visible("[role=listbox]").first()
  await list.waitFor({ timeout: 2000 })
  const wiring = await ta.evaluate((el) => {
    const list = document.getElementById(el.getAttribute("aria-controls") ?? "")
    const opt = document.getElementById(el.getAttribute("aria-activedescendant") ?? "")
    return { list: list?.getAttribute("role"), listName: list?.getAttribute("aria-label"), opt: opt?.getAttribute("role"), optId: opt?.id, selected: opt?.getAttribute("aria-selected") }
  })
  expect(wiring.list === "listbox" && wiring.listName, `aria-controls → ${JSON.stringify(wiring)}`)
  expect(wiring.opt === "option" && wiring.selected === "true", `aria-activedescendant → ${JSON.stringify(wiring)}`)
  await page.keyboard.press("ArrowDown")
  const moved = await until(async () => (await ta.getAttribute("aria-activedescendant")) !== wiring.optId, 1000)
  expect(moved, "aria-activedescendant didn't follow ArrowDown")
  await page.keyboard.press("Escape")
  await list.waitFor({ state: "hidden", timeout: 2000 })
  expect(!(await ta.getAttribute("aria-activedescendant")), "aria-activedescendant left behind after Esc")
  expect((await ta.inputValue()) === "/", "Esc cleared the composer")
  return "active option follows the arrows"
})

check("a11y: Undo toast is a status message with named buttons", async () => {
  await load("#/")
  const ids = await discover()
  await go(`#/session/${ids.order[1]}`)
  await visible('button[aria-label="More actions"]').first().click()
  await page.getByRole("menuitem", { name: "Archive" }).click()
  const toast = visible("[role=status]").filter({ hasText: "Archived" }).first()
  await toast.waitFor({ timeout: 2000 })
  const region = await page.evaluate(() => {
    const t = [...document.querySelectorAll("[role=status]")].find((x) => x.textContent?.includes("Archived"))
    const r = t?.closest("[role=region]")
    return r?.getAttribute("aria-label") ?? null
  })
  expect(region, "toasts are not inside a labelled region")
  const bad = await unnamedControls("[role=region]")
  expect(!bad.length, `unnamed toast controls:\n    ${bad.join("\n    ")}`)
})

check("a11y: new session screen and palette label their controls; Esc closes the palette", async () => {
  await load("#/new")
  await visible("[data-new-session]").first().waitFor({ timeout: 3000 })
  await visible("[data-new-session] button").filter({ hasText: "More options" }).first().click()
  await wait(200)
  let bad = await unnamedControls("[data-new-session]")
  expect(!bad.length, `new session screen:\n    ${bad.join("\n    ")}`)
  await page.keyboard.press("Control+k")
  await dialog().waitFor({ timeout: 3000 })
  bad = await unnamedControls("[role=dialog]")
  expect(!bad.length, `palette:\n    ${bad.join("\n    ")}`)
  await page.keyboard.press("Escape")
  await page.locator("[role=dialog]").first().waitFor({ state: "hidden", timeout: 2000 })
})

check("a11y: Escape closes the mode menu and returns focus", async () => {
  await load("#/")
  const ids = await discover()
  await go(`#/session/${ids.edit}`)
  const trigger = visible('[data-session-view] button[aria-label^="Permissions:"]').first()
  await trigger.click()
  await visible("[data-slot=popover-content] [cmdk-root]").first().waitFor({ timeout: 2000 })
  await page.keyboard.press("Escape")
  await page.locator("[data-slot=popover-content] [cmdk-root]").first().waitFor({ state: "hidden", timeout: 2000 })
  expect(await trigger.evaluate((el) => el === document.activeElement), "focus didn't return to the menu trigger")
})

check("no uncaught page errors during the run", async () => {
  const errs = problems.filter((p) => p.type === "pageerror")
  expect(!errs.length, errs.map((e) => `[${e.check}] ${e.text}`).join(" | "))
})

// ---------------------------------------------------------------- a11y report (optional)
async function a11yReport() {
  console.log("\n--- a11y report (all areas) ---")
  await load("#/")
  const ids = await discover()
  const screens = [
    ["overview + top bar", "#/"],
    ["session (permission) + list", `#/session/${ids.bash}`],
    ["session (question)", `#/session/${ids.question}`],
    ["review", `#/review/${ids.edit}`],
    ["archive", "#/archive"],
    ["settings", "#/settings"],
  ]
  for (const [label, hash] of screens) {
    await go(hash)
    await wait(600)
    const bad = await unnamedControls("body")
    console.log(`\n[${label}] unnamed controls: ${bad.length}`)
    for (const b of bad.slice(0, 40)) console.log(`    ${b}`)
    await page.locator("body").click({ position: { x: 2, y: 2 } }).catch(() => {})
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    const stops = await tabWalk(150)
    const hidden = stops.filter((s) => !s.body && s.hidden)
    const noRing = stops.filter((s) => !s.body && !s.hidden && !s.indicator)
    console.log(`[${label}] tab stops: ${stops.length}; focusable but hidden: ${hidden.length}; no focus indicator: ${noRing.length}`)
    for (const s of noRing.slice(0, 25)) console.log(`    no ring: <${s.tag}> ${s.label}`)
    for (const s of hidden.slice(0, 25)) console.log(`    hidden: <${s.tag}> ${s.label}`)
  }
}

// ---------------------------------------------------------------- run
if (args.includes("--list")) {
  for (const c of checks) console.log(c.name)
  process.exit(0)
}
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ channel: "chrome", headless: !args.includes("--headed") })
context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" })
await context.addInitScript(() => {
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    /* about:blank has no storage */
  }
})
page = await context.newPage()
page.setDefaultTimeout(6000)
page.on("console", (m) => {
  if (m.type() === "error") problems.push({ check: current, type: "console", text: m.text().slice(0, 300) })
  else if (m.type() === "warning") notes.push({ check: current, text: m.text().slice(0, 300) })
})
page.on("pageerror", (e) => problems.push({ check: current, type: "pageerror", text: e.message.slice(0, 300) }))
try {
  await page.goto(BASE, { timeout: 10000 })
} catch {
  console.error(`dev server not reachable at ${BASE} (start it with: bunx vite)`)
  await browser.close()
  process.exit(2)
}

let failed = 0
let ran = 0
const t0 = Date.now()
for (const c of checks) {
  if (ONLY.length && !ONLY.some((o) => c.name.includes(o))) continue
  current = c.name
  ran++
  const t = Date.now()
  try {
    const info = await c.fn()
    console.log(`PASS  ${c.name}${info ? `  (${info})` : ""}  ${Date.now() - t} ms`)
  } catch (e) {
    failed++
    const file = join(OUT, `${String(ran).padStart(2, "0")}-${c.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`)
    await page.screenshot({ path: file }).catch(() => {})
    const msg = e instanceof CheckError ? e.message : `${e.message.split("\n")[0]}`
    console.log(`FAIL  ${c.name}\n      ${msg}\n      screenshot: ${file}`)
  }
}
if (A11Y_REPORT) await a11yReport().catch((e) => console.log(`a11y report failed: ${e.message.split("\n")[0]}`))

const consoleErrs = problems.filter((p) => p.type === "console")
if (consoleErrs.length) {
  console.log(`\nconsole errors (${consoleErrs.length}):`)
  for (const p of consoleErrs.slice(0, 20)) console.log(`  [${p.check}] ${p.text}`)
}
if (notes.length) console.log(`console warnings: ${notes.length} (first: [${notes[0].check}] ${notes[0].text})`)
console.log(`\n${ran - failed}/${ran} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
await browser.close()
process.exit(failed ? 1 : 0)
