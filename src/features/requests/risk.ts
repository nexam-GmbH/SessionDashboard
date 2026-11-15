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
