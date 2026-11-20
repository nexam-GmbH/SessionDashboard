// Inline diffs in the chat, with @pierre/diffs (and its Shiki) in their own chunk: pierre is the
// biggest library in the app, and the first bundle is parsed at every start. The chunk loads
// while the app is idle and when a session opens, so a diff rarely waits for it; when one does,
// an empty frame of the diff's height holds its place in the transcript.
import { lazy, memo, Suspense, type ComponentProps, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import type InlineDiffBodyType from "./InlineDiffBody"

/** One diff row: InlineDiffBody renders at this height, and the placeholder reserves it. */
export const LINE_PX = 19

const loadBody = () => import("./InlineDiffBody")
const InlineDiffBody = lazy(loadBody)
const DiffPoolKeeper = lazy(() => loadBody().then((m) => ({ default: m.DiffPoolKeeper })))

if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500))
  idle(() => void loadBody())
}

/** Keeps the shared Shiki worker pool alive while a session view is mounted (see InlineDiffBody). */
export function DiffWorkerPool({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Suspense fallback={null}>
        <DiffPoolKeeper />
      </Suspense>
    </>
  )
}

type InlineDiffProps = ComponentProps<typeof InlineDiffBodyType>

export const InlineDiff = memo(function InlineDiff(props: InlineDiffProps) {
  return (
    <Suspense fallback={<InlineDiffPlaceholder {...props} />}>
      <InlineDiffBody {...props} />
    </Suspense>
  )
})

/** Rows of the unified diff: both sides minus the lines they share at the start and the end. */
function diffRows(oldText: string | undefined, newText: string) {
  const split = (t: string) => (t ? (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n") : [])
  const a = split(oldText ?? "")
  const b = split(newText)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return a.length + b.length - head - tail
}

/** The diff's frame at its expected height: exact for new files and long edits (clamped), close otherwise. */
function InlineDiffPlaceholder({ oldText, newText, maxLines = 12, className }: InlineDiffProps) {
  const lines = diffRows(oldText, newText)
  const clamped = lines > maxLines
  return (
    <div
      aria-hidden
      className={cn("relative overflow-hidden rounded-lg bg-background after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:ring-1 after:ring-cc-wash-2 after:ring-inset", className)}
    >
      {/* the clamp is InlineDiffBody's; unclamped, pierre adds its 8 px gap above the first row */}
      <div style={{ height: clamped ? maxLines * LINE_PX + 4 : lines * LINE_PX + 8 }} className="bg-cc-surface" />
      {clamped && <div className="h-7 border-t border-cc-wash-2" />}
    </div>
  )
}
