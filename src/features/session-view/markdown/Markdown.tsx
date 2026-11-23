// Adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/ui/markdown.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:sdk/packages/ui/components/markdown.ts (Apache-2.0): controls config and Shiki policy.
// Changes: streamdown `streaming` mode only for the live item, `static` otherwise, no caret (text
// streams in as in Claude Code desktop);
// code highlighting through @streamdown/code (Shiki, languages loaded lazily on
// first use, LRU-cached); no mermaid; quiet single-box code blocks via markdown.css.
import { memo, useRef, useState, type ComponentProps } from "react"
import { Check, Copy, Play } from "lucide-react"
import { Streamdown, type ControlsConfig, type LinkSafetyConfig } from "streamdown"
import type { CodeHighlighterPlugin, HighlightOptions, HighlightResult } from "@streamdown/code"
import { cn } from "@/lib/utils"
import { currentSessionId } from "@/store/actions"
import { terminalCommandFor } from "@/features/terminal/slash"
import { CLAUDE_DARK, CLAUDE_LIGHT } from "./claudeTheme"
import { LinkDialog } from "./LinkDialog"
import "./markdown.css"

/** Copy on code blocks; no downloads, no table/mermaid chrome (Cline agentMarkdownControls). */
const CONTROLS = { code: { copy: true, download: false }, mermaid: false, table: false } satisfies ControlsConfig
const LINKS: LinkSafetyConfig = { enabled: true, renderModal: (p) => <LinkDialog {...p} /> }
const THEMES: HighlightOptions["themes"] = [CLAUDE_LIGHT, CLAUDE_DARK]

// @streamdown/code brings Shiki and its regex engine (about 200 KB) into the first bundle. Its
// highlight is asynchronous anyway (null at first, the tokens through the callback once the
// grammar has loaded), so the plugin can come in its own chunk without changing what a code block
// shows: the chunk loads while the app is idle, or with the first block that needs it.
let codePlugin: CodeHighlighterPlugin | null = null
let codePluginLoad: Promise<CodeHighlighterPlugin> | null = null
const loadCodePlugin = () =>
  (codePluginLoad ??= import("@streamdown/code").then((m) => (codePlugin = m.createCodePlugin({ themes: THEMES }))))
if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500))
  idle(() => void loadCodePlugin().catch(() => undefined))
}
const LAZY_CODE_PLUGIN: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getThemes: () => THEMES,
  supportsLanguage: (language) => codePlugin?.supportsLanguage(language) ?? true,
  getSupportedLanguages: () => codePlugin?.getSupportedLanguages() ?? [],
  highlight(options, callback) {
    if (codePlugin) return codePlugin.highlight(options, callback)
    void loadCodePlugin().then(
      (plugin) => {
        const result: HighlightResult | null = plugin.highlight(options, callback)
        if (result) callback?.(result)
      },
      (error) => console.error("[Streamdown Code] Failed to load the highlighter:", error),
    )
    return null
  },
}
const PLUGINS = { code: LAZY_CODE_PLUGIN }

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
/** A quote's text as you would paste it: its paragraphs, and its lists with their "- " or "1. ". */
function quoteText(el: HTMLElement): string {
  return [...el.children]
    .filter((c) => !(c as HTMLElement).dataset.quoteCopy)
    .map((c) => {
      if (c.tagName !== "UL" && c.tagName !== "OL") return (c as HTMLElement).innerText.trim()
      return [...c.children].map((li, i) => `${c.tagName === "OL" ? `${i + 1}.` : "-"} ${(li as HTMLElement).innerText.trim()}`).join("\n")
    })
    .filter(Boolean)
    .join("\n\n")
}

/** A quote (often the text Claude wrote for you to send on) with its own Copy, shown on hover beside its end, not across the column. */
function Blockquote(all: ComponentProps<"blockquote"> & { node?: unknown }) {
  const { node: _node, children, ...props } = all
  const ref = useRef<HTMLQuoteElement>(null)
  const [done, setDone] = useState(false)
  return (
    <blockquote {...props} ref={ref} className="sd-quote relative">
      {children}
      <button
        type="button"
        data-quote-copy="1"
        aria-label={done ? "Copied" : "Copy quote"}
        title="Copy quote"
        onClick={() => {
          if (!ref.current) return
          void navigator.clipboard?.writeText(quoteText(ref.current)).catch(() => undefined)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        }}
        className="sd-quote-copy absolute top-0 right-0 inline-flex size-7 items-center justify-center rounded-md text-cc-fg3 hover:bg-cc-ghost hover:text-foreground"
      >
        {done ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </blockquote>
  )
}
const COMPONENTS = { inlineCode: InlineCode, blockquote: Blockquote }

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
      linkSafety={LINKS}
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
