// Settings → Permissions: the rules that let Claude act without asking, from your user settings and
// each project's. "Always allow" clicks pile up into broad rules nobody looks at again; this lists
// them with what they allow, the risky ones first, and removes one with a click (Undo puts it back).
import { useCallback, useEffect, useMemo, useState } from "react"
import { TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useApp } from "@/store/app"
import { homePath } from "@/lib/format"
import { cn } from "@/lib/utils"
import { IN_TAURI } from "@/lib/platform"
import { REAL } from "@/backend/mode"
import { ruleRisk } from "@/features/requests/risk"
import { showUndo } from "@/features/notifications/undo"

interface RuleFile {
  path: string
  scope: "user" | "project" | "local"
  project?: string
  allow: string[]
  deny: string[]
}

const DEMO: RuleFile[] = [
  { path: "~/.claude/settings.json", scope: "user", allow: ["Bash(npm test:*)", "Bash(git push:*)", "WebFetch", "Read(**)"], deny: [] },
  { path: "~/code/api-gateway/.claude/settings.local.json", scope: "local", project: "~/code/api-gateway", allow: ["Bash(rm:*)", "Bash(npm run build:*)", "Edit", "mcp__github"], deny: ["Read(./.env)"] },
]

const SCOPE = { user: "Your settings (every project)", project: "shared with the repo", local: "this computer only" } as const

async function call<T>(cmd: string, args: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(cmd, args)
}

export function PermissionsPage() {
  const repos = useApp((s) => s.repos)
  const projects = useMemo(() => [...new Set(Object.values(repos).filter((r) => !r.machine && !r.isHome).map((r) => r.rootPath))], [repos])
  const live = IN_TAURI && REAL
  const [files, setFiles] = useState<RuleFile[] | null>(live ? null : DEMO)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!live) return
    call<RuleFile[]>("claude_permission_rules", { projects })
      .then(setFiles)
      .catch((e) => setError(String(e)))
  }, [live, projects])
  useEffect(load, [load])

  const edit = async (f: RuleFile, rule: string, add: boolean) => {
    setError(null)
    if (!live) {
      setFiles((fs) => fs?.map((x) => (x === f || x.path === f.path ? { ...x, allow: add ? [...x.allow, rule] : x.allow.filter((r) => r !== rule) } : x)) ?? null)
      if (!add) showUndo("Rule removed", rule, () => void edit(f, rule, true))
      return
    }
    try {
      await call("claude_permission_rule", { path: f.path, list: "allow", rule, add })
      if (!add) showUndo("Rule removed", rule, () => void edit(f, rule, true))
      load()
    } catch (e) {
      setError(String(e))
    }
  }

  const risky = files?.reduce((n, f) => n + f.allow.filter((r) => ruleRisk(r).level === "high").length, 0) ?? 0
  return (
    <>
      <div className="mb-2 flex h-7 items-center gap-3">
        <h2 className="text-base font-medium text-foreground">Permissions</h2>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        What Claude may do without asking, as Claude Code's settings files say. Each "always allow" adds a rule here, and broad ones are easy to forget.
        {files && (risky > 0 ? ` ${risky} of them allow things that are hard to undo.` : " None of them allows anything hard to undo.")}
      </p>
      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
      {!files ? (
        <p className="text-sm text-muted-foreground">Reading…</p>
      ) : !files.length ? (
        <p className="text-sm text-muted-foreground">No allow rules: Claude asks before every action that needs permission.</p>
      ) : (
        files.map((f) => <FileRules key={f.path} file={f} onRemove={(r) => void edit(f, r, false)} />)
      )}
    </>
  )
}

const ORDER = { high: 0, broad: 1, none: 2 } as const

function FileRules({ file, onRemove }: { file: RuleFile; onRemove: (rule: string) => void }) {
  const rows = file.allow.map((rule) => ({ rule, risk: ruleRisk(rule) })).sort((a, b) => ORDER[a.risk.level ?? "none"] - ORDER[b.risk.level ?? "none"])
  return (
    <section className="mb-8">
      <h3 className="flex items-baseline gap-2 border-b border-border pb-2 text-xs font-medium text-muted-foreground">
        <span className="text-foreground">{file.project ? homePath(file.project).split("/").pop() : "User"}</span>
        <span>{SCOPE[file.scope]}</span>
        <span className="ml-auto truncate font-mono font-normal text-muted-foreground/70" title={file.path}>
          {homePath(file.path)}
        </span>
      </h3>
      {rows.length === 0 && <p className="py-2 text-xs text-muted-foreground">No allow rules ({file.deny.length} deny).</p>}
      <ul>
        {rows.map(({ rule, risk }) => (
          <li key={rule} className="group/rule flex min-h-9 items-center gap-3 border-b border-border/60 py-1.5 last:border-b-0">
            <code className="min-w-0 shrink truncate font-mono text-xs text-foreground" title={rule}>
              {rule}
            </code>
            {risk.level && (
              <span className={cn("flex min-w-0 items-center gap-1 text-xs", risk.level === "high" ? "text-foreground" : "text-muted-foreground")}>
                {risk.level === "high" && <TriangleAlert size={12} className="shrink-0" />}
                <span className="truncate">{risk.effect}</span>
              </span>
            )}
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto shrink-0 opacity-0 group-hover/rule:opacity-100 focus-visible:opacity-100 data-[risk=true]:opacity-100"
              data-risk={risk.level === "high"}
              onClick={() => onRemove(rule)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
