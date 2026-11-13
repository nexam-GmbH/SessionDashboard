// Adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/views/chat/messages/tool-message-block.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-command-output.tsx (Apache-2.0) and
// BloopAI/vibe-kanban@5f06193:packages/ui/src/components/{ChatTodoList,ChatFileEntry}.tsx (Apache-2.0).
// Changes: one body per Claude Code tool family over our ToolCall model; command
// output shows head/tail with a hidden-lines toggle instead of a scroll log; calm copy
// (§2.5): descriptions in tooltips, exit code only when non-zero, no "waiting" prose
// (the attention dock says it).
import { memo, useState, type ReactNode } from "react"
import { Check, Circle, CircleDot, ExternalLink, SquareTerminal } from "lucide-react"
import type { ToolCall } from "@/lib/model"
import { setBottomTab } from "@/store/actions"
import { cn } from "@/lib/utils"
import { CodeBlock, MicroLabel } from "../common"
import { InlineDiff } from "./InlineDiff"
import { headTail, isRecord, splitMcpName } from "./toolSummary"

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

/** Long output → first/last lines plus a "N lines hidden" toggle. */
function ClampedOutput({ text, running, tone }: { text: string; running?: boolean; tone?: "error" }) {
  const [all, setAll] = useState(false)
  const ht = headTail(text, 8, 6)
  const lines = all || !ht.hidden ? text.replace(/\n$/, "") : null
  return (
    <CodeBlock className={cn("max-h-[360px]", tone === "error" && "text-st-error-fg")}>
      {lines ?? (
        <>
          {ht.head.join("\n")}
          {"\n"}
          <button
            type="button"
            className="my-0.5 inline-flex rounded-[3px] border border-line-subtle px-1.5 font-sans text-[11px] leading-4 text-fg-faint hover:bg-hover hover:text-fg-muted"
            onClick={() => setAll(true)}
          >
            {ht.hidden} more lines
          </button>
          {"\n"}
          {ht.tail.join("\n")}
        </>
      )}
      {running && <span aria-hidden className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-fg-muted" />}
    </CodeBlock>
  )
}

export const CommandBody = memo(function CommandBody({ call }: { call: ToolCall }) {
  const inp = input(call)
  const command = (inp.command as string) ?? call.terminal?.command ?? call.title
  const description = inp.description as string | undefined
  const exit = call.terminal?.exitCode
  const running = call.display === "running"
  return (
    <div className="group/cmd flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-fg select-text" title={description}>
          <span className="text-fg-faint select-none">$ </span>
          {command}
        </code>
        <button
          type="button"
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-[11px] text-fg-faint opacity-0 group-hover/cmd:opacity-100 hover:bg-hover hover:text-fg-muted focus-visible:opacity-100"
          onClick={() => setBottomTab("terminal")}
          title="Open in the terminal panel"
        >
          <SquareTerminal size={11} /> Terminal
        </button>
      </div>
      {call.display === "rejected" ? (
        <Denied call={call} />
      ) : call.output ? (
        <ClampedOutput text={call.output} running={running} tone={exit !== undefined && exit !== 0 ? "error" : undefined} />
      ) : running ? (
        <div className="text-[12px] text-fg-faint">Running…</div>
      ) : null}
      {exit !== undefined && exit !== 0 && <div className="font-mono text-[11px] text-st-error-fg">exit {exit}</div>}
    </div>
  )
})

export const EditBody = memo(function EditBody({ call }: { call: ToolCall }) {
  const diffs = call.diff ?? []
  if (!diffs.length) {
    const inp = input(call)
    if (typeof inp.new_string === "string")
      return <InlineDiff path={String(inp.file_path ?? call.title)} oldText={String(inp.old_string ?? "")} newText={inp.new_string} />
    return <div className="text-[12px] text-fg-faint">No diff</div>
  }
  return (
    <div className="flex flex-col gap-1.5">
      {diffs.map((d, i) => (
        <InlineDiff key={`${d.path}:${i}`} path={d.path} oldText={d.op === "add" ? undefined : d.oldText} newText={d.newText} maxLines={12} />
      ))}
      {call.display === "rejected" && <Denied call={call} />}
    </div>
  )
})

/** "Denied" plus the feedback Claude got (resolveRequest stores it as `Rejected: …`). */
function Denied({ call }: { call: ToolCall }) {
  const feedback = call.output?.startsWith("Rejected: ") ? call.output.slice("Rejected: ".length) : undefined
  return (
    <div className="text-[12px] text-fg-faint">
      Denied
      {feedback && (
        <>
          {" · "}
          <span className="text-fg-muted select-text">“{feedback}”</span>
        </>
      )}
    </div>
  )
}

export const ReadBody = memo(function ReadBody({ call }: { call: ToolCall }) {
  if (!call.output) return <div className="text-[12px] text-fg-faint">No output</div>
  return <CodeBlock className="max-h-[234px]">{call.output}</CodeBlock>
})

/** Grep/Glob: `path:line: text` rows with the path emphasized. */
export const SearchBody = memo(function SearchBody({ call }: { call: ToolCall }) {
  const lines = (call.output ?? "").split("\n").filter(Boolean)
  if (!lines.length) return <div className="text-[12px] text-fg-faint">No matches</div>
  return (
    <CodeBlock className="max-h-[234px]">
      {lines.map((l, i) => {
        const m = /^([^:]+):(\d+):(.*)$/.exec(l)
        return (
          <div key={i} className="truncate">
            {m ? (
              <>
                <span className="text-link">{m[1]}</span>
                <span className="text-fg-faint">:{m[2]}</span>
                <span className="text-fg-muted">{m[3]}</span>
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

/** Graphify MCP query result (RESEARCH §5): callers, cross-repo edges, god nodes. */
export const GraphBody = memo(function GraphBody({ call }: { call: ToolCall }) {
  const inp = input(call)
  const lines = (call.output ?? "").split("\n")
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-fg-faint">
        <span>
          query <span className="text-fg-muted">{String(inp.query ?? call.title)}</span>
        </span>
        {inp.depth !== undefined && (
          <span>
            depth <span className="tabular text-fg-muted">{String(inp.depth)}</span>
          </span>
        )}
      </div>
      <CodeBlock className="max-h-[234px]">
        {lines.map((l, i) => (
          <div key={i} className={cn(i === 0 ? "text-fg" : l.includes("cross-repo") ? "text-st-input-fg" : l.startsWith("God node") ? "text-fg-faint" : undefined)}>
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
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 font-mono text-[12px] text-link hover:underline">
          <span className="truncate">{url}</span>
          <ExternalLink size={11} className="shrink-0" />
        </a>
      )}
      {typeof inp.prompt === "string" && <div className="text-[12px] text-fg-faint">“{inp.prompt}”</div>}
      {call.output && <CodeBlock className="max-h-[200px] whitespace-pre-wrap">{call.output}</CodeBlock>}
    </div>
  )
})

const TODO_ICON = {
  completed: <Check size={12} className="text-st-done" />,
  in_progress: <CircleDot size={12} className="text-st-working" />,
  pending: <Circle size={12} className="text-fg-faint" />,
}

export function TodoList({ todos, className }: { todos: { content: string; status: keyof typeof TODO_ICON }[]; className?: string }) {
  return (
    <ul className={cn("flex flex-col gap-0.5", className)}>
      {todos.map((t, i) => (
        <li key={`${i}:${t.content}`} className="flex items-start gap-2 text-[12.5px] leading-[18px]">
          <span className="mt-[3px] inline-flex size-3 shrink-0 items-center justify-center">{TODO_ICON[t.status] ?? TODO_ICON.pending}</span>
          <span className={cn(t.status === "completed" ? "text-fg-faint" : t.status === "in_progress" ? "text-fg" : "text-fg-muted")}>{t.content}</span>
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
    <div className="text-[12px] text-fg-faint">Waiting for your answer</div>
  ) : (
    <div className="text-[12px] whitespace-pre-wrap text-fg-muted">{call.output ?? "Answered"}</div>
  )
})

/** Generic / MCP tool: collapsible JSON input and output (Cline generic tool block). */
export const GenericBody = memo(function GenericBody({ call }: { call: ToolCall }) {
  const isMcp = call.name.startsWith("mcp__")
  const { server, tool } = splitMcpName(call.name)
  return (
    <div className="flex flex-col gap-1.5">
      {isMcp && (
        <div className="text-[12px] text-fg-faint">
          MCP server <span className="font-mono text-fg-muted">{server}</span> · tool <span className="font-mono text-fg-muted">{tool}</span>
        </div>
      )}
      <div>
        <MicroLabel>Input</MicroLabel>
        <CodeBlock className="max-h-[180px]">{json(call.input)}</CodeBlock>
      </div>
      {call.output && (
        <div>
          <MicroLabel>Output</MicroLabel>
          <CodeBlock className="max-h-[200px] whitespace-pre-wrap">{call.output}</CodeBlock>
        </div>
      )}
    </div>
  )
})

export function ToolBody({ call, family }: { call: ToolCall; family: string }): ReactNode {
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
