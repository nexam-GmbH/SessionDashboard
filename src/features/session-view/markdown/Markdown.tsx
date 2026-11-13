// Adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/ui/markdown.tsx (Apache-2.0). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:sdk/packages/ui/components/markdown.ts (Apache-2.0): controls config and Shiki policy.
// Changes: streamdown `streaming` mode only for the live item, `static` otherwise;
// code highlighting through @streamdown/code (Shiki, languages loaded lazily on
// first use, LRU-cached); no mermaid; quiet single-box code blocks via markdown.css.
import { memo } from "react"
import { Streamdown, type ControlsConfig } from "streamdown"
import { createCodePlugin } from "@streamdown/code"
import { cn } from "@/lib/utils"
import "./markdown.css"

/** Copy on code blocks; no downloads, no table/mermaid chrome (Cline agentMarkdownControls). */
const CONTROLS = { code: { copy: true, download: false }, mermaid: false, table: false } satisfies ControlsConfig
const PLUGINS = { code: createCodePlugin({ themes: ["github-light", "github-dark-default"] }) }

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
      plugins={PLUGINS}
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      caret={streaming ? "block" : undefined}
      parseIncompleteMarkdown={streaming}
      lineNumbers={false}
      dir="auto"
    >
      {content}
    </Streamdown>
  )
})
