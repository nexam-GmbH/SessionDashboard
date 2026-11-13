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
//               screens, including areas the a11y checks don't gate (map, sidebar, shell)
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
async function load(hash = "#/map", query = QUERY) {
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
  return app((s) => {
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
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`)
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
check("boot: app loads without console errors", async () => {
  await load("#/map")
  await page.waitForSelector(".react-flow__node", { timeout: 10000 })
  const nodes = await page.locator(".react-flow__node").count()
  expect(nodes > 0, "map rendered no nodes")
  expect(await visible('[role=tree][aria-label="Sessions and repositories"]').count(), "sidebar tree missing")
  const errs = problems.filter((p) => p.check === current)
  expect(!errs.length, `console errors: ${errs.map((e) => e.text).join(" | ")}`)
  return `${nodes} map nodes`
})

check("needs-you: same count in title bar, sidebar and Sessions inbox", async () => {
  await load("#/map")
  // the one definition the UI uses (waiting + errors, subagent permissions included)
  const store = await app((s, _arg, sel) => sel.selectWaitingCount(s))
  const title = await page.evaluate(() => {
    const b = [...document.querySelectorAll("header button")].find((x) => x.querySelector("svg[class*='shield']"))
    return b?.textContent?.trim()
  })
  const sidebar = await page.evaluate(() => {
    const label = [...document.querySelectorAll("[role=tree] .section-label")].find((x) => x.textContent?.trim() === "Needs you")
    return label?.parentElement?.querySelector(".tabular")?.textContent?.trim() ?? "0"
  })
  await go("#/sessions")
  const inbox = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.offsetParent && x.textContent?.trim().startsWith("Needs you"))
    return b?.querySelector(".tabular")?.textContent?.trim() ?? "0"
  })
  expect(title !== undefined, "title bar attention button not found")
  expect(title === sidebar && sidebar === inbox, `title bar ${title}, sidebar ${sidebar}, Sessions ${inbox}`)
  expect(Number(title) === store, `UI shows ${title}, store says ${store}`)
  return `${title} everywhere`
})

check("map card: Allow once on a Bash permission", async () => {
  await load("#/map")
  const ids = await discover()
  expect(ids.bash, "no approvable Bash permission in the fixture")
  const card = node(ids.bash)
  await card.waitFor({ timeout: 5000 })
  await card.getByRole("button", { name: "Allow once" }).click()
  const st = await until(() => app((s, id) => (s.sessions[id].status !== "waiting_permission" ? s.sessions[id].status : null), ids.bash))
  expect(st, "session still waiting for permission")
  expect((await card.getByRole("button", { name: "Allow once" }).count()) === 0, "card still shows Allow once")
  await go(`#/session/${ids.bash}`)
  await wait(500)
  const waiting = await awaitingTools(ids.bash)
  expect(!waiting.includes("Bash"), "transcript still has a Bash call awaiting approval")
  expect((await visible('[role=log] [title="Waiting for your approval"]').count()) === 0, "transcript row still shows waiting")
  return `status → ${st}`
})

check("session dock: Allow once on a Bash permission", async () => {
  await load("#/map")
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
  await load("#/map")
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
  await load("#/map")
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
  await load("#/map")
  const ids = await discover()
  expect(ids.question, "no question request in the fixture")
  await go(`#/session/${ids.question}`)
  const card = visible('[aria-label="Question from Claude"]').first()
  await card.waitFor({ timeout: 5000 })
  const total = await app((s, id) => s.requests[id].questions.length, ids.questionReq)
  for (let i = 0; i < total; i++) {
    if (total > 1) await card.getByRole("tab").nth(i).click()
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
  await load("#/map")
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
  const header = await visible('button[title="Model, effort, permissions"]').first().innerText()
  expect(/accept edits/i.test(header), `header shows "${header}"`)
  return `${before} → acceptEdits`
})

check("archive from sidebar → Undo toast → Sessions › Archive → restore", async () => {
  await load("#/map")
  // a non-main session row in the sidebar tree (hover reveals its Archive button)
  const row = visible('[role=treeitem]:has(button[aria-label="Archive session"])').first()
  await row.waitFor({ timeout: 5000 })
  const title = await row.locator("[title]").first().getAttribute("title")
  const id = await app((s, t) => Object.values(s.sessions).find((x) => x.title === t && !x.archived)?.id, title)
  expect(id, `no live session titled "${title}"`)
  const archive = async () => {
    const r = visible(`[role=treeitem]:has([title="${title.replace(/"/g, '\\"')}"])`).first()
    await r.hover()
    await r.locator('button[aria-label="Archive session"]').click()
    expect(await until(() => app((s, id) => s.sessions[id].archived, id)), "session not archived")
  }
  await archive()
  const toast = visible("[role=status]", { hasText: "Archived" }).filter({ hasText: "Archived" }).first()
  await toast.waitFor({ timeout: 2000 })
  expect((await toast.innerText()).includes(title), "Undo toast doesn't name the session")
  await toast.getByRole("button", { name: "Undo" }).click()
  expect(await until(() => app((s, id) => !s.sessions[id].archived, id)), "Undo didn't restore")
  // archive again, find it in Sessions › Archive and restore it there
  await archive()
  await go("#/sessions")
  await visible("button", { hasText: /^Archive/ }).filter({ hasText: /^Archive/ }).first().click()
  await wait(400)
  const tableRow = visible('[data-qa="sessions-table"] .group\\/tr').filter({ hasText: title }).first()
  await tableRow.waitFor({ timeout: 3000 })
  await tableRow.hover()
  await tableRow.getByRole("button", { name: /Restore/ }).click()
  expect(await until(() => app((s, id) => !s.sessions[id].archived, id)), "Restore didn't bring it back")
  return title
})

check("search: History finds 'Rate limiting for /v1/chat' and Resume opens it", async () => {
  await load("#/sessions")
  const ids = await discover()
  expect(ids.history, "history session missing from the fixture")
  await page.locator('[data-qa="sessions-search"]:visible').fill("Rate limiting for /v1/chat")
  await wait(400)
  const historyTab = visible("button", { hasText: /^History/ }).filter({ hasText: /^History/ }).first()
  const count = (await historyTab.innerText()).replace(/\D+/g, "")
  expect(Number(count) >= 1, `History tab shows no matches ("${await historyTab.innerText()}")`)
  await historyTab.click()
  await wait(400)
  const row = visible('[data-qa="sessions-table"] .group\\/tr').filter({ hasText: "Rate limiting for /v1/chat" }).first()
  await row.waitFor({ timeout: 3000 })
  await row.hover()
  await row.getByRole("button", { name: /Resume/ }).click()
  await wait(500)
  const hash = await page.evaluate(() => location.hash)
  expect(hash === `#/session/${ids.history}`, `opened ${hash}`)
  const control = await app((s, id) => s.sessions[id].control, ids.history)
  expect(control === "owned", `control is ${control} after Resume`)
  expect((await visible("button", { hasText: "Rate limiting for /v1/chat" }).count()) > 0, "session header doesn't show the title")
})

check("palette: Ctrl+K → 'Find withRetry in code graph' focuses the node", async () => {
  await load("#/map")
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press("Control+k")
  const input = dialog().getByRole("combobox")
  await input.waitFor({ timeout: 3000 })
  expect(await input.evaluate((el) => el === document.activeElement), "palette input not focused")
  await page.keyboard.type("withRetry")
  const item = dialog().locator("[cmdk-item]", { hasText: "in code graph" }).first()
  await item.waitFor({ timeout: 3000 })
  expect((await item.innerText()).includes("withRetry"), "code graph item doesn't name the query")
  await item.click()
  await page.waitForFunction(() => location.hash.startsWith("#/graph/"), null, { timeout: 5000 })
  const search = visible('input[placeholder="Find symbol or file…"]').first()
  await search.waitFor({ timeout: 8000 })
  expect((await search.inputValue()) === "withRetry", `graph search holds "${await search.inputValue()}"`)
  // the graph loads and lays out asynchronously: open the first result once it is listed
  const result = await until(async () => (await page.locator("button", { hasText: "withRetry" }).filter({ has: page.locator("span.rounded-full") }).count()) > 0, 10000, 250)
  expect(result, "no withRetry result in the graph search")
  await search.focus()
  await page.keyboard.press("Enter")
  const framed = await until(async () => (await visible('button[aria-label="Frame in view"]').count()) > 0, 8000, 250)
  expect(framed, "node inspector didn't open")
  const panel = await visible('button[aria-label="Frame in view"]').first().locator("xpath=ancestor::*[contains(@class,'flex-col')][1]").innerText()
  expect(panel.includes("withRetry"), "node panel doesn't show withRetry")
})

check("new session dialog: creates a session and opens it with only the first prompt", async () => {
  await load("#/map")
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press("Control+n")
  const d = dialog()
  await d.waitFor({ timeout: 3000 })
  const prompt = "Add a dark mode toggle to the settings page"
  const field = d.getByRole("textbox", { name: "Prompt" })
  await field.fill(prompt)
  await d.getByRole("button", { name: /^Start/ }).click()
  await page.waitForFunction(() => location.hash.startsWith("#/session/"), null, { timeout: 4000 })
  expect((await page.locator("[role=dialog]:visible").count()) === 0, "dialog stayed open")
  const id = (await page.evaluate(() => location.hash)).split("/")[2]
  await wait(400)
  const t = await app((s, id) => {
    const tr = s.transcripts[id]
    const items = tr?.order.map((k) => tr.items[k]) ?? []
    return {
      first: s.sessions[id]?.firstPrompt,
      items: items.map((it) => (it.type === "agent_message" && it.id === tr.liveItemId ? "live_reply" : it.type)),
      userText: items.find((it) => it.type === "user_message")?.text,
    }
  }, id)
  expect(t.first === prompt, `firstPrompt is "${t.first}"`)
  // no generated history: the first prompt, then at most the live reply that is starting to stream
  const extra = t.items.slice(1).filter((x) => x !== "live_reply")
  expect(t.items[0] === "user_message" && t.userText === prompt && !extra.length, `transcript holds ${JSON.stringify(t.items)}`)
  expect((await transcriptText()).includes(prompt), "prompt not shown in the transcript")
})

check("preview tab is reused when opening two sessions", async () => {
  await load("#/map")
  const pick = await app((s) =>
    Object.values(s.sessions)
      .filter((x) => !x.archived && x.control !== "history" && x.role !== "main")
      .slice(0, 2)
      .map((x) => x.id),
  )
  for (const id of pick) {
    await action("openSession", id)
    await wait(500)
  }
  const tabs = await app((s) => s.tabs.filter((t) => !t.pinned).map((t) => ({ key: t.key, preview: !!t.preview })))
  expect(tabs.length === 1, `${tabs.length} session tabs open: ${JSON.stringify(tabs)}`)
  expect(tabs[0].key === `/session/${pick[1]}` && tabs[0].preview, `tab is ${JSON.stringify(tabs[0])}`)
  expect((await visible("[role=tab] .italic").count()) === 1, "preview tab not drawn as preview")
})

check("? opens the keyboard shortcuts overlay (Esc closes it)", async () => {
  await load("#/map")
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press("Shift+Slash")
  const d = page.getByRole("dialog", { name: "Keyboard shortcuts" })
  await d.waitFor({ timeout: 2000 })
  await page.keyboard.press("Escape")
  await d.waitFor({ state: "hidden", timeout: 2000 })
})

check("Esc closes the inspector", async () => {
  await load("#/map")
  const ids = await discover()
  await node(ids.bash).click({ position: { x: 30, y: 12 } })
  expect(await until(() => app((s) => s.panels.inspector)), "selecting a card didn't open the inspector")
  await visible('button[aria-label="Close inspector"]').first().waitFor({ timeout: 2000 })
  await page.keyboard.press("Escape")
  expect(await until(() => app((s) => !s.panels.inspector)), "inspector still open after Esc")
})

check("stress fixture boots and the map renders", async () => {
  const t0 = Date.now()
  await load("#/map", `${QUERY}&fixture=stress`)
  await page.waitForSelector(".react-flow__node", { timeout: 20000 })
  const nodes = await page.locator(".react-flow__node").count()
  const n = await app((s) => Object.keys(s.sessions).length)
  expect(n > 2000, `stress fixture has only ${n} sessions`)
  expect(nodes > 0, "map rendered no nodes")
  const errs = problems.filter((p) => p.check === current)
  expect(!errs.length, `console errors: ${errs.map((e) => e.text).join(" | ")}`)
  return `${n} sessions, ${nodes} nodes, ${Date.now() - t0} ms`
})

// ---------------- accessibility (session view, cards, composer, dialogs, toasts) ----------------
check("a11y: session view controls are named and the dock is a live region", async () => {
  await load("#/map")
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
  await load("#/map")
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
  await load("#/map")
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
  await load("#/map")
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
  await load("#/map")
  const row = visible('[role=treeitem]:has(button[aria-label="Archive session"])').first()
  await row.hover()
  await row.locator('button[aria-label="Archive session"]').click()
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

check("a11y: dialogs (new session, palette) label their fields; Esc closes", async () => {
  await load("#/map")
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press("Control+n")
  const d = dialog()
  await d.waitFor({ timeout: 3000 })
  await d.getByRole("button", { name: "Options" }).click()
  await wait(200)
  let bad = await unnamedControls("[role=dialog]")
  expect(!bad.length, `new session dialog:\n    ${bad.join("\n    ")}`)
  await page.keyboard.press("Escape")
  await page.locator("[role=dialog]").first().waitFor({ state: "hidden", timeout: 2000 })
  await page.keyboard.press("Control+k")
  await dialog().waitFor({ timeout: 3000 })
  bad = await unnamedControls("[role=dialog]")
  expect(!bad.length, `palette:\n    ${bad.join("\n    ")}`)
  await page.keyboard.press("Escape")
  await page.locator("[role=dialog]").first().waitFor({ state: "hidden", timeout: 2000 })
})

check("a11y: Escape closes the session settings menu and returns focus", async () => {
  await load("#/map")
  const ids = await discover()
  await go(`#/session/${ids.edit}`)
  const trigger = visible('button[title="Model, effort, permissions"]').first()
  await trigger.click()
  await visible("[role=menu]").first().waitFor({ timeout: 2000 })
  await page.keyboard.press("Escape")
  await page.locator("[role=menu]").first().waitFor({ state: "hidden", timeout: 2000 })
  expect(await trigger.evaluate((el) => el === document.activeElement), "focus didn't return to the menu trigger")
})

check("no uncaught page errors during the run", async () => {
  const errs = problems.filter((p) => p.type === "pageerror")
  expect(!errs.length, errs.map((e) => `[${e.check}] ${e.text}`).join(" | "))
})

// ---------------------------------------------------------------- a11y report (optional)
async function a11yReport() {
  console.log("\n--- a11y report (all areas) ---")
  await load("#/map")
  const ids = await discover()
  const screens = [
    ["map + sidebar + shell", "#/map"],
    ["sessions", "#/sessions"],
    ["session (permission)", `#/session/${ids.bash}`],
    ["session (question)", `#/session/${ids.question}`],
    ["review", `#/review/${ids.edit}`],
    ["repo", "#/repo/repo_api-gateway"],
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
// a pop-out window opened by the app is closed right away
context.on("page", (p) => {
  if (p !== page) void p.close().catch(() => {})
})

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
