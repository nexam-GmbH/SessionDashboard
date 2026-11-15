// Which permission requests are hard to undo. They get a different card: the effect is spelled out,
// Enter does not approve, "always allow" is not offered, and they are not answerable from the
// overview, where the request is a line among others. Everything else stays one keypress, so the
// habit of approving routine requests quickly is not spent on the dangerous ones.
import type { PermissionRequest } from "@/lib/model"

const COMMAND: [RegExp, string][] = [
  [/\brm\s+(?:-\w*[rR]\w*|--recursive)\b/, "Deletes files and folders recursively"],
  [/\bgit\s+push\b[^\n;&|]*(?:\s--force(?:-with-lease)?\b|\s-\w*f\b|\s\+\S)/, "Overwrites history on the remote"],
  [/\bgit\s+reset\s+[^\n;&|]*--hard\b/, "Throws away uncommitted work"],
  [/\bgit\s+clean\s+-\w*[fdx]/, "Deletes untracked files"],
  [/\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/, "Throws away uncommitted changes"],
  [/\bgit\s+branch\s+-\w*D\b/, "Deletes a branch with unmerged work"],
  [/\bgit\s+(?:filter-branch|filter-repo)\b/, "Rewrites the repository's history"],
  [/\bgit\s+push\b[^\n;&|]*\s(?:main|master|production|prod|release)\b/, "Pushes to a main or release branch"],
  [/(?:^|[\s;&|(])sudo\s/, "Runs as administrator"],
  [/\b(?:chmod|chown)\s+-\w*R/, "Changes permissions recursively"],
  [/\b(?:mkfs|fdisk|parted|wipefs)\b|\bdd\s+[^\n]*\bof=\/dev\//, "Writes to a disk directly"],
  [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, "Runs a script straight from the internet"],
  [/\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, "Deletes database tables"],
  [/\bDELETE\s+FROM\s+\w+\s*(?:;|"|'|$)/i, "Deletes every row of a table"],
  [/\b(?:npm|pnpm|yarn|bun|cargo|gem|twine|poetry)\s+publish\b/, "Publishes a package"],
  [/\bterraform\s+(?:apply|destroy)\b|\bpulumi\s+(?:up|destroy)\b/, "Changes cloud infrastructure"],
  [/\bkubectl\s+(?:delete|apply|replace|drain)\b|\bhelm\s+(?:uninstall|delete|upgrade)\b/, "Changes a cluster"],
  [/\b(?:vercel\s[^\n]*--prod|fly\s+deploy|netlify\s+deploy[^\n]*--prod|firebase\s+deploy)\b/, "Deploys to production"],
  [/\bgh\s+(?:pr\s+merge|release\s+create|repo\s+delete)\b/, "Acts on GitHub for everyone"],
  [/\bdocker\s+(?:system|volume|image)\s+prune\b/, "Deletes Docker data"],
  [/(?:^|[\s;&|])(?:kill|pkill|killall)\s+(?:-9\s+)?(?:-1\b|1\b)/, "Stops every process"],
  [/>\s*\/(?:etc|usr|boot|bin|sbin)\//, "Writes to system files"],
]

const PATH: [RegExp, string][] = [
  [/(?:^|\/)\.env(?:\.[\w-]+)?$/, "Edits a secrets file (.env)"],
  [/(?:^|\/)\.(?:ssh|aws|gnupg|kube|docker)\//, "Edits credentials"],
  [/(?:^|\/)(?:id_rsa|id_ed25519|credentials|\.netrc|\.npmrc|\.pypirc)$/, "Edits credentials"],
  [/(?:^|\/)\.github\/workflows\//, "Changes CI workflows (they run with the repository's secrets)"],
  [/^\/(?:etc|usr|boot|bin|sbin|var)\//, "Edits system files"],
  [/(?:^|\/)\.(?:bashrc|zshrc|profile|bash_profile)$/, "Edits your shell startup"],
]

export interface Risk {
  high: boolean
  effect?: string
}

const NONE: Risk = { high: false }

export function riskOf(req: PermissionRequest, cwd?: string): Risk {
  const s = req.subject
  if (s?.type === "command") {
    for (const [re, effect] of COMMAND) if (re.test(s.command)) return { high: true, effect }
    return NONE
  }
  const path = s?.path
  if (!path) return NONE
  for (const [re, effect] of PATH) if (re.test(path)) return { high: true, effect }
  // an edit outside the session's folder
  const base = s?.type === "tool_call" && cwd ? cwd.replace(/\/+$/, "") : undefined
  if (base && path.startsWith("/") && !path.startsWith(base + "/") && /^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(req.toolName))
    return { high: true, effect: "Edits a file outside this session's folder" }
  return NONE
}

// ---------- standing rules ("always allow") ----------
export interface RuleRisk {
  level: "high" | "broad" | null
  effect?: string
}

const RUNS_ANY_CODE = /^(?:bash|sh|zsh|fish|python3?|node|deno|bun|npx|bunx|pnpx|pnpm dlx|uvx?|uv run|ruby|perl|php|eval|exec|xargs|env|sudo|ssh|docker(?: run| exec)?|kubectl exec|make|just|npm run|pnpm|yarn|cargo run|go run|tsx|ts-node)$/
const PREFIX: [RegExp, string][] = [
  [/^(?:rm|rmdir|unlink|shred|find|dd|mkfs\S*|truncate)$/, "Deletes files without asking"],
  [/^(?:chmod|chown|chgrp)$/, "Changes file permissions without asking"],
  [/^git(?: push)?$/, "Any push without asking, force pushes included"],
  [/^git (?:reset|clean|checkout|restore|branch|rebase|filter-branch|stash)$/, "Can throw away work without asking"],
  [/^(?:curl|wget|nc|scp|rsync)$/, "Sends and fetches data anywhere without asking"],
  [/^(?:npm|pnpm|yarn|cargo|gem|twine|poetry) publish$/, "Publishes packages without asking"],
  [/^gh(?: pr| release| repo| api)?$/, "Acts on GitHub for everyone without asking"],
  [/^(?:kubectl|helm|terraform|pulumi|aws|gcloud|az|fly|flyctl|vercel|netlify|firebase|heroku)$/, "Changes cloud resources without asking"],
  [/^(?:psql|mysql|sqlite3|mongo|mongosh|redis-cli)$/, "Runs any database command without asking"],
  [/^(?:kill|pkill|killall|systemctl|reboot|shutdown)$/, "Stops processes or services without asking"],
]

/**
 * What an allow rule lets Claude do unasked. High: hard to undo or runs anything. Broad: a whole tool
 * or server without limits. Rules look like `Bash(npm test:*)`, `Edit(src/**)`, `mcp__github`.
 */
export function ruleRisk(rule: string): RuleRisk {
  const m = /^([\w-]+)(?:\((.*)\))?$/.exec(rule.trim())
  if (!m) return { level: null }
  const [, tool, arg = ""] = m
  const spec = arg.trim()
  if (tool === "Bash") {
    const prefix = spec.replace(/(?::\*|\s*\*)+$/, "").trim()
    if (!prefix) return { level: "high", effect: "Any shell command without asking" }
    const low = prefix.toLowerCase()
    if (RUNS_ANY_CODE.test(low)) return { level: "high", effect: `Runs any code through ${prefix} without asking` }
    for (const [re, effect] of PREFIX) if (re.test(low)) return { level: "high", effect }
    const r = COMMAND.find(([re]) => re.test(prefix))
    if (r) return { level: "high", effect: `${r[1]} without asking` }
    return { level: null }
  }
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    if (!spec || spec === "**" || spec === "*" || spec === "./**") return { level: "broad", effect: "Edits any file in the project without asking" }
    if (/^(?:~|\/\/|\/)/.test(spec)) {
      const p = PATH.find(([re]) => re.test(spec.replace(/^\/\//, "/").replace(/\*+$/, "x")))
      return { level: "high", effect: p ? `${p[1]} without asking` : "Edits files outside the project without asking" }
    }
    return { level: null }
  }
  if (tool === "WebFetch" && !spec) return { level: "broad", effect: "Fetches any website without asking" }
  if (tool.startsWith("mcp__") && tool.split("__").length === 2) return { level: "broad", effect: `Every tool of the ${tool.slice(5)} server without asking` }
  return { level: null }
}

// ---------- files to review first ----------
const LOOK: [RegExp, string][] = [
  [/(?:^|\/)\.env(?:\.[\w-]+)?$|\.(?:pem|key|p12|pfx)$|(?:^|\/)(?:secrets?|credentials?)(?:\/|\.|$)/i, "Secrets"],
  [/(?:^|\/)(?:\.github\/workflows|\.gitlab-ci|\.circleci|Jenkinsfile|\.buildkite)|(?:^|\/)(?:Dockerfile|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml)$|\.tf$|(?:^|\/)(?:helm|k8s|kubernetes|deploy|infra)\//i, "CI, build or deploy"],
  [/(?:^|\/)(?:migrations?|migrate|db\/schema)\/|\.sql$|(?:^|\/)schema\.prisma$/i, "Database migration"],
  [/(?:^|[/._-])(?:auth(?:n|z|entication|orization|orize[rd]?)?|oauth2?|security|permissions?|crypto|passwords?|jwt|acl|rbac|csrf|saniti[sz]e\w*)(?=[/._-]|$)/i, "Security-sensitive"],
  [/(?:^|\/)(?:package\.json|Cargo\.toml|go\.mod|requirements[\w.-]*\.txt|pyproject\.toml|Gemfile|pom\.xml|build\.gradle(?:\.kts)?)$/, "Dependencies"],
]

/**
 * Why a changed file deserves a look before the rest (secrets, CI, migrations, auth, dependencies,
 * deletions); undefined for the ordinary ones. Review attention is best spent where mistakes cost most.
 */
export function lookFirst(path: string, op: string): string | undefined {
  for (const [re, why] of LOOK) if (re.test(path)) return why
  return op === "delete" ? "Deleted" : undefined
}

/** Test files: reviewed after the code they test. */
export const isTestPath = (path: string) => /(?:^|\/)(?:__tests__|tests?|spec|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs)$|(?:^|\/)test_\w+\.py$/.test(path)
