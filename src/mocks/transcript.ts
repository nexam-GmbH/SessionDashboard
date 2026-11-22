import type { FileChange, ID, Item, PendingRequest, Session, ToolCall, ToolKind, Transcript, Turn } from "@/lib/model"
import { REAL } from "@/backend/mode"
import { ensureRealTranscript } from "@/backend/real"
import { getApp, setApp } from "@/store/app"
import type { RepoSpec } from "./catalog"
import { FOLLOW_UPS } from "./catalog"
import { Rng, hashString } from "./rng"

/**
 * Lazily generated, realistic transcripts. Shape mirrors what the
 * Phase 2 backend will produce from Claude Code stream-json / ACP updates:
 * turns of items (user message, thought, tool calls, agent message, notices).
 * Generated on first open of a session; background sessions never generate one.
 */

const MIN = 60_000

// ---------- code templates per language (for Edit diffs, Read output) ----------
interface CodePair {
  old: string
  next: string
}

function codeFor(lang: RepoSpec["language"], file: string, symbol: string, rng: Rng): CodePair {
  switch (lang) {
    case "Go":
      return rng.pick([
        {
          old: `func RoundMinor(amount decimal.Decimal, currency string) int64 {\n\treturn amount.Mul(decimal.NewFromInt(100)).Round(0).IntPart()\n}\n`,
          next: `// zeroDecimal lists ISO 4217 currencies without minor units.\nvar zeroDecimal = map[string]bool{"JPY": true, "KRW": true, "VND": true, "CLP": true}\n\nfunc RoundMinor(amount decimal.Decimal, currency string) int64 {\n\tif zeroDecimal[strings.ToUpper(currency)] {\n\t\treturn amount.Round(0).IntPart()\n\t}\n\treturn amount.Mul(decimal.NewFromInt(100)).Round(0).IntPart()\n}\n`,
        },
        {
          old: `func (h *Handler) ${symbol}(w http.ResponseWriter, r *http.Request) {\n\tevent, err := h.parse(r)\n\tif err != nil {\n\t\thttp.Error(w, err.Error(), http.StatusBadRequest)\n\t\treturn\n\t}\n\th.process(r.Context(), event)\n\tw.WriteHeader(http.StatusOK)\n}\n`,
          next: `func (h *Handler) ${symbol}(w http.ResponseWriter, r *http.Request) {\n\tevent, err := h.parse(r)\n\tif err != nil {\n\t\thttp.Error(w, err.Error(), http.StatusBadRequest)\n\t\treturn\n\t}\n\tseen, err := h.store.MarkProcessed(r.Context(), event.ID)\n\tif err != nil {\n\t\thttp.Error(w, "storage unavailable", http.StatusServiceUnavailable)\n\t\treturn\n\t}\n\tif seen {\n\t\tw.WriteHeader(http.StatusOK) // duplicate delivery: already handled\n\t\treturn\n\t}\n\th.process(r.Context(), event)\n\tw.WriteHeader(http.StatusOK)\n}\n`,
        },
      ])
    case "Python":
      return {
        old: `MODEL_MAP: dict[str, str] = {\n    "default": "claude-opus-5",\n    "fast": "claude-sonnet-5",\n    "cheap": "claude-haiku-4-5",\n}\n\n\ndef ${symbol}(alias: str) -> str:\n    return MODEL_MAP.get(alias, MODEL_MAP["default"])\n`,
        next: `MODEL_MAP: dict[str, str] = {\n    "default": "claude-opus-5-5",\n    "fast": "claude-sonnet-5-5",\n    "cheap": "claude-haiku-5-5",\n}\n\n\ndef ${symbol}(alias: str, *, tenant: str | None = None) -> str:\n    """Resolve a route alias to a model id, honoring tenant overrides."""\n    if tenant and (override := TENANT_OVERRIDES.get(tenant, {}).get(alias)):\n        return override\n    return MODEL_MAP.get(alias, MODEL_MAP["default"])\n`,
      }
    case "HCL":
      return {
        old: `module "postgres" {\n  source         = "../../modules/postgres"\n  name           = "staging-main"\n  engine_version = "16.4"\n  instance_class = "db.r6g.large"\n  parameter_group_family = "postgres16"\n}\n`,
        next: `module "postgres" {\n  source         = "../../modules/postgres"\n  name           = "staging-main"\n  engine_version = "17.2"\n  instance_class = "db.r6g.large"\n  parameter_group_family = "postgres17"\n\n  allow_major_version_upgrade = true\n}\n`,
      }
    case "Markdown":
      return {
        old: `## Secrets\n\n- Never commit .env files.\n- Use the secrets manager for production credentials.\n`,
        next: `## Secrets\n\n- Never commit .env files, keys, tokens or kubeconfigs.\n- Use the secrets manager for production credentials.\n- Never print secrets in logs, test output or error messages.\n- If a secret is found in the diff, stop and ask before continuing.\n`,
      }
    default:
      if (file.endsWith(".tsx")) {
        return {
          old: `export function ${symbol}({ tickets }: { tickets: Ticket[] }) {\n  return (\n    <Table>\n      {tickets.map((t) => (\n        <Row key={t.id} title={t.subject} status={t.status} />\n      ))}\n    </Table>\n  )\n}\n`,
          next: `export function ${symbol}({ tickets }: { tickets: TicketV3[] }) {\n  return (\n    <Table>\n      {tickets.map((t) => (\n        <Row\n          key={t.id}\n          title={t.subject}\n          status={t.state.kind}\n          assignee={t.assignee?.name}\n          slaDueAt={t.sla?.dueAt}\n        />\n      ))}\n    </Table>\n  )\n}\n`,
        }
      }
      {
        const base = file.split("/").pop() ?? file
        if (base.includes(".test.")) {
          const subject = base.split(".")[0].replace(/-./g, (m) => m[1].toUpperCase())
          return {
            old: `describe("${subject}", () => {\n  it("handles the happy path", async () => {\n    expect(await ${subject}(fixture())).toMatchSnapshot()\n  })\n})\n`,
            next: `describe("${subject}", () => {\n  it("handles the happy path", async () => {\n    expect(await ${subject}(fixture())).toMatchSnapshot()\n  })\n\n  it("keeps v2 payloads readable", async () => {\n    const out = await ${subject}(fixture({ version: 2 }))\n    expect(out.version).toBe(3)\n    expect(out.state.kind).toBe("open")\n  })\n})\n`,
          }
        }
        if (base.startsWith("migrate")) {
          return {
            old: `export function migrateV2toV3(t: TicketV2): TicketV3 {\n  return { ...t, version: 3 }\n}\n`,
            next: `export function migrateV2toV3(t: TicketV2): TicketV3 {\n  return {\n    ...t,\n    version: 3,\n    state: { kind: t.status === "closed" ? "closed" : "open", since: t.updatedAt },\n    sla: t.dueAt ? { dueAt: t.dueAt } : undefined,\n  }\n}\n`,
          }
        }
        if (base.startsWith("ticket")) {
          return {
            old: `export interface Ticket {\n  id: string\n  subject: string\n  status: "open" | "pending" | "closed"\n  dueAt?: string\n}\n`,
            next: `export interface TicketV3 {\n  id: string\n  version: 3\n  subject: string\n  state: { kind: "open" | "pending" | "closed"; since: string }\n  assignee?: { id: string; name: string }\n  sla?: { dueAt: string }\n}\n\n/** @deprecated read through migrateV2toV3 */\nexport type Ticket = TicketV2\n`,
          }
        }
        if (file.includes("/routes/") && !base.startsWith("ticket")) {
          const name = base.split(".")[0]
          return {
            old: `router.get("/v2/${name}", async (req, res) => {\n  const rows = await db.${name}.list(req.query)\n  res.json(rows)\n})\n`,
            next: `router.get("/v2/${name}", async (req, res) => {\n  const query = ListQuery.parse(req.query)\n  const rows = await db.${name}.list(query)\n  res.json(rows.map(toV3))\n})\n`,
          }
        }
        if (base.startsWith("sla")) {
          return {
            old: `export async function checkSla(ticket: Ticket) {\n  if (ticket.dueAt && Date.parse(ticket.dueAt) < Date.now()) await notify(ticket)\n}\n`,
            next: `export async function checkSla(ticket: TicketV3) {\n  const due = ticket.sla?.dueAt\n  if (!due || ticket.state.kind === "closed") return\n  if (Date.parse(due) < Date.now()) await notify(ticket, { reason: "sla_breach" })\n}\n`,
          }
        }
      }
      return rng.pick([
        {
          old: `export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {\n  let attempt = 0\n  while (true) {\n    try {\n      attempt++\n      return await fn()\n    } catch (err) {\n      attempt++\n      if (attempt >= (opts.maxAttempts ?? 3) || !isRetryable(err)) throw err\n      await sleep(backoff(attempt, opts))\n    }\n  }\n}\n`,
          next: `export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {\n  const maxAttempts = opts.maxAttempts ?? 3\n  for (let attempt = 1; ; attempt++) {\n    try {\n      return await fn()\n    } catch (err) {\n      metrics.retryAttempts.inc({ route: opts.route ?? "unknown" })\n      if (attempt >= maxAttempts || !isRetryable(err)) throw err\n      await sleep(backoff(attempt, opts))\n    }\n  }\n}\n`,
        },
        {
          old: `export function ${symbol}(req: Request): RateLimitResult {\n  const key = req.headers.get("x-api-key") ?? "anon"\n  return bucket.take(key)\n}\n`,
          next: `const WINDOW_MS = 60_000\n\nexport function ${symbol}(req: Request, limits = defaultLimits): RateLimitResult {\n  const key = req.headers.get("x-api-key") ?? clientIp(req)\n  const limit = limits[routeOf(req)] ?? limits.default\n  const result = bucket.take(key, { capacity: limit, refillMs: WINDOW_MS })\n  if (!result.ok) metrics.rateLimited.inc({ route: routeOf(req) })\n  return result\n}\n`,
        },
      ])
  }
}

function countLines(a: string, b: string) {
  const al = a.split("\n")
  const bl = b.split("\n")
  const set = new Set(al)
  const added = bl.filter((l) => !set.has(l)).length
  const bset = new Set(bl)
  const removed = al.filter((l) => !bset.has(l)).length
  return { added, removed }
}

function withLineNumbers(code: string, start: number) {
  return code
    .split("\n")
    .filter((_, i, arr) => i < arr.length - 1 || arr[i] !== "")
    .map((l, i) => `${String(start + i).padStart(4, " ")}  ${l}`)
    .join("\n")
}

function testOutput(lang: RepoSpec["language"], files: string[], ok: boolean) {
  if (lang === "Go") {
    return ok
      ? `ok  \tgithub.com/acme/${files[0]?.split("/")[1] ?? "pkg"}\t0.412s\nok  \tgithub.com/acme/internal/ledger\t0.188s`
      : `--- FAIL: TestRoundMinor/JPY (0.00s)\n    rounding_test.go:41: got 129900, want 1299\nFAIL\nexit status 1`
  }
  if (lang === "Python") {
    return ok ? `........                                                         [100%]\n8 passed in 0.41s` : `F.......\nFAILED tests/test_mapping.py::test_tenant_override - KeyError: 'acme'\n1 failed, 7 passed in 0.44s`
  }
  if (lang === "HCL") {
    return `Terraform will perform the following actions:\n\n  # module.postgres.aws_db_instance.this will be updated in-place\n  ~ resource "aws_db_instance" "this" {\n      ~ engine_version = "16.4" -> "17.2"\n        id             = "staging-main"\n    }\n\nPlan: 0 to add, 1 to change, 0 to destroy.`
  }
  const test = files.find((f) => f.includes("test")) ?? "test/index.test.ts"
  return ok
    ? ` ✓ ${test} (6 tests) 41ms\n ✓ test/rate-limit.test.ts (4 tests) 18ms\n\n Test Files  2 passed (2)\n      Tests  10 passed (10)\n   Start at  10:42:07\n   Duration  1.24s`
    : ` ✗ ${test} > counts one attempt per call\n   AssertionError: expected 4 to be 2\n    ❯ ${test}:38:24\n\n Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 9 passed (10)`
}

const THOUGHTS = [
  "The counter is incremented both before calling fn() and again in the catch block, so one failure burns two attempts. I'll restructure the loop so each iteration is exactly one attempt and keep the signature unchanged.",
  "Before editing I want to see every caller — if anything depends on the current attempt semantics the fix could change behavior elsewhere.",
  "The tests only cover the happy path. I'll add a failing regression test first, then make it pass.",
  "This touches a shared type. I'll check the generated client in the other packages before changing the shape.",
  "Plan: read the module, find usages with Graphify, make the minimal change, run the package tests.",
]

const SUMMARIES = (file: string, symbol: string, test: string) => [
  ...(symbol !== "withRetry" ? [] : [`Fixed. \`${symbol}\` counted one attempt twice on failure, so the default of 3 attempts really meant 2.\n\n**Changes**\n- \`${file}\`: one increment per attempt, plus a \`retry_attempts_total\` counter\n- \`${test}\`: regression test — one failure now produces exactly two calls\n\nAll 10 tests pass. The public signature is unchanged, so callers in other repos are unaffected.`]),
  `Done. Summary of what changed:\n\n1. \`${file}\` — updated \`${symbol}\` to the new shape\n2. Added a test in \`${test}\` covering the edge case from the issue\n3. Ran the package tests: **all green**\n\nOne thing to decide: the old field is still read in two places behind a feature flag. I left them as-is; tell me if you want them removed in this PR.`,
  `I made the change in \`${file}\` and verified it:\n\n\`\`\`text\nTests  10 passed (10)\n\`\`\`\n\nNext steps I'd suggest:\n- push the branch and open a draft PR\n- ask the owners of the two downstream services to bump the client`,
].map((t) => `${t}\n\nThe issue: [#42](https://example.com/acme/web-app/issues/42). For the channel:\n\n> Shipped today:\n>\n> - the retry fix\n> - its regression test`)

// ---------- builders ----------
interface Ctx {
  rng: Rng
  session: Session
  spec: RepoSpec | undefined
  at: number
  seq: number
  items: Record<ID, Item>
  order: ID[]
}

function id(ctx: Ctx, p: string) {
  ctx.seq++
  return `${p}_${ctx.session.id}_${ctx.seq}`
}

function push(ctx: Ctx, item: Item) {
  ctx.items[item.id] = item
  ctx.order.push(item.id)
  return item.id
}

function tool(
  ctx: Ctx,
  turnId: ID,
  name: string,
  kind: ToolKind,
  title: string,
  input: Record<string, unknown>,
  extra: Partial<ToolCall> = {},
): ID {
  const startedAt = new Date(ctx.at).toISOString()
  ctx.at += ctx.rng.int(800, 9000)
  const call: ToolCall = {
    id: `toolu_${ctx.rng.hex(20)}`,
    name,
    kind,
    title,
    status: "completed",
    display: "done",
    input,
    startedAt,
    completedAt: new Date(ctx.at).toISOString(),
    ...extra,
  }
  return push(ctx, { type: "tool_call", id: id(ctx, "t"), turnId, at: startedAt, call })
}

function buildTurn(ctx: Ctx, turnIndex: number, prompt: string, mode: "complete" | "live" | "permission" | "question" | "plan" | "error"): Turn {
  const { rng, session, spec } = ctx
  const turnId = id(ctx, "turn")
  const start = ctx.at
  const itemIds: ID[] = []
  const add = (x: ID) => itemIds.push(x)
  const files = spec?.files ?? ["README.md"]
  const lang = spec?.language ?? "TypeScript"
  // sessions in the same repo work on different files/symbols; a path named in the session's
  // activity or prompt wins, so the transcript matches what the map and sidebar say it is doing
  const offset = hashString(session.id)
  const named = [...[session.activity, prompt].join(" ").matchAll(/[\w-]+(?:\/[\w.-]+)+\.\w+/g)].map((m) => m[0]).find((f) => !/\.(test|spec)\./.test(f))
  const words = new Set(`${session.title} ${prompt}`.toLowerCase().split(/[^a-z0-9]+/))
  const titled = files.find((f) => !/\.(test|spec)\./.test(f) && words.has((f.split("/").pop() ?? "").split(".")[0].toLowerCase()))
  const file = turnIndex === 0 && (named ?? titled) ? (named ?? titled)! : files[(turnIndex + offset) % files.length]
  const test = files.find((f) => f.includes("test")) ?? files[files.length - 1]
  const symbols = spec?.symbols ?? ["main"]
  const symbol = symbols[(turnIndex + offset) % symbols.length]

  add(push(ctx, { type: "user_message", id: id(ctx, "u"), turnId, at: new Date(ctx.at).toISOString(), text: prompt }))
  ctx.at += rng.int(1500, 4000)
  if (rng.chance(0.75)) {
    add(push(ctx, { type: "thought", id: id(ctx, "th"), turnId, at: new Date(ctx.at).toISOString(), text: rng.pick(THOUGHTS), durationMs: rng.int(2000, 14000) }))
    ctx.at += rng.int(1000, 3000)
  }

  const code = codeFor(lang, file, symbol, rng)
  // reads + searches
  add(
    tool(ctx, turnId, "Read", "read", file, { file_path: file }, {
      locations: [{ path: file, line: 1 }],
      output: withLineNumbers(code.old, rng.int(12, 80)),
    }),
  )
  if (rng.chance(0.6)) {
    add(
      tool(ctx, turnId, "mcp__graphify__query_graph", "search", `Graphify: callers of ${symbol}`, { query: `callers of ${symbol}`, depth: 2 }, {
        output: `${symbol} ← 6 callers in 4 files (community "${file.split("/")[1] ?? "core"}")\n  ${files[1] ?? file}:42  ${symbol}(...)\n  ${files[2] ?? file}:17  ${symbol}(...)\n  ../web-app/lib/api/tickets.ts:88  (cross-repo, via HTTP)\nGod node nearby: UpstreamPool (degree 48)`,
      }),
    )
  }
  add(
    tool(ctx, turnId, "Grep", "search", `"${symbol}"`, { pattern: symbol, path: "." }, {
      output: files
        .slice(0, 4)
        .map((f, i) => `${f}:${20 + i * 13}:  ${i === 0 ? "export " : "  const r = await "}${symbol}(${i === 0 ? "" : "req"})`)
        .join("\n"),
    }),
  )
  if (rng.chance(0.35)) {
    add(tool(ctx, turnId, "Glob", "search", `**/*${file.split(".").pop() ? "." + file.split(".").pop() : ""}`, { pattern: `**/*.${file.split(".").pop()}` }, { output: files.join("\n") }))
  }

  // subagent spawn (link to a real subagent record)
  const subs = getApp().subagentIdsBySession[session.id] ?? []
  const subId = subs[turnIndex] ?? (turnIndex === 0 ? subs[0] : undefined)
  if (subId) {
    const sub = getApp().subagents[subId]
    add(
      tool(ctx, turnId, "Agent", "think", sub.description, { subagent_type: sub.agentType, description: sub.description, prompt: `${sub.description}. Report file paths and line numbers.` }, {
        subagentId: subId,
        status: sub.status === "running" || sub.status === "waiting_permission" ? "in_progress" : "completed",
        display: sub.status === "running" || sub.status === "waiting_permission" ? "running" : "done",
        output: sub.summary,
      }),
    )
  }

  if (turnIndex === 0 && (session.todo || rng.chance(0.8))) {
    // plan steps follow the session's todo counters so transcript and inspector agree
    const steps = [
      `Read ${file} and its tests`,
      `Find all callers of ${symbol}`,
      `Fix ${symbol}`,
      `Add regression test in ${test}`,
      "Run package tests",
      "Push branch and open a draft PR",
      "Update the changelog",
      "Summarize the diff",
    ]
    const total = session.todo?.total ?? 5
    const done = session.todo?.done ?? (mode === "complete" ? total : 2)
    const todos = steps.slice(0, total).map((content, i) => ({
      content,
      status: i < done ? ("completed" as const) : i === done && mode !== "complete" ? ("in_progress" as const) : ("pending" as const),
    }))
    add(tool(ctx, turnId, "TodoWrite", "think", "Update plan", { todos }, { output: `${todos.filter((t) => t.status === "completed").length}/${todos.length} done` }))
  }

  const { added, removed } = countLines(code.old, code.next)
  const change: FileChange = { path: file, op: "modify", oldText: code.old, newText: code.next, added, removed, review: "unreviewed" }

  if (mode === "permission") {
    const req = Object.values(getApp().requests).find((r): r is Extract<PendingRequest, { type: "permission" }> => r.type === "permission" && r.sessionId === session.id && r.state === "pending" && !r.subagentId)
    if (req?.toolName === "Edit") {
      const editPath = req.subject?.type === "tool_call" && req.subject.path ? req.subject.path : file
      const editCode = codeFor(lang, editPath, symbol, rng)
      const lines = countLines(editCode.old, editCode.next)
      add(
        tool(ctx, turnId, "Edit", "edit", editPath, { file_path: editPath, old_string: editCode.old, new_string: editCode.next }, {
          status: "pending",
          display: "awaiting_permission",
          locations: [{ path: editPath }],
          diff: [{ path: editPath, op: "modify", oldText: editCode.old, newText: editCode.next, added: lines.added, removed: lines.removed, review: "unreviewed" }],
          completedAt: undefined,
        }),
      )
    } else {
      add(tool(ctx, turnId, "Edit", "edit", file, { file_path: file }, { diff: [change] }))
      const command = req?.subject?.type === "command" ? req.subject.command : "npm test"
      add(tool(ctx, turnId, "Bash", "execute", command, { command, description: "Run the tests for the changed module" }, { status: "pending", display: "awaiting_permission", terminal: { command }, completedAt: undefined }))
    }
    return { id: turnId, sessionId: session.id, status: "in_progress", startedAt: new Date(start).toISOString(), itemIds }
  }

  if (mode === "question") {
    add(tool(ctx, turnId, "Edit", "edit", file, { file_path: file }, { diff: [change] }))
    add(
      tool(ctx, turnId, "AskUserQuestion", "other", session.waitingFor?.summary ?? "Question", { questions: [] }, { status: "pending", display: "awaiting_permission", completedAt: undefined }),
    )
    return { id: turnId, sessionId: session.id, status: "in_progress", startedAt: new Date(start).toISOString(), itemIds }
  }

  if (mode === "plan") {
    const req = Object.values(getApp().requests).find((r) => r.type === "plan" && r.sessionId === session.id)
    add(
      tool(ctx, turnId, "ExitPlanMode", "switch_mode", "Plan ready for approval", { plan: req?.type === "plan" ? req.planMarkdown : "" }, { status: "pending", display: "awaiting_permission", completedAt: undefined }),
    )
    return { id: turnId, sessionId: session.id, status: "in_progress", startedAt: new Date(start).toISOString(), itemIds }
  }

  add(tool(ctx, turnId, "Edit", "edit", file, { file_path: file, old_string: code.old, new_string: code.next }, { diff: [change] }))
  if (rng.chance(0.4)) {
    const testCode = lang === "Go" ? `func TestRoundMinor_JPY(t *testing.T) {\n\tif got := RoundMinor(decimal.RequireFromString("1299"), "JPY"); got != 1299 {\n\t\tt.Fatalf("got %d, want 1299", got)\n\t}\n}\n` : `it("counts one attempt per call", async () => {\n  const fn = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValue("ok")\n  await expect(withRetry(fn, { maxAttempts: 3 })).resolves.toBe("ok")\n  expect(fn).toHaveBeenCalledTimes(2)\n})\n`
    add(tool(ctx, turnId, "Write", "edit", test, { file_path: test, content: testCode }, { diff: [{ path: test, op: "add", oldText: "", newText: testCode, added: testCode.split("\n").length - 1, removed: 0, review: "unreviewed" }] }))
  }
  const command = lang === "Go" ? "go test ./internal/..." : lang === "Python" ? "pytest tests/ -q" : lang === "HCL" ? "terraform plan -out tf.plan" : "npm test -- --run"
  const failFirst = rng.chance(0.3) && mode !== "error"
  if (failFirst) {
    add(tool(ctx, turnId, "Bash", "execute", command, { command }, { terminal: { command, exitCode: 1 }, output: testOutput(lang, files, false), status: "failed", display: "failed" }))
    add(tool(ctx, turnId, "Edit", "edit", file, { file_path: file }, { diff: [{ ...change, oldText: code.next, newText: code.next.replace("return", "return /* fixed */"), added: 1, removed: 1 }] }))
  }
  if (rng.chance(0.15)) {
    add(tool(ctx, turnId, "WebFetch", "fetch", "https://www.iso.org/iso-4217-currency-codes.html", { url: "https://www.iso.org/iso-4217-currency-codes.html", prompt: "Which currencies have zero minor units?" }, { output: "JPY, KRW, VND, CLP, ISK, UGX… have 0 decimal places." }))
  }

  if (mode === "error") {
    add(tool(ctx, turnId, "Bash", "execute", command, { command }, { terminal: { command, exitCode: 0 }, output: testOutput(lang, files, true) }))
    ctx.at += 4000
    add(
      push(ctx, {
        type: "notice",
        id: id(ctx, "n"),
        turnId,
        at: new Date(ctx.at).toISOString(),
        severity: "error",
        text: session.errorMessage ?? "API error 529: overloaded. Claude stopped after 3 retries — send a message to continue.",
      }),
    )
    return { id: turnId, sessionId: session.id, status: "failed", startedAt: new Date(start).toISOString(), completedAt: new Date(ctx.at).toISOString(), itemIds }
  }

  if (mode === "live") {
    add(tool(ctx, turnId, "Bash", "execute", command, { command }, { terminal: { command }, status: "in_progress", display: "running", completedAt: undefined, output: lang === "TypeScript" ? ` ✓ ${test} (6 tests) 41ms\n` : "" }))
    const liveId = push(ctx, { type: "agent_message", id: id(ctx, "m"), turnId, at: new Date(ctx.at).toISOString(), text: "Tests are running. While they run: the change keeps the public signature, so", streaming: true })
    add(liveId)
    return { id: turnId, sessionId: session.id, status: "in_progress", startedAt: new Date(start).toISOString(), itemIds }
  }

  add(tool(ctx, turnId, "Bash", "execute", command, { command }, { terminal: { command, exitCode: 0 }, output: testOutput(lang, files, true) }))
  ctx.at += rng.int(2000, 6000)
  add(push(ctx, { type: "agent_message", id: id(ctx, "m"), turnId, at: new Date(ctx.at).toISOString(), text: rng.pick(SUMMARIES(file, symbol, test)), streaming: false }))
  const durationMs = ctx.at - start
  return {
    id: turnId,
    sessionId: session.id,
    status: "completed",
    startedAt: new Date(start).toISOString(),
    completedAt: new Date(ctx.at).toISOString(),
    itemIds,
    receipt: { durationMs, tokens: rng.int(8_000, 90_000), costUsd: Math.round(rng.float() * 60) / 100 + 0.04, filesChanged: rng.int(1, 4) },
  }
}

/**
 * The main agent plans and delegates instead of editing files: Graphify query across repos, a
 * per-repo plan, one SendMessage per delegated session, then status reports.
 */
function generateMainTranscript(session: Session): Transcript {
  const st = getApp()
  const rng = new Rng(session.id)
  const ctx: Ctx = { rng, session, spec: undefined, at: Date.parse(session.createdAt), seq: 0, items: {}, order: [] }
  const children = Object.values(st.sessions).filter((x) => x.parent?.sessionId === session.id && x.parent.kind === "delegated" && !x.archived)
  const repoName = (x: Session) => (x.repoId ? st.repos[x.repoId].name : "main")
  const turns: Turn[] = []

  // turn 1: plan + delegate
  const t1 = id(ctx, "turn")
  const start1 = ctx.at
  const items1: ID[] = []
  items1.push(push(ctx, { type: "user_message", id: id(ctx, "u"), turnId: t1, at: new Date(ctx.at).toISOString(), text: session.firstPrompt }))
  ctx.at += 3000
  items1.push(push(ctx, { type: "thought", id: id(ctx, "th"), turnId: t1, at: new Date(ctx.at).toISOString(), text: "First find every repo that reads tickets, then delegate one session per repo with the same instructions and keep v2 payloads working for one release.", durationMs: 9000 }))
  items1.push(
    tool(ctx, t1, "mcp__graphify__query_graph", "search", "Graphify: who reads TicketV2", { query: "consumers of TicketV2 across repos", scope: "global" }, {
      output: children.map((c) => `${repoName(c)}  ${c.title}`).join("\n") || "web-app, mobile-app, api-gateway",
    }),
  )
  const todos = [
    { content: "Find all consumers of the ticket schema", status: "completed" as const },
    ...children.map((c) => ({ content: `${repoName(c)}: ${c.title}`, status: c.status === "done_unseen" || c.status === "idle" ? ("completed" as const) : ("in_progress" as const) })),
    { content: "Release notes and deprecation date for v2", status: "pending" as const },
  ]
  items1.push(tool(ctx, t1, "TodoWrite", "think", "Update plan", { todos }, { output: `${todos.filter((t) => t.status === "completed").length}/${todos.length} done` }))
  for (const c of children) {
    items1.push(
      tool(ctx, t1, "SendMessage", "other", `Delegate to ${repoName(c)}`, { to: c.handle, message: `${c.title}. Keep v2 payloads accepted for one release; open a draft PR when green.` }, {
        output: `Started session "${c.title}" in ${repoName(c)}`,
      }),
    )
  }
  ctx.at += 4000
  items1.push(
    push(ctx, {
      type: "agent_message",
      id: id(ctx, "m"),
      turnId: t1,
      at: new Date(ctx.at).toISOString(),
      streaming: false,
      text: `Delegated to ${children.length} sessions:\n\n| Repo | Session |\n|---|---|\n${children.map((c) => `| ${repoName(c)} | ${c.title} |`).join("\n")}\n\nI'll report back when every PR is green.`,
    }),
  )
  turns.push({ id: t1, sessionId: session.id, status: "completed", startedAt: new Date(start1).toISOString(), completedAt: new Date(ctx.at).toISOString(), itemIds: items1, receipt: { durationMs: ctx.at - start1, tokens: 41_000, costUsd: 0.62, filesChanged: 0 } })

  // turn 2: status check (live while the main agent works)
  ctx.at += 40 * 60_000
  const t2 = id(ctx, "turn")
  const start2 = ctx.at
  const items2: ID[] = []
  items2.push(push(ctx, { type: "user_message", id: id(ctx, "u"), turnId: t2, at: new Date(ctx.at).toISOString(), text: "Where are we?" }))
  ctx.at += 2000
  const done = children.filter((c) => c.status === "done_unseen" || c.status === "idle")
  const waiting = children.filter((c) => c.status !== "done_unseen" && c.status !== "idle")
  const live = session.status === "working"
  const liveId = push(ctx, {
    type: "agent_message",
    id: id(ctx, "m"),
    turnId: t2,
    at: new Date(ctx.at).toISOString(),
    streaming: live,
    text: `${done.length} of ${children.length} done${done.length ? ` (${done.map(repoName).join(", ")})` : ""}. Still working: ${waiting.map(repoName).join(", ") || "none"}.${live ? " Checking the open PRs" : ""}`,
  })
  items2.push(liveId)
  turns.push({ id: t2, sessionId: session.id, status: live ? "in_progress" : "completed", startedAt: new Date(start2).toISOString(), itemIds: items2 })

  return { sessionId: session.id, turns, order: ctx.order, items: ctx.items, liveItemId: live ? liveId : undefined, queued: [], todos }
}

export function generateTranscript(session: Session, big = false): Transcript {
  if (session.role === "main") return generateMainTranscript(session)
  const st = getApp()
  const spec = session.repoId ? st.repoSpecs[session.repoId] : undefined
  const rng = new Rng(session.id)
  const turnsCount = big ? 2400 : session.control === "history" ? rng.int(2, 6) : rng.int(2, 5)
  const ctx: Ctx = { rng, session, spec, at: Date.parse(session.createdAt), seq: 0, items: {}, order: [] }
  const turns: Turn[] = []
  const lastMode =
    session.status === "working" || session.status === "starting"
      ? "live"
      : session.status === "waiting_permission"
        ? "permission"
        : session.status === "waiting_input"
          ? session.waitingFor?.kind === "plan"
            ? "plan"
            : "question"
          : session.status === "error"
            ? "error"
            : "complete"
  for (let i = 0; i < turnsCount; i++) {
    const last = i === turnsCount - 1
    const prompt = i === 0 ? session.firstPrompt : FOLLOW_UPS[(i + rng.int(0, 5)) % FOLLOW_UPS.length]
    if (i > 0 && i % 6 === 0) {
      const tid = `turn_c_${session.id}_${i}`
      push(ctx, { type: "compaction", id: id(ctx, "c"), turnId: tid, at: new Date(ctx.at).toISOString(), trigger: "auto", preTokens: rng.int(150_000, 190_000) })
    }
    turns.push(buildTurn(ctx, i, prompt, last ? lastMode : "complete"))
    ctx.at += rng.int(1, 20) * MIN
  }
  alignTimeline(ctx, turns, session, rng)
  const live = turns.at(-1)
  const liveItemId = live?.status === "in_progress" ? live.itemIds.findLast((x) => ctx.items[x].type === "agent_message" && (ctx.items[x] as { streaming: boolean }).streaming) : undefined
  const todoItem = ctx.order.map((x) => ctx.items[x]).findLast((x) => x.type === "tool_call" && x.call.name === "TodoWrite")
  const todos = todoItem?.type === "tool_call" ? ((todoItem.call.input.todos as Transcript["todos"]) ?? []) : []
  return {
    sessionId: session.id,
    turns,
    order: ctx.order,
    items: ctx.items,
    liveItemId,
    queued: session.status === "working" && rng.chance(0.4) ? [{ id: `q_${session.id}`, text: "Also update the changelog when you're done." }] : [],
    todos,
    // the prompt cache after the newest call (the context ring's warm / cold note)
    lastCall: { at: session.updatedAt, tokens: rng.int(40, 260) * 1000, ttl: 3600, model: session.model },
  }
}

/**
 * Shift every timestamp so the transcript ends where the session really is: a live turn started a
 * few minutes ago; a finished one completed at session.updatedAt (never in the future).
 */
function alignTimeline(ctx: Ctx, turns: Turn[], session: Session, rng: Rng) {
  const last = turns.at(-1)
  if (!last) return
  const now = Date.now()
  const target =
    last.status === "in_progress"
      ? Math.min(now - rng.int(90, 600) * 1000, now)
      : Math.min(Date.parse(session.updatedAt), now)
  const anchor = last.status === "in_progress" ? Date.parse(last.startedAt) : Date.parse(last.completedAt ?? last.startedAt)
  const delta = target - anchor
  if (!delta) return
  const sh = (iso?: string) => (iso ? new Date(Date.parse(iso) + delta).toISOString() : iso)
  for (const t of turns) {
    t.startedAt = sh(t.startedAt)!
    t.completedAt = sh(t.completedAt)
  }
  for (const id of ctx.order) {
    const it = ctx.items[id]
    it.at = sh(it.at)!
    if (it.type === "tool_call") {
      it.call.startedAt = sh(it.call.startedAt)!
      it.call.completedAt = sh(it.call.completedAt)
    }
  }
}

export function ensureTranscript(sessionId: ID) {
  // the desktop app reads the real transcript (backend/real.ts)
  if (REAL) return ensureRealTranscript(sessionId)
  const st = getApp()
  if (st.transcripts[sessionId]) return
  const session = st.sessions[sessionId]
  if (!session) return
  // a session created in the app moments ago starts with just its first prompt, not a fake history
  if (session.firstPrompt && session.role !== "main" && Date.now() - Date.parse(session.createdAt) < 5 * 60_000) {
    setApp((s) => ({ transcripts: { ...s.transcripts, [sessionId]: { sessionId, turns: [], order: [], items: {}, queued: [], todos: [] } } }))
    appendUserMessage(sessionId, session.firstPrompt)
    return
  }
  const t = generateTranscript(session)
  setApp((s) => ({ transcripts: { ...s.transcripts, [sessionId]: t } }))
}

// ---------- live streaming simulation ----------
const STREAM_WORDS =
  "callers in other repos are unaffected. I also checked the cross-repo usages Graphify reported: web-app only reads the response shape, and the api-gateway client already tolerates the new optional fields. Once the suite finishes I'll push the branch and summarize the diff.".split(" ")

let streamTimer: ReturnType<typeof setInterval> | null = null
function ensureStreamer() {
  if (streamTimer) return
  streamTimer = setInterval(() => {
    const st = getApp()
    if (!st.engine.running) return
    let changed = false
    const transcripts = { ...st.transcripts }
    for (const sid in st.transcripts) {
      const t = st.transcripts[sid]
      const sess = st.sessions[sid]
      if (!t.liveItemId || sess?.status !== "working") continue
      const item = t.items[t.liveItemId]
      if (item?.type !== "agent_message") continue
      const n = item.text.split(" ").length
      const word = STREAM_WORDS[n % STREAM_WORDS.length]
      transcripts[sid] = { ...t, items: { ...t.items, [item.id]: { ...item, text: `${item.text} ${word}` } } }
      changed = true
    }
    if (changed) setApp({ transcripts })
  }, 120)
}
ensureStreamer()

let msgSeq = 0
/** User sends a message: new turn with the user message and a streaming reply. */
export function appendUserMessage(sessionId: ID, text: string, attachments?: string[]) {
  ensureTranscript(sessionId)
  const t = getApp().transcripts[sessionId]
  if (!t) return
  const now = new Date().toISOString()
  const turnId = `turn_u_${sessionId}_${++msgSeq}`
  const uId = `u_live_${sessionId}_${msgSeq}`
  const mId = `m_live_${sessionId}_${msgSeq}`
  const items = { ...t.items }
  // finish any previous live message
  if (t.liveItemId && items[t.liveItemId]?.type === "agent_message") {
    items[t.liveItemId] = { ...(items[t.liveItemId] as Extract<Item, { type: "agent_message" }>), streaming: false }
  }
  items[uId] = { type: "user_message", id: uId, turnId, at: now, text, ...(attachments?.length ? { attachments } : {}) }
  items[mId] = { type: "agent_message", id: mId, turnId, at: now, text: "On it —", streaming: true }
  const turn: Turn = { id: turnId, sessionId, status: "in_progress", startedAt: now, itemIds: [uId, mId] }
  setApp((s) => ({
    transcripts: {
      ...s.transcripts,
      [sessionId]: { ...t, items, order: [...t.order, uId, mId], turns: [...t.turns, turn], liveItemId: mId },
    },
  }))
}
