// Pull requests that do not merge, handed back to the session that opened them. Every 2 minutes,
// one `gh pr list --author @me` per repository with such a session (GitHub cannot reach this
// computer, so the app asks). When a PR turns red (a failed check, a reviewer asking for changes, a
// merge conflict), the session gets a message with the reason: the failing log lines, the
// reviewer's words, or what to merge. It goes into the session's queue, so a busy chat is not
// interrupted. The brake: each new failure is sent once; when the same checks fail again after the
// session pushed a fix, it stops, marks the session "waiting for you" and tells you. Green starts over.
import { getApp } from "@/store/app"
import { markSessionWaiting, pushNotification, sendMessage } from "@/store/actions"
import { REAL } from "@/backend/mode"
import { IN_TAURI } from "@/lib/platform"
import type { ID } from "@/lib/model"

const EVERY_MS = 2 * 60_000
/** repositories with no open PR of a session are asked this rarely */
const QUIET_MS = 10 * 60_000
/** sessions whose PR is older than this are not watched */
const RECENT_MS = 14 * 864e5
const LS = "sd.prwatch"

interface Check {
  name?: string
  workflowName?: string
  conclusion?: string
  state?: string
  status?: string
  detailsUrl?: string
}
export interface WatchedPr {
  number: number
  url: string
  title: string
  headRefName: string
  headRefOid: string
  baseRefName: string
  isDraft?: boolean
  mergeable?: string
  reviewDecision?: string
  statusCheckRollup?: Check[]
}

/** What the watcher told a PR's session, by PR url. */
interface Told {
  sig: string
  sha: string
  stopped?: boolean
  /** workflows that were red on the base branch too: the session waits, and is told when they are green */
  waitBase?: string[]
}

interface Run {
  workflowName?: string
  conclusion?: string
  status?: string
  createdAt?: string
}

/** Of these workflows, which are red and which green on a branch now (its newest finished run each). */
export function baseState(runs: Run[], workflows: string[]) {
  const red: string[] = []
  const green: string[] = []
  for (const w of workflows) {
    const last = runs.filter((x) => x.workflowName === w && (x.status ?? "").toLowerCase() === "completed").sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0]
    if (!last) continue
    if (FAILED.test((last.conclusion ?? "").toUpperCase())) red.push(w)
    else if (/SUCCESS/i.test(last.conclusion ?? "")) green.push(w)
  }
  return { red, green }
}

/** The repository of a pull request ("nexam-cloud" from https://github.com/nexam-GmbH/nexam-cloud/pull/7). */
export const repoOfPr = (url: string) => /github\.com\/[^/]+\/([^/]+)\/pull\//.exec(url)?.[1] ?? ""

const FAILED = /FAIL|ERROR|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE/
const DONE_OK = /SUCCESS|SKIPPED|NEUTRAL|CANCEL/

const result = (c: Check) => (c.conclusion || c.state || c.status || "").toUpperCase()
const checkName = (c: Check) => c.name || c.workflowName || "a check"

/** Why a PR does not merge: failing checks, changes asked for, a conflict. Empty: nothing wrong (yet). */
export function redOf(pr: WatchedPr) {
  const failing = (pr.statusCheckRollup ?? []).filter((c) => FAILED.test(result(c)))
  const pending = (pr.statusCheckRollup ?? []).some((c) => !FAILED.test(result(c)) && !DONE_OK.test(result(c)))
  const conflict = pr.mergeable === "CONFLICTING"
  const changes = pr.reviewDecision === "CHANGES_REQUESTED"
  const sig = [...new Set(failing.map(checkName))].sort().join(", ") + (conflict ? " +conflict" : "") + (changes ? " +changes" : "")
  return { failing, pending, conflict, changes, sig: sig.trim(), green: !sig.trim() && !pending }
}

/**
 * What to do about a PR now, given what its session was told before: tell it (a new failure),
 * stop (the same failure again after the session pushed), forget (green), or wait.
 */
export function decide(pr: WatchedPr, told: Told | undefined): "tell" | "stop" | "forget" | "wait" {
  const r = redOf(pr)
  if (r.green) return told ? "forget" : "wait"
  // still running, nothing failed yet: wait (a fix being checked is not a new failure)
  if (!r.sig) return "wait"
  if (!told || told.sig !== r.sig) return "tell"
  if (told.stopped || told.sha === pr.headRefOid) return "wait"
  return "stop"
}

function load(): Record<string, Told> {
  try {
    return JSON.parse(localStorage.getItem(LS) ?? "{}") as Record<string, Told>
  } catch {
    return {}
  }
}
let told = load()
const keep = () => {
  try {
    localStorage.setItem(LS, JSON.stringify(told))
  } catch {
    /* storage full */
  }
}

/** The message a session gets about its red PR (`onBase`: failing workflows red on the base too). */
async function message(pr: WatchedPr, cwd: string, onBase: string[]): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core")
  const r = redOf(pr)
  const parts: string[] = [`Pull request #${pr.number} (${pr.title}) does not merge.`]
  // red on the base branch too: nothing this PR can fix; it waits, and the app says when to go on
  if (onBase.length && onBase.length === new Set(r.failing.map((c) => c.workflowName || checkName(c))).size && !r.conflict && !r.changes) {
    parts.push(`${onBase.join(", ")} is red on ${pr.baseRefName} too, so the cause is not in this PR. Do not change it for this and do not start a watcher of your own: the app tells you here as soon as ${pr.baseRefName} is green again, then merge it in and push. Say in one line what fails on ${pr.baseRefName}, then end your turn.`)
    return parts.join("\n\n")
  }
  if (onBase.length) parts.push(`Red on ${pr.baseRefName} too (not from this PR): ${onBase.join(", ")}.`)
  const runs = [...new Set(r.failing.map((c) => /\/actions\/runs\/(\d+)/.exec(c.detailsUrl ?? "")?.[1]).filter((x): x is string => !!x).map(Number))]
  if (r.failing.length) parts.push(`Failing: ${[...new Set(r.failing.map(checkName))].join(", ")}.`)
  if (runs.length) {
    const log = await invoke<string>("ci_failure_log", { cwd, runs }).catch((e) => `(the log could not be read: ${String(e)})`)
    parts.push(`The failing log lines:\n\n\`\`\`\n${log.trim()}\n\`\`\``)
  }
  // a check that is no Actions run (a review bot) or a reviewer asking for changes: their words
  if (r.changes || r.failing.some((c) => !/\/actions\/runs\//.test(c.detailsUrl ?? ""))) {
    const said = await invoke<string>("pr_feedback", { cwd, number: pr.number }).catch(() => "")
    if (said) parts.push(`What the reviewers said:\n\n${said}`)
  }
  if (r.conflict) parts.push(`It has merge conflicts with ${pr.baseRefName}: merge origin/${pr.baseRefName} into ${pr.headRefName}, resolve them, run the checks.`)
  parts.push(`Fix it and push. If the cause is not in this PR (a flaky test, a check that is red on ${pr.baseRefName} too, the CI runner), say so instead of changing unrelated code or weakening tests.`)
  return parts.join("\n\n")
}

let lastAsked = new Map<string, number>()
/** repositories whose last answer had no open PR of a session (asked less often) */
let idle = new Set<string>()
let running = false

async function tick() {
  const st = getApp()
  if (running || !st.settings.prAutoFix) return
  running = true
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const { realPrSessions } = await import("@/backend/real")
    const now = Date.now()
    const watched = realPrSessions().filter((p) => {
      const s = st.sessions[p.id]
      return s && !s.archived && !s.machine && now - p.updatedMs < RECENT_MS
    })
    // one question per repository (any of its sessions' folders will do)
    const byRepo = new Map<string, typeof watched>()
    for (const p of watched) {
      const repo = st.sessions[p.id]?.repoId ?? p.cwd
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), p])
    }
    for (const [repo, sessions] of byRepo) {
      const last = lastAsked.get(repo) ?? 0
      if (now - last < (idle.has(repo) ? QUIET_MS : EVERY_MS) - 5000) continue
      lastAsked.set(repo, now)
      const prs = await invoke<WatchedPr[] | null>("pr_list_mine", { cwd: sessions[0].cwd }).catch(() => null)
      if (!prs) continue
      let any = false
      const only = st.settings.prAutoFixRepos ?? []
      for (const pr of prs) {
        if (pr.isDraft) continue
        // only the repositories chosen in Settings (none listed: every one)
        if (only.length && !only.some((r) => r.toLowerCase() === repoOfPr(pr.url).toLowerCase())) continue
        // the session that opened it (its recorded link), else the newest on its branch
        const mine = sessions.filter((p) => p.prUrl === pr.url)
        const onBranch = mine.length ? mine : sessions.filter((p) => p.branch === pr.headRefName)
        const who = onBranch.sort((a, b) => b.updatedMs - a.updatedMs)[0]
        if (!who) continue
        any = true
        await act(who.id, who.cwd, pr)
      }
      if (any) idle.delete(repo)
      else idle.add(repo)
    }
  } finally {
    running = false
  }
}

async function act(id: ID, cwd: string, pr: WatchedPr) {
  const s = getApp().sessions[id]
  if (!s) return
  const { invoke } = await import("@tauri-apps/api/core")
  // waiting for the base: once it is green again, the session merges it in (once)
  const t = told[pr.url]
  if (t?.waitBase?.length && !redOf(pr).green) {
    const runs = await invoke<Run[] | null>("branch_runs", { cwd, branch: pr.baseRefName }).catch(() => null)
    const b = baseState(runs ?? [], t.waitBase)
    if (runs && !b.red.length && b.green.length) {
      told[pr.url] = { ...t, waitBase: undefined }
      keep()
      sendMessage(id, `${pr.baseRefName} is green again (${b.green.join(", ")}). Merge origin/${pr.baseRefName} into ${pr.headRefName} for pull request #${pr.number}, run the checks, and push.`, "queue")
    }
    return
  }
  const what = decide(pr, told[pr.url])
  if (what === "forget") {
    delete told[pr.url]
    keep()
  } else if (what === "tell") {
    // the failing workflows that are red on the base branch too
    const workflows = [...new Set(redOf(pr).failing.map((c) => c.workflowName).filter((x): x is string => !!x))]
    const runs = workflows.length ? await invoke<Run[] | null>("branch_runs", { cwd, branch: pr.baseRefName }).catch(() => null) : null
    const onBase = baseState(runs ?? [], workflows).red
    told[pr.url] = { sig: redOf(pr).sig, sha: pr.headRefOid, ...(onBase.length ? { waitBase: onBase } : {}) }
    keep()
    sendMessage(id, await message(pr, cwd, onBase), "queue")
  } else if (what === "stop") {
    told[pr.url] = { ...told[pr.url], sha: pr.headRefOid, stopped: true }
    keep()
    markSessionWaiting(id, true)
    pushNotification({ sessionId: id, kind: "error", title: s.title, body: `PR #${pr.number} still fails (${redOf(pr).sig}) after a fix: it needs you`, createdAt: new Date().toISOString() })
  }
}

let started = false
export function startPrWatch() {
  if (started || !(IN_TAURI && REAL)) return
  started = true
  setTimeout(() => void tick(), 30_000)
  setInterval(() => void tick(), 30_000)
}

/** For tests: forget what was told. */
export function resetPrWatch() {
  told = {}
  lastAsked = new Map()
  idle = new Set()
}
