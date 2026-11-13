// Adapted from cline/cline@72b3d71:apps/examples/desktop-app/webview/components/views/chat/changes-panel.tsx (Apache-2.0). Modified for session-dashboard.
// Adapted from pingdotgg/t3code@be5f805:apps/web/src/components/DiffPanel.tsx (MIT). Modified for session-dashboard.
// Review changes — UI_PLAN §5.4 (M4). Everything a session (or, for the main agent,
// a whole cross-repo task) changed: a one-row header (title · "N files +a −r" · Keep
// all / Reject all · Send comments when there are some · "⋯" with layout, turn filter
// and open session, after Zed's edits bar and T3 Code's DiffPanel header), file list
// on the left (Cline's changes column), virtualized diffs on the right; per-file
// Keep/Reject (Zed's idea, mock-only) and line comments sent to the session as one
// message (opencode / Vibe Kanban idea, Jean's comment format).
import { memo, useCallback, useEffect, useMemo, useRef } from "react"
import {
  ArrowUpRight,
  Check,
  Columns2,
  Ellipsis,
  Rows3,
  Send,
  ShieldAlert,
  X,
} from "lucide-react"
import { useShallow } from "zustand/react/shallow"
import type { ID, Session } from "@/lib/model"
import { getApp, useApp } from "@/store/app"
import { useSession } from "@/store/selectors"
import { openSession, select, sendMessage } from "@/store/actions"
import { ensureTranscript } from "@/mocks/transcript"
import { Button } from "@/components/ui/button"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DiffStat, EmptyState } from "@/components/common/bits"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import { capabilities } from "@/lib/status"
import { clockTime, plural } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  buildModel,
  useOwnerChanges,
  useOwners,
  type ReviewModel,
} from "./reviewModel"
import {
  clearComments,
  formatComments,
  markSent,
  selectScopeComments,
  setActive,
  setDiffStyle,
  setMarks,
  setTurn,
  useReviewStore,
  type ReviewComment,
} from "./reviewStore"
import { FileTree } from "./FileTree"
import { PendingComments } from "./Comments"
import { DiffList, DiffLoading, type DiffListApi } from "./DiffList"

export default function ReviewView({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId)
  const owners = useOwners(sessionId)
  useEffect(() => {
    for (const o of owners) ensureTranscript(o.id)
  }, [owners])
  // Keep the inspector on the reviewed session while this tab is visible.
  useEffect(() => {
    const sel = getApp().selection
    if (sel?.kind !== "session" || sel.id !== sessionId)
      select({ kind: "session", id: sessionId })
  }, [sessionId])
  const changes = useOwnerChanges(owners)
  const ready = owners.length > 0 && changes.every((c) => c !== null)
  const mainTurns = useApp((s) => s.transcripts[sessionId]?.turns)
  const turnPref = useReviewStore((s) => s.turnByScope[sessionId] ?? "all")
  const turn =
    turnPref !== "all" && mainTurns && turnPref > mainTurns.length
      ? "all"
      : turnPref
  const cross = session?.role === "main"
  // `changes` keeps its identity while only text streams (useShallow in useOwnerChanges)
  const model = useMemo(
    () => (ready ? buildModel(owners, changes, mainTurns, turn, cross) : null),
    [ready, owners, changes, mainTurns, turn, cross]
  )

  const storedActive = useReviewStore((s) => s.activeByScope[sessionId])
  const activeKey = model?.files.some((f) => f.key === storedActive)
    ? storedActive
    : model?.files[0]?.key
  const apiRef = useRef<DiffListApi | null>(null)

  const goTo = useCallback(
    (key: string) => {
      setActive(sessionId, key)
      apiRef.current?.toFile(key)
    },
    [sessionId]
  )
  const onActiveChange = useCallback(
    (key: string) => setActive(sessionId, key),
    [sessionId]
  )
  const jumpToComment = useCallback(
    (c: ReviewComment) => {
      setActive(sessionId, c.fileKey)
      apiRef.current?.toComment(c)
    },
    [sessionId]
  )

  // j/k and ↑/↓ move between files (single-key shortcuts are off while typing; UI_PLAN §7).
  const rootRef = useRef<HTMLDivElement>(null)
  const files = model?.files
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const dir =
        e.key === "j" || e.key === "ArrowDown"
          ? 1
          : e.key === "k" || e.key === "ArrowUp"
            ? -1
            : 0
      if (!dir) return
      const el = e.target as HTMLElement | null
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable ||
          el.closest(".xterm"))
      )
        return
      // arrows only when focus is in this view (or nowhere); j/k anywhere on the tab
      const arrow = e.key === "ArrowDown" || e.key === "ArrowUp"
      if (arrow && el && el !== document.body && !rootRef.current?.contains(el))
        return
      const st = getApp()
      if (
        st.activeTab !== `/review/${sessionId}` ||
        st.paletteOpen ||
        st.newSession ||
        document.querySelector("[role=dialog],[role=menu]")
      )
        return
      if (!files?.length) return
      e.preventDefault()
      const i = files.findIndex((f) => f.key === activeKey)
      const next =
        files[Math.max(0, Math.min(files.length - 1, (i < 0 ? -1 : i) + dir))]
      if (next) goTo(next.key)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [sessionId, goTo, files, activeKey])

  if (!session) return <EmptyState>Session not found.</EmptyState>

  return (
    <div
      ref={rootRef}
      className="@container flex h-full min-h-0 flex-col bg-canvas"
    >
      <ReviewHeader session={session} model={model} turn={turn} />
      <div className="min-h-0 flex-1">
        {!model ? (
          <LoadingLayout />
        ) : model.files.length === 0 ? (
          turn !== "all" ? (
            <EmptyState
              action={
                <div className="mt-1 flex gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setTurn(sessionId, "all")}
                  >
                    Show all turns
                  </Button>
                  {model.pending > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openSession(sessionId)}
                    >
                      <ArrowUpRight /> Open session
                    </Button>
                  )}
                </div>
              }
            >
              <div className="text-[13px] text-fg-muted">
                No changes in turn {turn}
              </div>
              {model.pending > 0 && (
                <div className="mt-1">{model.pending} awaiting approval</div>
              )}
            </EmptyState>
          ) : (
            <EmptyState
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => openSession(sessionId)}
                >
                  <ArrowUpRight /> Open session
                </Button>
              }
            >
              <div className="text-[13px] text-fg-muted">No changes yet</div>
              {model.pending > 0 && (
                <div className="mt-1">{model.pending} awaiting approval</div>
              )}
            </EmptyState>
          )
        ) : (
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel
              id="review-files"
              defaultSize="272px"
              minSize="200px"
              maxSize="460px"
              groupResizeBehavior="preserve-pixel-size"
              className="flex min-h-0 flex-col bg-chrome"
            >
              <div className="min-h-0 flex-1">
                <FileTree
                  scope={sessionId}
                  model={model}
                  activeKey={activeKey}
                  onSelect={goTo}
                />
              </div>
              <PendingComments scope={sessionId} onJump={jumpToComment} />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              id="review-diff"
              minSize="320px"
              className="min-w-0"
            >
              <DiffList
                scope={sessionId}
                model={model}
                apiRef={apiRef}
                onActiveChange={onActiveChange}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    </div>
  )
}

function LoadingLayout() {
  return (
    <div className="flex h-full">
      <div
        className="w-[272px] shrink-0 space-y-2 border-r border-line-subtle bg-chrome p-3"
        role="status"
        aria-label="Loading changes"
      >
        <div className="h-6 rounded-[4px] bg-elevated" />
        {["w-3/4", "w-1/2", "w-2/3", "w-3/5", "w-1/2"].map((w, i) => (
          <div
            key={i}
            className={cn("h-2.5 rounded-[2px] bg-elevated", w)}
            style={{ marginLeft: i % 2 ? 12 : 0 }}
          />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <DiffLoading label="Loading changes" />
      </div>
    </div>
  )
}

// ---------- header ----------
const ReviewHeader = memo(function ReviewHeader({
  session,
  model,
  turn,
}: {
  session: Session
  model: ReviewModel | null
  turn: number | "all"
}) {
  const sid = session.id
  const cross = session.role === "main"
  const repo = useApp((s) =>
    session.repoId ? s.repos[session.repoId] : undefined
  )
  const diffStyle = useReviewStore((s) => s.diffStyle)
  const comments = useReviewStore(
    useShallow((s) => selectScopeComments(s, sid))
  )
  const keys = useMemo(() => model?.files.map((f) => f.key) ?? [], [model])
  const reviewed = useReviewStore((s) =>
    keys.reduce((n, k) => (s.marks[k] ? n + 1 : n), 0)
  )
  const sent = useSentFlash(sid)
  const canSend = capabilities(session.control).send
  const total = model?.totals.files ?? 0
  const repos = cross
    ? (model?.groups.filter((g) => !g.id.startsWith("self:")).length ?? 0)
    : 0

  const send = () => {
    const list = selectScopeComments(useReviewStore.getState(), sid)
    if (!list.length) return
    sendMessage(sid, formatComments(list), "now")
    clearComments(sid)
    markSent(sid, list.length)
  }

  return (
    <header className="flex h-10 shrink-0 min-w-0 items-center gap-2 border-b border-line-subtle bg-chrome pr-2 pl-3">
      <StatusGlyph status={session.status} size="sm" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1
          className="min-w-0 truncate text-[13px] font-medium text-fg"
          title={session.title}
        >
          {session.title}
        </h1>
        <span className="hidden shrink-0 text-[12px] text-fg-faint @xl:inline">
          {cross ? plural(repos, "repo") : (repo?.name ?? "")}
        </span>
        {model && total > 0 && (
          <span
            className="flex shrink-0 items-baseline gap-1.5 text-[12px] text-fg-muted"
            title={`${reviewed}/${total} reviewed`}
          >
            <span className="tabular">{plural(total, "file")}</span>
            <DiffStat added={model.totals.added} removed={model.totals.removed} />
          </span>
        )}
        {turn !== "all" && (
          <button
            type="button"
            onClick={() => setTurn(sid, "all")}
            title="Show all turns"
            className="inline-flex h-5 shrink-0 items-center gap-1 self-center rounded-[3px] border border-line-subtle px-1.5 text-[11.5px] text-fg-muted hover:bg-hover hover:text-fg"
          >
            <span className="tabular">Turn {turn}</span>
            <X size={11} className="text-fg-faint" />
          </button>
        )}
        {model && model.pending > 0 && (
          <button
            type="button"
            onClick={() => openSession(sid)}
            title="Proposed edits not applied yet: approve them in the session"
            className="inline-flex shrink-0 items-center gap-1 self-center text-[12px] text-st-perm-fg hover:underline"
          >
            <ShieldAlert size={12} />
            <span className="tabular">{model.pending} pending</span>
          </button>
        )}
        {sent && (
          <span
            className="flex shrink-0 items-center gap-1 self-center text-[12px] text-fg-muted"
            role="status"
          >
            <Check size={12} /> Sent
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={!total}
          onClick={() => setMarks(keys, "rejected")}
          title="Reject all (mock)"
        >
          <X /> <span className="hidden @2xl:inline">Reject all</span>
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!total}
          onClick={() => setMarks(keys, "kept")}
          title="Keep all (mock)"
        >
          <Check /> <span className="hidden @2xl:inline">Keep all</span>
        </Button>
        {comments.length > 0 && (
          <Button
            size="sm"
            variant="default"
            disabled={!canSend}
            onClick={send}
            title={canSend ? "Send as one message" : "Resume the session first"}
          >
            <Send />
            <span>
              Send {comments.length}
              <span className="hidden @3xl:inline">
                {" "}
                {comments.length === 1 ? "comment" : "comments"}
              </span>
            </span>
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="More actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuRadioGroup
              value={diffStyle}
              onValueChange={(v) => setDiffStyle(v as typeof diffStyle)}
            >
              <DropdownMenuRadioItem value="unified" className="text-[12px]">
                <Rows3 /> Unified
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split" className="text-[12px]">
                <Columns2 /> Split
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {model && model.turns.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <TurnSubmenu sid={sid} model={model} turn={turn} />
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-[12px]"
              onSelect={() => openSession(sid)}
            >
              <ArrowUpRight /> Open session
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
})

function TurnSubmenu({
  sid,
  model,
  turn,
}: {
  sid: ID
  model: ReviewModel
  turn: number | "all"
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="text-[12px] [&>svg]:size-3 [&>svg]:text-fg-faint">
        <span className="flex-1">Turn</span>
        <span className="tabular text-fg-faint">
          {turn === "all" ? "All" : turn}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-52">
        <DropdownMenuRadioGroup
          value={String(turn)}
          onValueChange={(v) => setTurn(sid, v === "all" ? "all" : Number(v))}
        >
          <DropdownMenuRadioItem value="all" className="text-[12px]">
            All turns
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {model.turns.map((t) => (
            <DropdownMenuRadioItem
              key={t.index}
              value={String(t.index)}
              className="text-[12px]"
            >
              <span className="tabular">Turn {t.index}</span>
              <span className="ml-auto text-[11px] text-fg-faint tabular">
                {t.files ? plural(t.files, "file") : t.pending ? "pending" : "—"}{" "}
                · {clockTime(t.startedAt)}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** "Sent N comments" for a few seconds after sending. */
function useSentFlash(scope: ID) {
  return useReviewStore((s) => s.sent[scope])
}
