// Adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/ui/markdown.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:sdk/packages/ui/components/markdown.ts (Apache-2.0): controls config and Shiki policy.
// Changes: streamdown `streaming` mode only for the live item, `static` otherwise, no caret (text
// streams in as in Claude Code desktop);
// code highlighting through @streamdown/code (Shiki, languages loaded lazily on
// first use, LRU-cached); no mermaid; quiet single-box code blocks via markdown.css.
import { memo, type ComponentProps } from "react"
import { Play } from "lucide-react"
import { Streamdown, type ControlsConfig } from "streamdown"
import { createCodePlugin } from "@streamdown/code"
import { cn } from "@/lib/utils"
import { currentSessionId } from "@/store/actions"
import { terminalCommandFor } from "@/features/terminal/slash"
import "./markdown.css"

/** Copy on code blocks; no downloads, no table/mermaid chrome (Cline agentMarkdownControls). */
const CONTROLS = { code: { copy: true, download: false }, mermaid: false, table: false } satisfies ControlsConfig
const PLUGINS = { code: createCodePlugin({ themes: ["github-light", "github-dark-default"] }) }

/**
 * Inline code. A `! command` (Claude asking you to run something, Claude Code's bash mode) or a
 * command that needs Claude Code's terminal UI (`/mcp`, `/login`) gets a Run button: one click runs
 * it in the terminal of the session's folder.
 */
function InlineCode(all: ComponentProps<"code"> & { node?: unknown }) {
  const { children, ...props } = all
  delete props.node
  const text = typeof children === "string" ? children : Array.isArray(children) && children.every((c) => typeof c === "string") ? children.join("") : ""
  const cmd = /^!\s*(\S.*)$/.exec(text.trim())?.[1]
  // a Claude Code command that needs its terminal UI (/mcp, /login…): runs in the built-in terminal
  const slash = !cmd && terminalCommandFor(text) ? text.trim() : undefined
  if (!cmd && !slash) return <code {...props}>{children}</code>
  return (
    <span className="inline-flex items-baseline gap-1">
      <code {...props}>{children}</code>
      <button
        type="button"
        data-run={cmd ?? slash}
        data-kind={cmd ? "shell" : "slash"}
        onClick={() => void import("@/features/terminal/terminals").then((t) => {
            if (cmd) void t.runInTerminal(cmd)
            else t.runSlashInTerminal(slash!, currentSessionId() ?? undefined)
          })}
        className="inline-flex h-6 translate-y-[2px] items-center gap-1 rounded-md bg-cc-secondary px-1.5 text-[13px] text-foreground hover:bg-cc-secondary-hover"
        title={`Run in the terminal: ${cmd ?? slash}`}
      >
        <Play className="size-3" /> Run
      </button>
    </span>
  )
}
const COMPONENTS = { inlineCode: InlineCode }

export const Markdown = memo(function Markdown({
  content,
  streaming = false,
  className,
}: {
  content: string
  streaming?: boolean
  className?: string
}) {
  return (
    <Streamdown
      className={cn("sd-markdown", className)}
      controls={CONTROLS}
      components={COMPONENTS}
      plugins={PLUGINS}
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
      lineNumbers={false}
      // no box with its own scrollbar inside the chat (streamdown caps tables at 300 px and code at
      // 400 px): the wheel scrolls the chat, and WebKitGTK has no nested scroller with a sticky
      // header to repaint on every step
      tableMaxHeight={0}
      codeBlockMaxHeight={0}
      dir="auto"
    >
      {content}
    </Streamdown>
  )
})
