// Adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/views/chat/messages/tool-message-block.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-command-output.tsx (Apache-2.0) and
// BloopAI/vibe-kanban@5f06193:packages/ui/src/components/{ChatTodoList,ChatFileEntry}.tsx (Apache-2.0).
// Changes: one body per Claude Code tool family over our ToolCall model; command
// output shows head/tail with a hidden-lines toggle instead of a scroll log; calm copy
// (§2.5): descriptions in tooltips, exit code only when non-zero, no "waiting" prose
// (the attention dock says it).
import { memo, useState, type ReactNode } from "react"
import { Pictures } from "../transcript/Media"
import { Check, Circle, CircleDot, ExternalLink } from "lucide-react"
import type { ToolCall } from "@/lib/model"
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
            className="my-0.5 inline-flex rounded-sm border border-border px-1.5 font-sans text-xs leading-4 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground"
            onClick={() => setAll(true)}
          >
            {ht.hidden} more lines
          </button>
          {"\n"}
          {ht.tail.join("\n")}
        </>
      )}
      {running && <span aria-hidden className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-muted-foreground" />}
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
        <code className="min-w-0 flex-1 font-mono text-xs leading-[18px] whitespace-pre-wrap text-foreground select-text" title={description}>
          <span className="text-muted-foreground/70 select-none">$ </span>
          {command}
        </code>
      </div>
      {call.display === "rejected" ? (
        <Denied call={call} />
      ) : call.output ? (
        <ClampedOutput text={call.output} running={running} tone={exit !== undefined && exit !== 0 ? "error" : undefined} />
      ) : running ? (
        <div className="text-xs text-muted-foreground/70">Running…</div>
      ) : null}
      {exit !== undefined && exit !== 0 && <div className="font-mono text-xs text-st-error-fg">exit {exit}</div>}
    </div>
  )
})

export const EditBody = memo(function EditBody({ call }: { call: ToolCall }) {
  const diffs = call.diff ?? []
  if (!diffs.length) {
    const inp = input(call)
    if (typeof inp.new_string === "string")
      return <InlineDiff path={String(inp.file_path ?? call.title)} oldText={String(inp.old_string ?? "")} newText={inp.new_string} />
    return <div className="text-xs text-muted-foreground/70">No diff</div>
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
    <div className="text-xs text-muted-foreground/70">
      Denied
      {feedback && (
        <>
          {" · "}
          <span className="text-muted-foreground select-text">“{feedback}”</span>
        </>
      )}
    </div>
  )
}

export const ReadBody = memo(function ReadBody({ call }: { call: ToolCall }) {
  if (!call.output) return <div className="text-xs text-muted-foreground/70">No output</div>
  return <CodeBlock className="max-h-[234px]">{call.output}</CodeBlock>
})

/** Grep/Glob: `path:line: text` rows with the path emphasized. */
export const SearchBody = memo(function SearchBody({ call }: { call: ToolCall }) {
  const lines = (call.output ?? "").split("\n").filter(Boolean)
  if (!lines.length) return <div className="text-xs text-muted-foreground/70">No matches</div>
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

/** Graphify MCP query result (RESEARCH §5): callers, cross-repo edges, god nodes. */
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
      {call.output && <CodeBlock className="max-h-[200px] whitespace-pre-wrap">{call.output}</CodeBlock>}
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
    <div className="text-xs text-muted-foreground/70">Waiting for your answer</div>
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
