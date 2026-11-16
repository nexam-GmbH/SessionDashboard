// Adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/views/chat/messages/tool-message-block.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-command-output.tsx (Apache-2.0) and
// BloopAI/vibe-kanban@5f06193:packages/ui/src/components/{ChatTodoList,ChatFileEntry}.tsx (Apache-2.0).
// Changes: one body per Claude Code tool family over our ToolCall model; output stops at a max
// height with "Show all N lines"; a read shows its line count with the contents one click
// further; a denial shows the feedback you gave (the row itself carries the Denied badge).
import { memo, useState, type ReactNode } from "react"
import { Pictures } from "../transcript/Media"
import { Check, Circle, CircleDot, ExternalLink } from "lucide-react"
import type { ToolCall } from "@/lib/model"
import { cn } from "@/lib/utils"
import { CodeBlock, MicroLabel } from "../common"
import { InlineDiff } from "./InlineDiff"
import { isRecord, splitMcpName } from "./toolSummary"

function input(call: ToolCall) {
  return (isRecord(call.input) ? call.input : {}) as Record<string, unknown>
}

function json(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Output in a mono block: long output stops at a max height with "Show all N lines" under it. */
function ClampedOutput({ text, running, tone, lines = 14 }: { text: string; running?: boolean; tone?: "error"; lines?: number }) {
  const [all, setAll] = useState(false)
  const body = text.replace(/\n$/, "")
  const total = body.split("\n").length
  const clamped = !all && total > lines
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <pre
        style={clamped ? { maxHeight: lines * 18 + 16 } : undefined}
        className={cn(
          "overflow-x-auto px-3 py-2 font-mono text-xs leading-[18px] whitespace-pre text-muted-foreground select-text",
          clamped ? "overflow-y-hidden" : "max-h-[480px] overflow-y-auto",
          tone === "error" && "text-st-error-fg",
        )}
      >
        {body}
        {running && <span aria-hidden className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-muted-foreground/70" />}
      </pre>
      {total > lines && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="flex h-6 w-full items-center justify-center border-t border-border text-xs text-muted-foreground/70 outline-none hover:bg-accent hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {all ? "Show less" : `Show all ${total} lines`}
        </button>
      )}
    </div>
  )
}

const Quiet = ({ children }: { children: ReactNode }) => <div className="text-xs text-muted-foreground/70">{children}</div>

export const CommandBody = memo(function CommandBody({ call }: { call: ToolCall }) {
  const inp = input(call)
  const command = (inp.command as string) ?? call.terminal?.command ?? call.title
  const description = inp.description as string | undefined
  const exit = call.terminal?.exitCode
  const running = call.display === "running"
  const failed = (exit !== undefined && exit !== 0) || call.display === "failed"
  return (
    <div className="flex flex-col gap-1.5">
      {description && <Quiet>{description}</Quiet>}
      <code className="block font-mono text-xs leading-[18px] whitespace-pre-wrap text-foreground select-text">
        <span className="text-muted-foreground/70 select-none">$ </span>
        {command}
      </code>
      {call.display === "rejected" ? (
        <Denied call={call} />
      ) : call.output ? (
        <ClampedOutput text={call.output} running={running} tone={failed ? "error" : undefined} />
      ) : running ? (
        <Quiet>Waiting for output…</Quiet>
      ) : call.display === "done" ? (
        <Quiet>No output</Quiet>
      ) : null}
      {exit !== undefined && exit !== 0 && <div className="font-mono text-xs text-st-error-fg">Exit code {exit}</div>}
    </div>
  )
})

export const EditBody = memo(function EditBody({ call }: { call: ToolCall }) {
  const diffs = call.diff ?? []
  const denied = call.display === "rejected" && <Denied call={call} />
  if (!diffs.length) {
    const inp = input(call)
    if (typeof inp.new_string === "string")
      return (
        <div className="flex flex-col gap-1.5">
          <InlineDiff path={String(inp.file_path ?? call.title)} oldText={String(inp.old_string ?? "")} newText={inp.new_string} />
          {denied}
        </div>
      )
    return denied || <Quiet>No changes to show</Quiet>
  }
  return (
    <div className="flex flex-col gap-1.5">
      {diffs.map((d, i) => (
        <InlineDiff key={`${d.path}:${i}`} path={d.path} oldText={d.op === "add" ? undefined : d.oldText} newText={d.newText} maxLines={14} />
      ))}
      {denied}
      {call.display === "failed" && call.output && <ClampedOutput text={call.output} tone="error" lines={6} />}
    </div>
  )
})

/** The feedback Claude got with a denial (resolveRequest stores it as `Rejected: …`); the row already says Denied. */
function Denied({ call }: { call: ToolCall }) {
  const feedback = call.output?.startsWith("Rejected: ") ? call.output.slice("Rejected: ".length) : undefined
  if (!feedback) return <Quiet>You denied this, so it did not run.</Quiet>
  return (
    <div className="text-xs text-muted-foreground/70">
      You said: <span className="text-muted-foreground select-text">“{feedback}”</span>
    </div>
  )
}

/** A read: how much of the file Claude read, and the text itself one click further. */
export const ReadBody = memo(function ReadBody({ call }: { call: ToolCall }) {
  const [show, setShow] = useState(false)
  if (call.display === "rejected") return <Denied call={call} />
  if (!call.output) return <Quiet>{call.display === "running" ? "Reading…" : "Nothing read"}</Quiet>
  const n = call.output.replace(/\n$/, "").split("\n").length
  const inp = input(call)
  const from = typeof inp.offset === "number" ? inp.offset : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
        <span className="tabular">
          {n === 1 ? "1 line" : `${n} lines`}
          {from !== undefined ? ` from line ${from}` : ""}
        </span>
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="rounded-sm text-muted-foreground/70 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
        >
          {show ? "Hide contents" : "Show contents"}
        </button>
      </div>
      {show && <ClampedOutput text={call.output} />}
    </div>
  )
})

/** Grep/Glob: `path:line: text` rows with the path emphasized. */
export const SearchBody = memo(function SearchBody({ call }: { call: ToolCall }) {
  const lines = (call.output ?? "").split("\n").filter(Boolean)
  if (call.display === "rejected") return <Denied call={call} />
  if (!lines.length) return <Quiet>{call.display === "running" ? "Searching…" : "No matches"}</Quiet>
  return (
    <CodeBlock className="max-h-[234px]">
      {lines.map((l, i) => {
        const m = /^([^:]+):(\d+):(.*)$/.exec(l)
        return (
          <div key={i} className="truncate">
            {m ? (
              <>
                <span className="text-link">{m[1]}</span>
                <span className="text-muted-foreground/70">:{m[2]}</span>
                <span className="text-muted-foreground">{m[3]}</span>
              </>
            ) : (
              <span className="text-link">{l}</span>
            )}
          </div>
        )
      })}
    </CodeBlock>
  )
})

/** Graphify MCP query result: callers, cross-repo edges, god nodes. */
export const GraphBody = memo(function GraphBody({ call }: { call: ToolCall }) {
  const inp = input(call)
  const lines = (call.output ?? "").split("\n")
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground/70">
        <span>
          query <span className="text-muted-foreground">{String(inp.query ?? call.title)}</span>
        </span>
        {inp.depth !== undefined && (
          <span>
            depth <span className="tabular text-muted-foreground">{String(inp.depth)}</span>
          </span>
        )}
      </div>
      <CodeBlock className="max-h-[234px]">
        {lines.map((l, i) => (
          <div key={i} className={cn(i === 0 ? "text-foreground" : l.includes("cross-repo") ? "text-st-input-fg" : l.startsWith("God node") ? "text-muted-foreground/70" : undefined)}>
            {l || " "}
          </div>
        ))}
      </CodeBlock>
    </div>
  )
})

export const WebBody = memo(function WebBody({ call }: { call: ToolCall }) {
  const inp = input(call)
  const url = typeof inp.url === "string" ? inp.url : undefined
  return (
    <div className="flex flex-col gap-1.5">
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-link hover:underline">
          <span className="truncate">{url}</span>
          <ExternalLink size={11} className="shrink-0" />
        </a>
      )}
      {typeof inp.prompt === "string" && <div className="text-xs text-muted-foreground/70">“{inp.prompt}”</div>}
      {call.display === "rejected" ? <Denied call={call} /> : call.output && <ClampedOutput text={call.output} lines={10} />}
    </div>
  )
})

const TODO_ICON = {
  completed: <Check size={12} className="text-st-done" />,
  in_progress: <CircleDot size={12} className="text-st-working" />,
  pending: <Circle size={12} className="text-muted-foreground/70" />,
}

export function TodoList({ todos, className }: { todos: { content: string; status: keyof typeof TODO_ICON }[]; className?: string }) {
  return (
    <ul className={cn("flex flex-col gap-0.5", className)}>
      {todos.map((t, i) => (
        <li key={`${i}:${t.content}`} className="flex items-start gap-2 text-xs leading-[18px]">
          <span className="mt-[3px] inline-flex size-3 shrink-0 items-center justify-center">{TODO_ICON[t.status] ?? TODO_ICON.pending}</span>
          <span className={cn(t.status === "completed" ? "text-muted-foreground/70" : t.status === "in_progress" ? "text-foreground" : "text-muted-foreground")}>{t.content}</span>
        </li>
      ))}
    </ul>
  )
}

export const TodoBody = memo(function TodoBody({ call }: { call: ToolCall }) {
  const todos = Array.isArray(input(call).todos) ? (input(call).todos as { content: string; status: "pending" | "in_progress" | "completed" }[]) : []
  return <TodoList todos={todos} />
})

export const QuestionBody = memo(function QuestionBody({ call }: { call: ToolCall }) {
  return call.display === "awaiting_permission" ? (
    <Quiet>Waiting for your answer</Quiet>
  ) : (
    <div className="text-xs whitespace-pre-wrap text-muted-foreground">{call.output ?? "Answered"}</div>
  )
})

/** Generic / MCP tool: collapsible JSON input and output (Cline generic tool block). */
export const GenericBody = memo(function GenericBody({ call }: { call: ToolCall }) {
  const isMcp = call.name.startsWith("mcp__")
  const { server, tool } = splitMcpName(call.name)
  return (
    <div className="flex flex-col gap-1.5">
      {isMcp && (
        <div className="text-xs text-muted-foreground/70">
          MCP server <span className="font-mono text-muted-foreground">{server}</span> · tool <span className="font-mono text-muted-foreground">{tool}</span>
        </div>
      )}
      <div>
        <MicroLabel>Input</MicroLabel>
        <CodeBlock className="max-h-[180px]">{json(call.input)}</CodeBlock>
      </div>
      {call.display === "rejected" ? (
        <Denied call={call} />
      ) : (
        call.output && (
          <div>
            <MicroLabel>Output</MicroLabel>
            <ClampedOutput text={call.output} lines={10} tone={call.display === "failed" ? "error" : undefined} />
          </div>
        )
      )}
    </div>
  )
})

export function ToolBody({ call, family }: { call: ToolCall; family: string }): ReactNode {
  // a picture the tool read (an image file, a screenshot) shows as the picture
  if (call.images?.length) return <Pictures pictures={call.images} className="py-1.5" />
  switch (family) {
    case "command":
      return <CommandBody call={call} />
    case "edit":
      return <EditBody call={call} />
    case "read":
      return <ReadBody call={call} />
    case "search":
      return <SearchBody call={call} />
    case "graph":
      return <GraphBody call={call} />
    case "web":
      return <WebBody call={call} />
    case "todo":
      return <TodoBody call={call} />
    case "question":
      return <QuestionBody call={call} />
    default:
      return <GenericBody call={call} />
  }
}
