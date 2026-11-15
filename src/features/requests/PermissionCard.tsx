// Adapted from agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/ApprovalCard.tsx (MIT). Modified for session-dashboard.
// Also adapted from BloopAI/vibe-kanban@5f06193:packages/web-core/src/shared/components/NormalizedConversation/PendingApprovalEntry.tsx
// (deny with a reason, Apache-2.0) and cline/cline@72b3d71:sdk/packages/ui/components/agent-approval-card.tsx (Apache-2.0).
// Changes: the request's ACP options are rendered as data (allow_once / allow_always /
// reject_once …) with short labels; Enter takes the first allow_once, 1–9 pick an
// option, Esc or "Deny" opens an inline feedback field (Cmd/Ctrl+Enter submits). Calm
// rules: the title is the question itself ("Allow `npm test -- retry`?"); cwd and
// description sit behind a details toggle; edits show their pending diff. A request that is hard to
// undo (risk.ts) says what it does first, offers no "always allow", takes no focus and no Enter: it
// is answered with a deliberate click or number key.
import { memo, useEffect, useRef, useState } from "react"
import { TriangleAlert } from "lucide-react"
import { MOD } from "@/components/common/bits"
import type { PermissionOption, PermissionRequest, ToolCall } from "@/lib/model"
import { DiffStat } from "@/components/common/bits"
import { homePath } from "@/lib/format"
import { InlineDiff } from "@/features/session-view/tools/InlineDiff"
import { resolveRequest } from "@/features/session-view/sessionStore"
import { riskOf } from "./risk"
import { useApp } from "@/store/app"
import { CardFrame, canStealFocus, FeedbackField, OptionButton, optionLabel, type Pager } from "./cardChrome"

const isReject = (o: PermissionOption) => o.kind === "reject_once" || o.kind === "reject_always"

const base = (p: string) => p.split(/[\\/]/).pop() || p

/** "Allow Claude to run Print hello with Python?", as Claude Code desktop asks. */
function askFor(r: PermissionRequest): string {
  const desc = r.description?.trim()
  const subj = r.subject
  const path = subj?.type === "tool_call" ? subj.path : undefined
  const t = r.toolName
  if (subj?.type === "command") {
    if (!desc) return "Allow Claude to run this command?"
    // "Run the test suite" → "Allow Claude to run the test suite?"; "Print hello" → "… to run: print hello"
    const rest = desc.replace(/^(run|runs|running|execute|executes)\s+/i, "")
    const lower = /^[A-Z][a-z]/.test(rest) ? rest.charAt(0).toLowerCase() + rest.slice(1) : rest
    return rest !== desc ? `Allow Claude to run ${lower.replace(/[.?!]$/, "")}?` : `Allow Claude to ${lower.replace(/[.?!]$/, "")}?`
  }
  if (t === "Edit" || t === "MultiEdit" || t === "NotebookEdit") return `Allow Claude to edit ${path ? base(path) : "this file"}?`
  if (t === "Write") return `Allow Claude to write ${path ? base(path) : "this file"}?`
  if (t === "Read") return `Allow Claude to read ${path ? base(path) : "this file"}?`
  if (t === "WebFetch") return "Allow Claude to fetch this page?"
  if (t === "WebSearch") return "Allow Claude to search the web?"
  const mcp = /^mcp__(.+?)__(.+)$/.exec(t)
  if (mcp) return `Allow Claude to use ${mcp[2].replace(/_/g, " ")} (${mcp[1].replace(/_/g, " ")})?`
  return `Allow Claude to use ${t}?`
}

/** What the card shows in its box: the command, the path, the address. */
function boxOf(r: PermissionRequest): string | undefined {
  if (r.subject?.type === "command") return r.subject.command
  if (r.subject?.type === "tool_call" && r.subject.path) return r.subject.path
  return undefined
}

export const PermissionCard = memo(function PermissionCard({
  request,
  canApprove,
  pager,
  toolCall,
  subagentLabel,
  autoFocus,
}: {
  request: PermissionRequest
  canApprove: boolean
  pager?: Pager
  /** the transcript's pending tool call, for the diff preview */
  toolCall?: ToolCall
  subagentLabel?: string
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  const [feedbackFor, setFeedbackFor] = useState<PermissionOption | null>(null)
  const [feedback, setFeedback] = useState("")
  const cwd0 = useApp((s) => s.sessions[request.sessionId]?.cwd)
  const risk = riskOf(request, cwd0)
  useEffect(() => {
    if (autoFocus && !risk.high && canStealFocus()) ref.current?.focus({ preventScroll: true })
  }, [autoFocus, request.id, risk.high])

  const choose = (o: PermissionOption) => {
    if (!canApprove) return
    if (isReject(o)) {
      setFeedbackFor(o)
      return
    }
    resolveRequest(request, o.id)
  }
  const submitReject = () => {
    if (feedbackFor) resolveRequest(request, feedbackFor.id, feedback.trim() || undefined)
  }
  // hard to undo: no standing permission for it, and no Enter to approve
  const options = risk.high ? request.options.filter((o) => o.kind !== "allow_always") : request.options
  const allowOnce = options.find((o) => o.kind === "allow_once")
  const firstAllow = risk.high ? undefined : allowOnce
  const always = options.find((o) => o.kind === "allow_always")
  const deny = options.find(isReject)
  const command = request.subject?.type === "command" ? request.subject.command : undefined
  const box = boxOf(request)
  const diff = toolCall?.diff?.[0]
  const added = toolCall?.diff?.reduce((a, d) => a + d.added, 0) ?? 0
  const removed = toolCall?.diff?.reduce((a, d) => a + d.removed, 0) ?? 0
  const cwd = request.subject?.type === "command" ? request.subject.cwd : undefined

  // Claude Code desktop's keys, from anywhere in the session (the prompt box keeps focus while
  // you read): Ctrl+Enter allows once, Ctrl+Shift+Enter always; not for a request hard to undo,
  // and not while you are typing a message (then Ctrl+Enter is the prompt box's)
  useEffect(() => {
    if (!canApprove || risk.high || pager?.index) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT") && (t as HTMLTextAreaElement).value.trim()) return
      const o = e.shiftKey ? always : allowOnce
      if (!o) return
      e.preventDefault()
      e.stopPropagation()
      choose(o)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  })

  return (
    <CardFrame
      ref={ref}
      tone="perm"
      className={risk.high ? "border-st-perm/60" : undefined}
      label={`Permission request${risk.high ? ", hard to undo" : ""}: ${request.title}`}
      keyHint={`${firstAllow ? "Enter or Control+Enter: allow once. " : ""}${always && !risk.high ? "Control+Shift+Enter: always allow. " : ""}1 to ${Math.min(9, options.length)}: pick an option. Escape: deny with feedback.${pager && pager.total > 1 ? " Shift+Enter: next request." : ""}`}
      title={<span className="min-w-0">{askFor(request)}</span>}
      meta={
        <>
          {(added > 0 || removed > 0) && <DiffStat added={added} removed={removed} className="shrink-0" />}
          {subagentLabel && <span className="shrink-0 text-xs font-normal text-muted-foreground">{subagentLabel}</span>}
        </>
      }
      pager={pager}
      onKeyDown={(e) => {
        if (feedbackFor || e.target !== e.currentTarget) return
        if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault()
          pager?.onNext()
        } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && firstAllow) {
          e.preventDefault()
          choose(firstAllow)
        } else if (/^[1-9]$/.test(e.key)) {
          const o = options[Number(e.key) - 1]
          if (o) {
            e.preventDefault()
            choose(o)
          }
        } else if (e.key === "Escape" && deny) {
          e.preventDefault()
          choose(deny)
        }
      }}
      footerNote={!canApprove ? "Approve in your terminal" : undefined}
      footer={
        feedbackFor ? (
          <FeedbackField
            placeholder="What should Claude do instead? (optional)"
            value={feedback}
            onChange={setFeedback}
            onSubmit={submitReject}
            onCancel={() => {
              setFeedbackFor(null)
              setFeedback("")
              ref.current?.focus()
            }}
            submitLabel="Deny"
          />
        ) : (
          <>
            {deny && (
              <OptionButton n={options.indexOf(deny) + 1} disabled={!canApprove} variant="quiet" onClick={() => choose(deny)} title={`${deny.name} · Esc`}>
                Deny
              </OptionButton>
            )}
            {always && (
              <OptionButton n={options.indexOf(always) + 1} disabled={!canApprove} variant="secondary" onClick={() => choose(always)} keys={["⇧", MOD, "↵"]} title={always.name}>
                {optionLabel(always)}
              </OptionButton>
            )}
            {allowOnce && (
              <OptionButton n={options.indexOf(allowOnce) + 1} disabled={!canApprove} variant="primary" onClick={() => choose(allowOnce)} keys={risk.high ? undefined : [MOD, "↵"]} title={allowOnce.name}>
                Allow once
              </OptionButton>
            )}
            {options
              .filter((o) => o !== deny && o !== always && o !== allowOnce)
              .map((o) => (
                <OptionButton key={o.id} n={options.indexOf(o) + 1} disabled={!canApprove} variant="secondary" onClick={() => choose(o)} title={o.name}>
                  {optionLabel(o)}
                </OptionButton>
              ))}
          </>
        )
      }
    >
      {risk.high && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <TriangleAlert size={14} className="shrink-0 text-st-perm" /> {risk.effect}
        </p>
      )}
      {command && <p className="text-sm text-muted-foreground/80">This command requires approval{cwd ? <span className="text-muted-foreground/60"> · in {homePath(cwd)}</span> : null}</p>}
      {box && (!diff || command) && (
        <pre className="max-h-48 overflow-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-[13px] leading-5 break-all whitespace-pre-wrap text-foreground select-text">{box}</pre>
      )}
      {diff && !command && <InlineDiff path={diff.path} oldText={diff.oldText} newText={diff.newText} maxLines={12} />}
      {!command && request.description && <p className="text-xs text-muted-foreground/80">{request.description}</p>}
    </CardFrame>
  )
})
