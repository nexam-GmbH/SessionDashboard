// Adapted from agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/AskUserQuestionCard.tsx (MIT). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-ask-question.tsx (Apache-2.0).
// Claude Code desktop's AskUserQuestion card: the question with a "‹ 1 of 3 ›" pager, numbered
// 44 px option rows, a "Something else" field, then "{n} selected" · Skip · Next / Submit. In
// single-select a pick answers at once (Submit once every question has an answer).
import { memo, useEffect, useId, useRef, useState } from "react"
import { Check, X } from "lucide-react"
import type { QuestionRequest } from "@/lib/model"
import {
  answerRequest,
  skipQuestion,
} from "@/features/session-view/sessionStore"
import { MOD } from "@/components/common/bits"
import { cn } from "@/lib/utils"
import {
  canStealFocus,
  ENTER,
  FadeScroll,
  FOCUS,
  modEnter,
  OptionButton,
  PagerNav,
  plain,
  useCardKeys,
  type Pager,
} from "./cardChrome"

type Answer = { picked: string[]; other: string; otherOn: boolean }
const EMPTY: Answer = { picked: [], other: "", otherOn: false }

function answerValue(a: Answer, multi: boolean): string | string[] | undefined {
  const vals = [
    ...a.picked,
    ...(a.otherOn && a.other.trim() ? [a.other.trim()] : []),
  ]
  if (!vals.length) return undefined
  return multi ? vals : vals[0]
}

// rows: a hairline between them, inset 12 px, gone beside a hovered row
const ROW =
  "relative flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-start hover:bg-cc-wash"
const SEP =
  "before:absolute before:inset-x-3 before:top-0 before:h-px before:scale-y-50 before:bg-cc-wash-2 before:transition-opacity before:duration-150 hover:before:opacity-0"
const TILE =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-sm tabular-nums"

export const QuestionCard = memo(function QuestionCard({
  request,
  canAnswer,
  pager,
  docked,
}: {
  request: QuestionRequest
  canAnswer: boolean
  pager?: Pager
  docked: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const otherRef = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const [tab, setTab] = useState(0)
  const [answers, setAnswers] = useState<Answer[]>(() =>
    request.questions.map(() => EMPTY)
  )
  // the option whose preview shows (the one last hovered or focused)
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (docked && canStealFocus()) ref.current?.focus({ preventScroll: true })
  }, [docked, request.id])

  const n = request.questions.length
  const q = request.questions[tab]
  const a = answers[tab] ?? EMPTY
  const valueOf = (list: Answer[], i: number) =>
    answerValue(list[i] ?? EMPTY, request.questions[i].multiSelect)
  const anyAnswered = answers.some((_, i) => valueOf(answers, i) !== undefined)
  const last = tab === n - 1

  const submit = (list = answers) => {
    if (!canAnswer) return
    const out: Record<string, string | string[]> = {}
    request.questions.forEach((qq, i) => {
      const v = valueOf(list, i)
      if (v !== undefined) out[qq.question] = v
    })
    if (Object.keys(out).length) answerRequest(request, out)
  }
  const patch = (p: Partial<Answer>) =>
    setAnswers((prev) => prev.map((x, j) => (j === tab ? { ...x, ...p } : x)))
  /** After a question is answered: the next unanswered one, or send when none is left. */
  const advance = (list: Answer[]) => {
    const open = list.findIndex(
      (_, i) => i !== tab && valueOf(list, i) === undefined
    )
    if (open < 0) submit(list)
    else setTab(open)
  }
  const pick = (label: string) => {
    if (!canAnswer) return
    if (q.multiSelect)
      return patch({
        picked: a.picked.includes(label)
          ? a.picked.filter((x) => x !== label)
          : [...a.picked, label],
      })
    const next = answers.map((x, j) =>
      j === tab ? { ...x, picked: [label], otherOn: false } : x
    )
    setAnswers(next)
    advance(next)
  }
  const focusRow = (d: 1 | -1) => {
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLElement>("[data-opt]") ?? []),
    ]
    const i = rows.indexOf(document.activeElement as HTMLElement)
    rows[
      i < 0
        ? d > 0
          ? 0
          : rows.length - 1
        : (i + d + rows.length) % rows.length
    ]?.focus()
  }

  useCardKeys(
    ref,
    docked &&
      canAnswer &&
      ((e) => {
        if (modEnter(e) && !e.shiftKey) {
          submit()
          return true
        }
        if (!plain(e) && !(e.shiftKey && e.key.length === 1)) return false
        const inCard = !!ref.current?.contains(e.target as Node)
        const i = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1
        if (i >= 0 && q.options[i]) pick(q.options[i].label)
        else if (e.key === "Escape") skipQuestion(request)
        else if (!inCard) return false
        else if (e.key === "ArrowDown" || e.key === "ArrowUp")
          focusRow(e.key === "ArrowDown" ? 1 : -1)
        else if (e.key === "ArrowLeft" && tab > 0) setTab(tab - 1)
        else if (e.key === "ArrowRight" && !last) setTab(tab + 1)
        else if (e.key === "Enter" && e.target === ref.current) advance(answers)
        else {
          // typing jumps into "Something else" (the key itself lands there)
          if (e.key.length === 1 && e.key !== " ") otherRef.current?.focus()
          return false
        }
        return true
      })
  )

  const preview = q.options.some((o) => o.preview)
  const count = a.picked.length + (a.otherOn && a.other.trim() ? 1 : 0)
  const role = q.multiSelect ? "checkbox" : "radio"
  return (
    <section
      ref={ref}
      role="region"
      aria-label="Question from Claude"
      aria-describedby={hintId}
      tabIndex={0}
      className={cn(
        "@container flex min-h-0 flex-col overflow-hidden pt-3 text-sm text-foreground outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--cc-accent)]",
        ENTER,
        docked
          ? "max-h-[max(60vh,16rem)] rounded-[14px] bg-cc-raised shadow-[var(--cc-shadow-composer)] [--card-bg:var(--cc-raised)]"
          : "my-3 max-h-[60vh] max-w-[480px] rounded-xl bg-cc-card ring-1 ring-cc-wash-2 [--card-bg:var(--cc-surface)]"
      )}
    >
      <span id={hintId} className="sr-only">
        {n > 1
          ? `Claude is asking ${n} questions. First question: ${request.questions[0].question}`
          : `Claude is asking: ${q.question}`}{" "}
        Choose an option to respond. 1 to {Math.min(9, q.options.length)}: pick.
        Up and Down: move. {n > 1 ? "Left and Right: switch question. " : ""}
        Control+Enter: submit. Escape: skip.
      </span>
      <header className="flex min-w-0 shrink-0 items-start gap-2 ps-4 pe-3 pb-1.5">
        <p className="min-w-0 flex-1 py-0.5 leading-5">{q.question}</p>
        {n > 1 && (
          <PagerNav
            noun="question"
            pager={{
              index: tab,
              total: n,
              onPrev: tab > 0 ? () => setTab(tab - 1) : undefined,
              onNext: last ? undefined : () => setTab(tab + 1),
            }}
          />
        )}
        {canAnswer && (
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss: Claude goes on with its best judgement"
            onClick={() => skipQuestion(request)}
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-lg text-cc-fg2 hover:bg-cc-ghost hover:text-foreground",
              FOCUS
            )}
          >
            <X size={16} />
          </button>
        )}
      </header>
      {/* options with previews: list (40 %) beside the preview from 30rem, the preview below when narrower */}
      <div
        className={cn(
          "flex min-h-0 flex-col",
          preview && "gap-1.5 px-1.5 pb-1.5 @min-[30rem]:flex-row"
        )}
      >
        <FadeScroll
          ref={listRef}
          role={q.multiSelect ? "group" : "radiogroup"}
          aria-label={q.question}
          className={cn(
            "max-h-[min(45vh,420px)] min-h-0",
            preview && "@min-[30rem]:w-2/5 @min-[30rem]:shrink-0"
          )}
          inner={cn(
            "flex flex-col [&>:hover+*]:before:opacity-0",
            !preview && "p-1.5"
          )}
        >
          {q.options.map((o, i) => {
            const on = a.picked.includes(o.label)
            return (
              <button
                key={o.label}
                type="button"
                data-opt
                role={role}
                aria-checked={on}
                disabled={!canAnswer}
                onClick={() => pick(o.label)}
                onPointerEnter={preview ? () => setShown(i) : undefined}
                onFocus={preview ? () => setShown(i) : undefined}
                className={cn(
                  ROW,
                  i > 0 && SEP,
                  "group/opt outline-none focus-visible:bg-cc-wash focus-visible:shadow-[inset_0_0_0_1px_var(--cc-accent)] disabled:opacity-40"
                )}
              >
                <span
                  className={cn(
                    TILE,
                    on
                      ? "bg-cc-primary text-cc-on-primary"
                      : "bg-cc-wash text-cc-fg3 group-hover/opt:bg-cc-wash-2 group-hover/opt:text-foreground"
                  )}
                >
                  {on ? <Check size={14} strokeWidth={2.5} /> : i + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      "truncate",
                      on
                        ? "text-foreground"
                        : "text-cc-fg2 group-hover/opt:text-foreground"
                    )}
                  >
                    {o.label}
                  </span>
                  {o.description && (
                    <span className="text-[13px] leading-[17px] whitespace-pre-wrap text-cc-fg3">
                      {o.description}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
          <div className={cn(ROW, SEP, "focus-within:bg-cc-wash")}>
            <button
              type="button"
              role={role}
              aria-checked={a.otherOn}
              aria-label="Other"
              disabled={!canAnswer}
              onClick={() =>
                a.otherOn
                  ? patch({ otherOn: false })
                  : otherRef.current?.focus()
              }
              className={cn(
                TILE,
                "outline-none focus-visible:ring-1 focus-visible:ring-cc-accent",
                a.otherOn
                  ? "bg-cc-primary text-cc-on-primary"
                  : "bg-cc-wash text-cc-fg3"
              )}
            >
              {a.otherOn ? (
                <Check size={14} strokeWidth={2.5} />
              ) : (
                q.options.length + 1
              )}
            </button>
            <input
              ref={otherRef}
              data-opt
              value={a.other}
              disabled={!canAnswer}
              placeholder="Something else"
              aria-label="Other answer"
              onFocus={() =>
                patch({ otherOn: true, picked: q.multiSelect ? a.picked : [] })
              }
              onChange={(e) => patch({ other: e.target.value, otherOn: true })}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  if (e.ctrlKey || e.metaKey) submit()
                  else advance(answers)
                } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault()
                  focusRow(e.key === "ArrowDown" ? 1 : -1)
                } else if (e.key === "Escape") ref.current?.focus()
              }}
              className="h-7 min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-cc-placeholder"
            />
          </div>
        </FadeScroll>
        {preview && (
          <pre
            key={`${tab}:${shown}`}
            className="max-h-[min(16rem,35vh)] min-w-0 animate-in overflow-auto rounded-xl bg-cc-wash p-3 font-mono text-xs whitespace-pre-wrap text-cc-fg2 duration-200 ease-[cubic-bezier(0.165,0.84,0.44,1)] fade-in-0 slide-in-from-right-2 motion-reduce:animate-none @min-[30rem]:max-h-none @min-[30rem]:min-h-40 @min-[30rem]:flex-1 [:root[data-reduce-motion]_&]:animate-none"
          >
            {q.options[shown]?.preview ?? ""}
          </pre>
        )}
      </div>
      <div className="flex min-h-12 shrink-0 items-center gap-3 border-t-[0.5px] border-cc-wash-2 py-1.5 ps-5 pe-4 text-xs text-cc-fg3">
        <span className="me-auto flex min-w-0 items-center gap-3">
          {pager && pager.total > 1 && (
            <PagerNav pager={pager} noun="request" />
          )}
          {!canAnswer
            ? "Answer in your terminal"
            : q.multiSelect && `${count} selected`}
        </span>
        <OptionButton
          variant="secondary"
          className="h-6 px-2"
          disabled={!canAnswer}
          onClick={() => skipQuestion(request)}
          title="Claude goes on with its best judgement"
        >
          Skip
        </OptionButton>
        {last ? (
          <OptionButton
            variant="primary"
            disabled={!anyAnswered || !canAnswer}
            onClick={() => submit()}
            keys={docked ? [MOD, "⏎"] : undefined}
            title={
              anyAnswered
                ? "Submit"
                : a.otherOn
                  ? "Type an answer to send"
                  : "Select an option to send"
            }
          >
            Submit
          </OptionButton>
        ) : (
          <OptionButton
            variant="primary"
            disabled={!canAnswer}
            onClick={() => setTab(tab + 1)}
          >
            Next
          </OptionButton>
        )}
      </div>
    </section>
  )
})
