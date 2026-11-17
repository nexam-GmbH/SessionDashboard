// Adapted from agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/ApprovalCard.tsx (MIT). Modified for session-dashboard.
// Also adapted from BloopAI/vibe-kanban@5f06193:packages/web-core/src/shared/components/NormalizedConversation/PendingApprovalEntry.tsx
// (deny with a reason, Apache-2.0) and cline/cline@72b3d71:sdk/packages/ui/components/agent-approval-card.tsx (Apache-2.0).
// Claude Code desktop's permission card: "Allow Claude to **run** …?", the command in a well (or the
// pending diff), warnings, then Deny · Always allow · Allow once. Deny opens a short "what instead"
// field. A request that is hard to undo (risk.ts) says what it does, offers no "always allow", no
// switch to Auto, takes no focus and no Enter / Ctrl+Enter: a deliberate click or number key.
import { memo, useEffect, useRef, useState, type ReactNode } from "react"
import { TriangleAlert } from "lucide-react"
import { MOD } from "@/components/common/bits"
import type { PermissionOption, PermissionRequest, ToolCall } from "@/lib/model"
import { InlineDiff } from "@/features/session-view/tools/InlineDiff"
import { resolveRequest } from "@/features/session-view/sessionStore"
import { riskOf } from "./risk"
import { useApp } from "@/store/app"
import { CardFrame, canStealFocus, Decision, FeedbackField, modEnter, OptionButton, optionLabel, plain, Split, useCardKeys, type Pager } from "./cardChrome"

const isReject = (o: PermissionOption) => o.kind === "reject_once" || o.kind === "reject_always"

const base = (p: string) => p.split(/[\\/]/).pop() || p
const host = (u: string) => /^\w+:\/\/([^/?#]+)/.exec(u)?.[1] ?? u
const lower = (t: string) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t)

/** Desktop's question: [verb, value, value is a path/command shown in mono]. */
function ask(r: PermissionRequest): [string, string, boolean] {
  const desc = r.description?.trim().replace(/[.?!]$/, "")
  const path = r.subject?.type === "tool_call" ? r.subject.path : undefined
  const t = r.toolName
  if (r.subject?.type === "command") return ["run", desc ? lower(desc.replace(/^(run|runs|running|execute|executes)\s+/i, "")) : "this command", false]
  if (/^(Edit|MultiEdit|NotebookEdit)$/.test(t)) return ["edit", path ? base(path) : "this file", !!path]
  if (t === "Write") return ["write", path ? base(path) : "a file", !!path]
  if (t === "Read") return ["read", path ? base(path) : "a file", !!path]
  if (t === "WebFetch") return ["fetch", path ? host(path) : "a page", !!path]
  if (t === "WebSearch") return ["search the web", desc ? lower(desc) : "", false]
  if (t === "Skill") return ["run skill", desc ?? "", false]
  if (t === "Task" || t === "Agent") return ["run an agent", desc ? lower(desc) : "", false]
  const mcp = /^mcp__(.+?)__(.+)$/.exec(t)
  if (mcp) return ["use", `${mcp[2].replace(/_/g, " ")} (${mcp[1].replace(/_/g, " ")})`, false]
  return ["use", t, true]
}

export const PermissionCard = memo(function PermissionCard({
  request,
  canApprove,
  pager,
  toolCall,
  subagentLabel,
  docked,
}: {
  request: PermissionRequest
  canApprove: boolean
  pager?: Pager
  /** the transcript's pending tool call, for the diff preview */
  toolCall?: ToolCall
  subagentLabel?: string
  docked: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  const [feedbackFor, setFeedbackFor] = useState<PermissionOption | null>(null)
  const [feedback, setFeedback] = useState("")
  const cwd = useApp((s) => s.sessions[request.sessionId]?.cwd)
  const risk = riskOf(request, cwd)
  useEffect(() => {
    if (docked && !risk.high && canStealFocus()) ref.current?.focus({ preventScroll: true })
  }, [docked, request.id, risk.high])

  const choose = (o: PermissionOption) => {
    if (!canApprove) return
    if (isReject(o)) setFeedbackFor(o)
    else resolveRequest(request, o.id)
  }
  // hard to undo: no standing permission for it
  const options = risk.high ? request.options.filter((o) => o.kind !== "allow_always") : request.options
  const allowOnce = options.find((o) => o.kind === "allow_once")
  const always = options.find((o) => o.kind === "allow_always")
  const deny = options.find(isReject)
  const extras = options.filter((o) => o !== deny && o !== always && o !== allowOnce)
  // the allow group in visual order, the primary last; digits: 1 Deny, 2… these
  const allows = [...extras, ...(always ? [always] : []), ...(allowOnce ? [allowOnce] : [])]
  const command = request.subject?.type === "command" ? request.subject.command : undefined
  const path = request.subject?.type === "tool_call" ? request.subject.path : undefined
  const diff = toolCall?.diff?.[0]
  const [verb, value, mono] = ask(request)

  useCardKeys(
    ref,
    docked &&
      canApprove &&
      !feedbackFor &&
      ((e) => {
        let o: PermissionOption | undefined
        if (modEnter(e)) o = risk.high ? undefined : e.shiftKey ? always : allowOnce
        else if (!plain(e)) return false
        else if (e.key === "Enter" && e.target === ref.current && !risk.high) o = allowOnce
        else if (e.key === "Escape") o = deny
        else if (/^[1-9]$/.test(e.key)) o = e.key === "1" ? deny : allows[Number(e.key) - 2]
        if (!o) return false
        choose(o)
        return true
      }),
  )
  const keys = (o: PermissionOption): string[] | undefined => {
    if (!docked) return undefined
    if (o === deny) return ["Esc"]
    if (!risk.high && o === allowOnce) return [MOD, "⏎"]
    if (!risk.high && o === always) return [MOD, "Shift", "⏎"]
    return [String(allows.indexOf(o) + 2)]
  }

  const button = (o: PermissionOption, variant: "primary" | "secondary", label: ReactNode, short?: string) => (
    <OptionButton key={o.id} variant={variant} disabled={!canApprove} onClick={() => choose(o)} keys={keys(o)} title={o.name} short={short}>
      {label}
    </OptionButton>
  )

  return (
    <CardFrame
      ref={ref}
      docked={docked}
      label={`Permission request${risk.high ? ", hard to undo" : ""}: ${verb} ${value}`.trim()}
      keyHint={`${risk.high ? "" : "Control+Enter: allow once. "}${always && !risk.high ? "Control+Shift+Enter: always allow. " : ""}1: deny, 2 to ${allows.length + 1}: allow buttons in order. Escape: deny with feedback.`}
      title={
        <>
          Allow Claude to <strong className="font-semibold">{verb}</strong>{" "}
          {value && (mono ? <code className="rounded bg-cc-wash-2 px-1 py-px font-mono text-[13px] break-all">{value}</code> : value)}?
        </>
      }
      meta={subagentLabel && <span className="shrink-0 py-0.5 text-xs leading-5 text-cc-fg3">{subagentLabel}</span>}
      pager={pager}
      footer={
        feedbackFor ? (
          <FeedbackField
            label="Tell Claude what to do instead"
            placeholder="What should Claude do instead? (optional)"
            value={feedback}
            onChange={setFeedback}
            onSubmit={() => resolveRequest(request, feedbackFor.id, feedback.trim() || undefined)}
            onCancel={() => {
              setFeedbackFor(null)
              setFeedback("")
              ref.current?.focus()
            }}
            submitLabel="Deny"
          />
        ) : (
          <Decision
            start={
              <>
                {deny && button(deny, "secondary", "Deny")}
                {!canApprove && <span className="text-xs text-cc-fg3">Approve in your terminal</span>}
              </>
            }
            end={allows.map((o) =>
              o !== allowOnce ? (
                button(o, "secondary", optionLabel(o), o === always ? "Always" : undefined)
              ) : (
                // desktop's caret: allow this one and stop asking (Auto mode); never for a risky one
                <Split
                  key={o.id}
                  label="More allow options"
                  disabled={!canApprove}
                  items={risk.high ? [] : [{ label: "Allow and switch to Auto", hint: "Auto reviews the rest of this session.", onSelect: () => resolveRequest(request, "allow-auto") }]}
                >
                  {button(o, "primary", "Allow once")}
                </Split>
              ),
            )}
          />
        )
      }
    >
      {risk.high && (
        <p className="flex items-start gap-2 rounded-lg bg-cc-wash px-3 py-2 text-[13px] leading-[17px] text-cc-fg2">
          <TriangleAlert size={14} className="mt-px shrink-0 text-cc-danger" /> {risk.effect}
        </p>
      )}
      {diff && !command ? (
        <InlineDiff path={diff.path} oldText={diff.oldText} newText={diff.newText} maxLines={12} />
      ) : (
        (command ?? path) && (
          <pre
            tabIndex={-1}
            className="max-h-[252px] shrink-0 overflow-auto rounded-lg bg-cc-wash px-4 py-3 font-mono text-[13px] leading-[19px] break-all whitespace-pre-wrap text-cc-fg2 select-text"
          >
            {command ?? path}
          </pre>
        )
      )}
      {!command && request.description && <p className="max-h-[60px] shrink-0 overflow-y-auto text-cc-fg2">{request.description}</p>}
    </CardFrame>
  )
})
