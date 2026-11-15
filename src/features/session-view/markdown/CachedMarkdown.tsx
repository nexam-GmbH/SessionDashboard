// Finished-message markdown, rendered once ("markdown for finished items
// rendered once and LRU-cached by (itemId, version)").
// - First mount: a cheap plain-text paragraph placeholder paints immediately; the real
//   streamdown tree renders in a transition, so React time-slices it while scrolling.
// - On unmount the final DOM (highlighted code included) is kept in an LRU; later
//   mounts (scrolling back) paint that HTML directly with no markdown parsing.
// Code-block copy keeps working on cached HTML through one delegated click handler.
import { memo, startTransition, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react"
import { cn } from "@/lib/utils"
import { currentSessionId } from "@/store/actions"
import { Markdown } from "./Markdown"

const MAX_ENTRIES = 600
const html = new Map<string, string>()

function remember(key: string, value: string) {
  html.delete(key)
  html.set(key, value)
  if (html.size > MAX_ENTRIES) html.delete(html.keys().next().value as string)
}

/** Roughly strip inline markdown so the placeholder has the same words and similar height. */
function plain(content: string) {
  return content
    .replace(/```[a-z]*\n?/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .split(/\n{2,}/)
}

/** Cached HTML has no React handlers: code-block copy and the Run buttons work through this one. */
function copyFromCachedBlock(e: MouseEvent<HTMLDivElement>) {
  const btn = (e.target as HTMLElement).closest("button")
  if (!btn) return
  const run = btn.getAttribute("data-run")
  if (run) {
    void import("@/features/terminal/terminals").then((t) => {
      if (btn.getAttribute("data-kind") === "slash") t.runSlashInTerminal(run, currentSessionId() ?? undefined)
      else void t.runInTerminal(run)
    })
    return
  }
  if (!btn.closest('[data-streamdown="code-block-actions"]')) return
  const code = btn.closest('[data-streamdown="code-block"]')?.querySelector("pre")?.textContent
  if (code) void navigator.clipboard?.writeText(code)
}

// Rows that mount while you scroll fast paint a plain placeholder first; rows that mount at rest
// (opening a chat) render the markdown at once, so nothing flips from plain to formatted on screen.
let lastScroll = 0
if (typeof window !== "undefined") {
  window.addEventListener("scroll", () => (lastScroll = performance.now()), { capture: true, passive: true })
}
const scrolling = () => performance.now() - lastScroll < 150

export const CachedMarkdown = memo(function CachedMarkdown({
  cacheKey,
  content,
  className,
  eager = false,
}: {
  /** item id; the content length is appended as its version */
  cacheKey: string
  content: string
  className?: string
  /** render the real markdown on first paint (live tail: few rows, no placeholder flash) */
  eager?: boolean
}) {
  const key = `${cacheKey}:${content.length}`
  const [cached] = useState(() => html.get(key))
  const [upgraded, setUpgraded] = useState(() => eager || !scrolling())
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (cached) return
    startTransition(() => setUpgraded(true))
  }, [cached])

  // Snapshot the final DOM when the row leaves (virtualized away or unmounted).
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host || cached || !upgraded) return
    return () => {
      if (host.firstElementChild) remember(key, host.innerHTML)
    }
  }, [key, cached, upgraded])

  if (cached) {
    return <div className="contents" onClick={copyFromCachedBlock} dangerouslySetInnerHTML={{ __html: cached }} />
  }
  return (
    <div ref={hostRef} className="contents">
      {upgraded ? (
        <Markdown content={content} className={className} />
      ) : (
        <div className={cn("sd-markdown", className)}>
          {plain(content).map((p, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {p}
            </p>
          ))}
        </div>
      )}
    </div>
  )
})
