import type {
  AppNotification,
  ControlMode,
  GitSnapshot,
  ID,
  PendingRequest,
  PermissionMode,
  Repo,
  Session,
  SessionStatus,
  Subagent,
  Worktree,
} from "@/lib/model"
import {
  CITY_HANDLES,
  HISTORY_TASKS,
  REPO_CATALOG,
  SUBAGENT_TYPES,
  type RepoSpec,
} from "./catalog"
import { Rng } from "./rng"

/** The owner's real scale: 5–6 repos, 2–4 live sessions each. */
const REPOS = ["api-gateway", "web-app", "ticketing", "llm-router", "infra"]

export interface World {
  repos: Record<ID, Repo>
  repoOrder: ID[]
  repoSpecs: Record<ID, RepoSpec>
  sessions: Record<ID, Session>
  sessionIdsByRepo: Record<ID, ID[]>
  mainSessionId: ID
  subagents: Record<ID, Subagent>
  subagentIdsBySession: Record<ID, ID[]>
  requests: Record<ID, PendingRequest>
  notifications: AppNotification[]
}

const HOME = "/home/dev/code"
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

type Script = {
  repo: string
  task: string
  status: SessionStatus
  control?: ControlMode
  model?: string
  perm?: PermissionMode
  subagents?: number
  delegated?: boolean
  request?: "bash" | "edit" | "question" | "plan"
  activity?: string
  error?: string
  bg?: number
}

/** Hand-placed live sessions: every state once, 2–4 per repo. */
const SCRIPT: Script[] = [
  { repo: "api-gateway", task: "Fix auth retry double-counting attempts", status: "waiting_permission", control: "pty", request: "bash", subagents: 1 },
  { repo: "api-gateway", task: "Add rate limiter to /v2/completions", status: "working", activity: "Editing src/middleware/rate-limit.ts" },
  { repo: "api-gateway", task: "Accept ticket v3 payloads on /v2/tickets", status: "done_unseen", delegated: true },
  { repo: "web-app", task: "Ticket schema v3 in the dashboard", status: "working", delegated: true, subagents: 2, activity: "Editing components/TicketTable.tsx" },
  { repo: "web-app", task: "Rewrite pricing page copy", status: "waiting_input", request: "question", model: "claude-sonnet-5-5" },
  { repo: "web-app", task: "Fix hydration warning on tickets page", status: "idle" },
  { repo: "ticketing", task: "Roll out ticket-schema v3", status: "working", delegated: true, subagents: 3, activity: "Waiting on 2 subagents" },
  { repo: "ticketing", task: "SLA breach notifications", status: "error", error: "API error 529: overloaded (gave up after 3 retries)" },
  { repo: "llm-router", task: "Update model mapping for opus-5.5", status: "waiting_permission", request: "edit" },
  { repo: "llm-router", task: "Fallback chain per tenant", status: "working", activity: "Reading router/fallbacks.py", model: "claude-sonnet-5-5" },
  { repo: "infra", task: "Bump Postgres to 17 in staging", status: "waiting_input", request: "plan", perm: "plan" },
  { repo: "infra", task: "PodDisruptionBudget for the gateway", status: "idle", control: "observed" },
]

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-")
}

function iso(t: number) {
  return new Date(t).toISOString()
}

export function generateWorld(now = Date.now()): World {
  const rng = new Rng(20261114)
  const repos: Record<ID, Repo> = {}
  const repoSpecs: Record<ID, RepoSpec> = {}
  const repoOrder: ID[] = []
  const sessions: Record<ID, Session> = {}
  const sessionIdsByRepo: Record<ID, ID[]> = {}
  const subagents: Record<ID, Subagent> = {}
  const subagentIdsBySession: Record<ID, ID[]> = {}
  const requests: Record<ID, PendingRequest> = {}
  const notifications: AppNotification[] = []
  const usedHandles = new Set<string>()

  // ---------- repos ----------
  const specs: RepoSpec[] = REPOS.map((name) => REPO_CATALOG.find((r) => r.name === name)!)
  for (const spec of specs) {
    const id = `repo_${spec.name}`
    const rootPath = `${HOME}/${spec.name}`
    const defaultBranch = spec.language === "Go" ? "master" : "main"
    const mainGit = makeGit(rng, now, rng.chance(0.6) ? "clean" : "modified", true)
    repos[id] = {
      id,
      name: spec.name,
      rootPath,
      defaultBranch,
      language: spec.language,
      worktrees: [
        { id: `${id}::${rootPath}`, repoId: id, path: rootPath, branch: defaultBranch, isMain: true, git: mainGit },
      ],
      sharedRuleFiles:
        spec.name === "shared-rules"
          ? ["rules/CLAUDE.base.md"]
          : ["CLAUDE.md", "../shared-rules/rules/CLAUDE.base.md", `../shared-rules/rules/${spec.language === "Go" ? "go" : spec.language === "Python" ? "python" : "typescript"}.md`],
      pinned: spec.name === "ticketing" || spec.name === "api-gateway",
      addedAt: iso(now - rng.int(20, 200) * DAY),
    }
    repoSpecs[id] = spec
    repoOrder.push(id)
    sessionIdsByRepo[id] = []
  }

  const handleFor = () => {
    for (let i = 0; i < 200; i++) {
      const h = rng.pick(CITY_HANDLES) + (i > 20 ? `-${rng.int(2, 99)}` : "")
      if (!usedHandles.has(h)) {
        usedHandles.add(h)
        return h
      }
    }
    return `s-${rng.hex(4)}`
  }

  // ---------- main agent ----------
  const mainSessionId = "s_main"
  const delegatedRepos = ["ticketing", "web-app", "api-gateway"].map((n) => `repo_${n}`)
  sessions[mainSessionId] = {
    id: mainSessionId,
    provider: "claude-code",
    providerSessionIds: [rng.uuid(), rng.uuid()],
    role: "main",
    title: "Roll out ticket-schema v3 across repos",
    titleSource: "custom",
    titleLocked: true,
    firstPrompt:
      "Ticket schema v3 is merged in ticketing. Roll it out to every repo that reads tickets: web-app and api-gateway. Delegate one session per repo, keep the public API backwards compatible for one release, and report back when all PRs are green.",
    repoId: null,
    worktreeId: null,
    cwd: "/home/dev/.session-dashboard/main",
    additionalDirs: delegatedRepos.map((r) => repos[r].rootPath),
    control: "owned",
    kind: "interactive",
    status: "working",
    statusObservedAt: iso(now - 40_000),
    activity: "Waiting on web-app",
    model: "claude-opus-5-5",
    effort: "high",
    permissionMode: "default",
    usage: { contextPct: 34, inputTokens: 182_000, outputTokens: 21_400, costUsd: 3.42 },
    diff: { filesChanged: 0, linesAdded: 0, linesRemoved: 0, unpushed: 0 },
    backgroundTasks: 0,
    todo: { done: 2, total: 5 },
    handle: "main",
    createdAt: iso(now - 3 * HOUR),
    updatedAt: iso(now - 40_000),
    lastViewedAt: iso(now - 20 * MIN),
    pinned: true,
    archived: false,
  }

  // ---------- live sessions ----------
  const makeSession = (
    repoId: ID,
    task: string,
    status: SessionStatus,
    opts: Partial<Script> & { createdAgo: number; history?: boolean; archived?: boolean },
  ): Session => {
    const repo = repos[repoId]
    const spec = repoSpecs[repoId]
    const id = `s_${rng.hex(8)}`
    const slug = slugify(task)
    const isHistory = !!opts.history
    const control: ControlMode = isHistory ? "history" : (opts.control ?? (rng.chance(0.2) ? "pty" : "owned"))
    let worktreeId: ID | null = null
    let cwd = repo.rootPath
    if (!isHistory || rng.chance(0.3)) {
      let wtPath = `${repo.rootPath}/.claude/worktrees/${slug}`
      if (repo.worktrees.some((w) => w.path === wtPath)) wtPath = `${wtPath}-${rng.hex(3)}`
      const wt: Worktree = {
        id: `${repoId}::${wtPath}`,
        repoId,
        path: wtPath,
        branch: `wt/${wtPath.split("/").pop()}`,
        isMain: false,
        git: makeGit(rng, now, status === "idle" || isHistory ? (rng.chance(0.5) ? "ahead" : "clean") : "modified", false),
      }
      repo.worktrees.push(wt)
      worktreeId = wt.id
      cwd = wtPath
    }
    const createdAt = now - opts.createdAgo
    const updatedAgo = isHistory
      ? opts.createdAgo - rng.int(5, 90) * MIN
      : status === "working"
        ? rng.int(2, 50) * 1000
        : status === "idle"
          ? rng.int(20, 600) * MIN
          : rng.int(1, 25) * MIN
    const working = status === "working" || status === "waiting_permission" || status === "waiting_input"
    const filesChanged = isHistory ? rng.int(0, 9) : status === "idle" ? rng.int(0, 4) : rng.int(1, 9)
    const session: Session = {
      id,
      provider: "claude-code",
      providerSessionIds: rng.chance(0.25) ? [rng.uuid(), rng.uuid()] : [rng.uuid()],
      role: "standard",
      title: task,
      titleSource: rng.chance(0.3) ? "custom" : "ai",
      titleLocked: false,
      firstPrompt: `${task}. ${firstPromptDetail(spec, rng)}`,
      repoId,
      worktreeId,
      cwd,
      additionalDirs: [],
      control,
      kind: control === "observed" ? "interactive" : rng.chance(0.1) ? "background" : "interactive",
      status,
      statusObservedAt: iso(now - updatedAgo),
      activity: opts.activity,
      errorMessage: opts.error,
      lastStopReason: status === "error" ? "error" : status === "idle" || status === "done_unseen" ? "end_turn" : undefined,
      model: opts.model ?? (rng.chance(0.72) ? "claude-opus-5-5" : "claude-sonnet-5-5"),
      effort: rng.pick(["high", "high", "xhigh", "medium"] as const),
      permissionMode: opts.perm ?? rng.pick(["default", "default", "default", "acceptEdits", "auto"] as const),
      usage: {
        contextPct: isHistory ? rng.int(10, 95) : rng.int(6, 88),
        // what get_context_usage reports for sessions the app runs (details panel)
        context: (() => {
          const max = 1_000_000
          const msgs = rng.int(40_000, 600_000)
          const cats = [
            { name: "Messages", tokens: msgs, kind: "used" },
            { name: "System tools", tokens: 28_400, kind: "used" },
            { name: "MCP tools", tokens: 14_000, kind: "used" },
            { name: "System prompt", tokens: 10_500, kind: "used" },
            { name: "Skills", tokens: 4_800, kind: "used" },
            { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
          ]
          const used = cats.filter((c) => c.kind === "used").reduce((n, c) => n + c.tokens, 0)
          return { used, max, categories: [...cats, { name: "Free space", tokens: max - used - 33_000, kind: "free" }] }
        })(),
        inputTokens: rng.int(20_000, 900_000),
        outputTokens: rng.int(2_000, 80_000),
        costUsd: Math.round(rng.float() * (working ? 4 : 2.5) * 100) / 100 + 0.08,
      },
      diff: {
        filesChanged,
        linesAdded: filesChanged ? rng.int(4, 240) : 0,
        linesRemoved: filesChanged ? rng.int(0, 90) : 0,
        unpushed: status === "idle" || status === "done_unseen" || isHistory ? rng.int(0, 3) : 0,
      },
      backgroundTasks: opts.bg ?? 0,
      todo: working && rng.chance(0.6) ? (() => { const t = rng.int(3, 8); return { total: t, done: rng.int(0, t - 1) } })() : undefined,
      handle: handleFor(),
      createdAt: iso(createdAt),
      updatedAt: iso(now - updatedAgo),
      lastViewedAt: status === "done_unseen" ? iso(createdAt + 5 * MIN) : iso(now - updatedAgo + MIN),
      pinned: false,
      archived: !!opts.archived,
      archivedAt: opts.archived ? iso(now - updatedAgo + rng.int(1, 48) * HOUR) : undefined,
    }
    // how its work ended (lib/outcome), as a real session gets it from its transcript and git;
    // from its id, so the rest of the sample world stays as it was
    if (status === "idle" || status === "done_unseen" || status === "stopped") {
      const r = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1000, 7) / 1000
      const n = session.diff.unpushed
      session.outcome =
        r < 0.12 ? { tone: "red", kind: "limit", label: "Hit the usage limit" }
        : r < 0.2 ? { tone: "red", kind: "aborted", label: "Stopped before it finished" }
        : !filesChanged ? { tone: "green", kind: "done", label: "Done" }
        : n ? { tone: "yellow", kind: "unpushed", label: `${n} commit${n > 1 ? "s" : ""} not pushed` }
        : r < 0.5 ? { tone: "yellow", kind: "no_pr", label: "No PR yet" }
        : r < 0.8 ? { tone: "green", kind: "pr", label: `PR #${100 + Math.round(r * 800)}` }
        : { tone: "green", kind: "merged", label: "Branch merged" }
    }
    if (opts.delegated) {
      session.parent = { sessionId: mainSessionId, kind: "delegated" }
    }
    sessions[id] = session
    sessionIdsByRepo[repoId].push(id)
    return session
  }

  const addSubagents = (session: Session, count: number, forceStatuses?: Subagent["status"][]) => {
    const ids: ID[] = []
    for (let i = 0; i < count; i++) {
      const t = rng.pick(SUBAGENT_TYPES)
      const status: Subagent["status"] =
        forceStatuses?.[i] ??
        (session.status === "working" ? rng.pick(["running", "completed"] as const) : "completed")
      const startedAgo = rng.int(1, 40) * MIN
      const id = `a_${rng.hex(8)}`
      subagents[id] = {
        id,
        sessionId: session.id,
        parentToolUseId: `toolu_${rng.hex(20)}`,
        agentType: t.type,
        description: rng.pick(t.tasks),
        status,
        background: rng.chance(0.3),
        spawnDepth: 1,
        lastTool: rng.pick(["Grep", "Read", "Bash", "Glob", "Edit"]),
        toolCount: rng.int(3, 42),
        startedAt: iso(now - startedAgo),
        finishedAt: status === "completed" || status === "failed" ? iso(now - startedAgo + rng.int(1, 10) * MIN) : undefined,
        summary: status === "completed" ? "Found 6 call sites; 2 need the new signature." : undefined,
      }
      ids.push(id)
    }
    subagentIdsBySession[session.id] = [...(subagentIdsBySession[session.id] ?? []), ...ids]
    return ids
  }

  {
    for (const s of SCRIPT) {
      const repoId = `repo_${s.repo}`
      const session = makeSession(repoId, s.task, s.status, {
        ...s,
        createdAgo: rng.int(20, 300) * MIN,
      })
      if (s.subagents) {
        const forced: Subagent["status"][] | undefined =
          s.repo === "ticketing"
            ? ["running", "waiting_permission", "completed"]
            : s.repo === "web-app"
              ? ["running", "completed"]
              : undefined
        const ids = addSubagents(session, s.subagents, forced)
        if (s.repo === "ticketing") {
          // one nested subagent (spawnDepth 2) under the running general-purpose agent
          const parent = subagents[ids[0]]
          parent.agentType = "general-purpose"
          parent.description = "Update fixtures to v3"
          const nestedId = `a_${rng.hex(8)}`
          subagents[nestedId] = {
            ...parent,
            id: nestedId,
            parentSubagentId: parent.id,
            agentType: "Explore",
            description: "Find fixtures that embed v2 tickets",
            spawnDepth: 2,
            status: "running",
            toolCount: 9,
            lastTool: "Grep",
          }
          subagentIdsBySession[session.id].push(nestedId)
          const waiting = subagents[ids[1]]
          waiting.agentType = "test-runner"
          waiting.description = "Run package tests"
          addRequest(requests, rng, session, now, "bash", waiting.id, "pnpm --filter @acme/schema test")
        }
      }
      if (s.request) {
        addRequest(requests, rng, session, now, s.request)
      }
    }
  }

  // delegated children for the main agent: make sure each delegated repo has one
  for (const repoId of delegatedRepos) {
    const hasDelegated = sessionIdsByRepo[repoId].some((id) => sessions[id].parent?.kind === "delegated")
    if (!hasDelegated && sessionIdsByRepo[repoId][0]) {
      sessions[sessionIdsByRepo[repoId][0]].parent = { sessionId: mainSessionId, kind: "delegated" }
    }
  }

  // a forked session (web-app pricing → fork)
  {
    const pricing = Object.values(sessions).find((s) => s.title === "Rewrite pricing page copy")
    if (pricing) {
      const fork = makeSession(pricing.repoId!, "Rewrite pricing page copy (shorter variant)", "idle", {
        createdAgo: 50 * MIN,
        model: "claude-sonnet-5-5",
      })
      fork.parent = { sessionId: pricing.id, kind: "forked", atMessageId: `m_${rng.hex(6)}` }
    }
  }

  // ---------- history ----------
  const historyCount = 14
  const archivedCount = 4
  for (let i = 0; i < historyCount; i++) {
    const repoId = rng.pick(repoOrder)
    const spec = repoSpecs[repoId]
    const task = rng.chance(0.5) ? rng.pick(spec.tasks) : rng.pick(HISTORY_TASKS)
    makeSession(repoId, task, "stopped", {
      history: true,
      archived: i < archivedCount,
      createdAgo: rng.int(1, 60) * DAY + rng.int(0, 600) * MIN,
    })
  }

  // a "yesterday" session to find and resume (usability walkthrough task)
  {
    makeSession("repo_api-gateway", "Rate limiting for /v1/chat", "stopped", { history: true, createdAgo: 26 * HOUR })
  }

  // ---------- notifications ----------
  for (const s of Object.values(sessions)) {
    if (s.archived || s.control === "history") continue
    const kind =
      s.status === "waiting_permission" ? "permission" :
      s.status === "waiting_input" ? "question" :
      s.status === "error" ? "error" :
      s.status === "done_unseen" ? "finished" : null
    if (!kind) continue
    const repoName = s.repoId ? repos[s.repoId].name : "main"
    notifications.push({
      id: `n_${rng.hex(8)}`,
      sessionId: s.id,
      kind,
      groupKey: `${s.id}:${kind}`,
      count: 1,
      title: `${repoName} · ${s.title}`,
      body:
        kind === "permission" ? (s.waitingFor?.summary ?? "Needs permission") :
        kind === "question" ? (s.waitingFor?.summary ?? "Has a question") :
        kind === "error" ? (s.errorMessage ?? "Stopped with an error") : "Finished",
      createdAt: s.statusObservedAt,
      readAt: rng.chance(0.3) ? s.statusObservedAt : undefined,
    })
  }
  notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  // one session stopped at the usage limit: the "continue at reset" card
  const idle = Object.values(sessions).find((x) => x.status === "idle" && !x.archived && x.control !== "history" && x.role !== "main")
  if (idle) {
    idle.lastText = "You've hit your 5-hour limit · resets 4pm"
    idle.activity = idle.lastText
  }

  // two api-gateway sessions on the same file: the overlap warning
  const gw = Object.values(repos).find((r) => r.name === "api-gateway")
  const pair = gw ? (sessionIdsByRepo[gw.id] ?? []).map((id) => sessions[id]).filter((x) => x && !x.archived && x.control !== "history").slice(0, 2) : []
  if (pair.length === 2) {
    pair[0].editedPaths = [`${pair[0].cwd}/src/auth/retry.ts`, `${pair[0].cwd}/src/routes/tickets.ts`]
    pair[1].editedPaths = [`${pair[1].cwd}/src/routes/tickets.ts`, `${pair[1].cwd}/src/middleware/rate-limit.ts`]
    for (const x of pair) x.updatedAt = new Date().toISOString()
  }

  return {
    repos,
    repoOrder,
    repoSpecs,
    sessions,
    sessionIdsByRepo,
    mainSessionId,
    subagents,
    subagentIdsBySession,
    requests,
    notifications,
  }
}

function firstPromptDetail(spec: RepoSpec, rng: Rng) {
  const f = rng.pick(spec.files)
  return rng.pick([
    `Start from ${f} and keep the change small.`,
    `The relevant code is around ${f}. Add a test that fails before the fix.`,
    `Check ${f} first; I think the bug is there. Don't change the public API.`,
    `Look at ${f} and the tests next to it. Run the tests when you're done.`,
  ])
}

function makeGit(rng: Rng, now: number, mode: GitSnapshot["state"], isMain: boolean): GitSnapshot {
  const modified = mode === "modified" || mode === "diverged"
  const filesChanged = modified ? rng.int(1, 9) : 0
  const ahead = mode === "ahead" || mode === "diverged" ? rng.int(1, 5) : 0
  const behind = isMain ? (rng.chance(0.3) ? rng.int(1, 6) : 0) : rng.chance(0.2) ? rng.int(1, 3) : 0
  const hasPr = !isMain && rng.chance(0.35)
  return {
    state: mode,
    filesChanged,
    linesAdded: filesChanged ? rng.int(3, 220) : 0,
    linesRemoved: filesChanged ? rng.int(0, 80) : 0,
    untracked: modified && rng.chance(0.3) ? rng.int(1, 3) : 0,
    ahead,
    behind,
    unpushed: ahead,
    pr: hasPr
      ? {
          number: rng.int(80, 2400),
          state: rng.pick(["open", "open", "draft", "merged"] as const),
          checks: rng.pick(["passing", "passing", "pending", "failing"] as const),
        }
      : undefined,
    observedAt: new Date(now - rng.int(5, 300) * 1000).toISOString(),
  }
}

function addRequest(
  requests: Record<ID, PendingRequest>,
  rng: Rng,
  session: Session,
  now: number,
  kind: "bash" | "edit" | "question" | "plan",
  subagentId?: ID,
  commandOverride?: string,
) {
  const id = `r_${rng.hex(8)}`
  const requestedAt = session.statusObservedAt ?? new Date(now - 60_000).toISOString()
  if (kind === "bash") {
    const command =
      commandOverride ??
      (session.title.includes("retry") ? "npm test -- retry" : rng.pick(["npm run test:unit", "go test ./...", "pytest tests/ -q", "terraform plan -out tf.plan"]))
    const prefix = command.split(" ").slice(0, 2).join(" ")
    requests[id] = {
      type: "permission",
      id,
      sessionId: session.id,
      subagentId,
      toolCallId: `toolu_${rng.hex(20)}`,
      toolName: "Bash",
      title: "Bash command",
      description: "Run the test suite for the changed module",
      subject: { type: "command", command, cwd: session.cwd },
      options: [
        { id: "allow-once", name: "Yes", kind: "allow_once" },
        { id: "allow-always", name: `Yes, and don't ask again for ${prefix}:* in this project`, kind: "allow_always" },
        { id: "reject", name: "No, and tell Claude what to do differently", kind: "reject_once" },
      ],
      state: "pending",
      requestedAt,
    }
    if (!subagentId) session.waitingFor = { kind: "permission", summary: `Bash: ${command}`, requestId: id }
  } else if (kind === "edit") {
    const path = session.title.includes("mapping") ? "router/mapping.py" : "src/index.ts"
    requests[id] = {
      type: "permission",
      id,
      sessionId: session.id,
      toolCallId: `toolu_${rng.hex(20)}`,
      toolName: "Edit",
      title: `Edit ${path}`,
      subject: { type: "tool_call", path },
      options: [
        { id: "allow-once", name: "Yes", kind: "allow_once" },
        { id: "allow-always", name: "Yes, allow all edits during this session", kind: "allow_always" },
        { id: "reject", name: "No, and tell Claude what to do differently", kind: "reject_once" },
      ],
      state: "pending",
      requestedAt,
    }
    session.waitingFor = { kind: "permission", summary: `Edit ${path}`, requestId: id }
  } else if (kind === "question") {
    requests[id] = {
      type: "question",
      id,
      sessionId: session.id,
      state: "pending",
      requestedAt,
      questions: [
        {
          header: "Rollout",
          question: "Where should the new pricing copy go live first?",
          multiSelect: false,
          options: [
            { label: "Staging only", description: "Ship to staging and wait for review before production." },
            { label: "Production behind a flag", description: "Deploy everywhere, enable with the pricing_v2 flag." },
            { label: "Both", description: "Staging now, production in the same PR." },
          ],
        },
        {
          header: "Locales",
          question: "Which locales should I update?",
          multiSelect: true,
          options: [
            { label: "en", description: "Source strings" },
            { label: "de", description: "Machine translate, mark for review" },
            { label: "ja", description: "Machine translate, mark for review" },
          ],
        },
      ],
    }
    session.waitingFor = { kind: "question", summary: "Where should the new pricing copy go live first?", requestId: id }
  } else {
    requests[id] = {
      type: "plan",
      id,
      sessionId: session.id,
      state: "pending",
      requestedAt,
      planMarkdown: [
        "## Upgrade staging Postgres 16 → 17",
        "",
        "1. Snapshot `staging-main` and verify the snapshot restores.",
        "2. Bump `engine_version` to `17.2` in `modules/postgres/main.tf` and set `allow_major_version_upgrade = true` for staging only.",
        "3. Update the parameter group family to `postgres17`.",
        "4. Run `terraform plan` for `envs/staging` and attach the plan.",
        "5. Apply during the maintenance window; watch replication lag and error rates for 30 min.",
        "",
        "**Not touched:** production, read replicas in `eu-west-1`.",
      ].join("\n"),
      options: [
        { id: "approve-accept", name: "Yes, and auto-accept edits", kind: "allow_always" },
        { id: "approve-manual", name: "Yes, and manually approve edits", kind: "allow_always" },
        { id: "keep-planning", name: "No, keep planning", kind: "reject_once" },
      ],
    }
    session.waitingFor = { kind: "plan", summary: "Plan ready: upgrade staging Postgres 16 → 17", requestId: id }
  }
}
