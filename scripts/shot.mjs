// Dev tool: screenshot app routes with Playwright (system Chrome).
// Usage: node scripts/shot.mjs <outDir> "name|#/route|action;action" ...
// Actions: wait:ms, key:Control+K, click:<selector>, hover:<selector>, type:<text>, dblclick:<selector>
import { chromium } from "playwright"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [, , outDir, ...specs] = process.argv
const base = process.env.SHOT_BASE ?? "http://localhost:3000/"
const query = process.env.SHOT_QUERY ?? "?engine=off&debug=off"
const width = Number(process.env.SHOT_W ?? 1440)
const height = Number(process.env.SHOT_H ?? 900)
const scale = Number(process.env.SHOT_SCALE ?? 1)
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-gpu", "--ignore-gpu-blocklist"] })
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: "dark" })
const page = await context.newPage()
const logs = []
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`)
})
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`))

let first = true
for (const spec of specs) {
  const [name, route, actions = ""] = spec.split("|")
  const url = `${base}${query}${route}`
  if (first) {
    await page.goto(url, { waitUntil: "networkidle" })
    first = false
  } else {
    await page.evaluate((r) => {
      window.location.hash = r.replace(/^#/, "")
    }, route)
  }
  await page.waitForTimeout(700)
  for (const a of actions.split(";").filter(Boolean)) {
    const i = a.indexOf(":")
    const kind = a.slice(0, i)
    const arg = a.slice(i + 1)
    if (kind === "wait") await page.waitForTimeout(Number(arg))
    else if (kind === "key") await page.keyboard.press(arg)
    else if (kind === "click") await page.click(arg, { timeout: 5000 }).catch((e) => logs.push(`[shot] click ${arg}: ${e.message}`))
    else if (kind === "dblclick") await page.dblclick(arg, { timeout: 5000 }).catch((e) => logs.push(`[shot] dblclick ${arg}: ${e.message}`))
    else if (kind === "hover") await page.hover(arg, { timeout: 5000 }).catch((e) => logs.push(`[shot] hover ${arg}: ${e.message}`))
    else if (kind === "type") await page.keyboard.type(arg)
    else if (kind === "eval") await page.evaluate(arg)
  }
  await page.waitForTimeout(400)
  const file = join(outDir, `${name}.png`)
  await page.screenshot({ path: file })
  console.log(file)
}
writeFileSync(join(outDir, "console.log"), logs.join("\n"))
if (logs.length) console.log(`console: ${logs.length} warnings/errors → ${join(outDir, "console.log")}`)
await browser.close()
