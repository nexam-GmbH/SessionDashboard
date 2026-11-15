// Adapted from agent-of-empires/agent-of-empires@d134cfd:web/src/components/acp/AskUserQuestionCard.tsx (MIT). Modified for session-dashboard.
// Also adapted from cline/cline@72b3d71:sdk/packages/ui/components/agent-ask-question.tsx (Apache-2.0): letter keys, options.
// Changes: AskUserQuestion shape: one tab per question header, 2–4
// options with descriptions and optional preview, multi-select, "Other…" free text;
// answers go to answerQuestion. Calm chrome: the question is the title, tabs
// sit in the title line, one line per option, key hints in tooltips.
import { memo, useEffect, useRef, useState } from "react"
import { Check, ChevronLeft, ChevronRight } from "lucide-react"
import type { QuestionRequest } from "@/lib/model"
import { answerRequest, skipQuestion } from "@/features/session-view/sessionStore"
import { MOD } from "@/components/common/bits"
import { cn } from "@/lib/utils"
import { CardFrame, canStealFocus, FOCUS, OptionButton, type Pager } from "./cardChrome"

type Answer = { picked: string[]; other: string; otherOn: boolean }
const EMPTY: Answer = { picked: [], other: "", otherOn: false }

function answerValue(a: Answer, multi: boolean): string | string[] | undefined {
  const vals = [...a.picked, ...(a.otherOn && a.other.trim() ? [a.other.trim()] : [])]
  if (!vals.length) return undefined
  return multi ? vals : vals[0]
}

export const QuestionCard = memo(function QuestionCard({
  request,
  canAnswer,
  pager,
  autoFocus,
}: {
  request: QuestionRequest
  canAnswer: boolean
  pager?: Pager
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  const [tab, setTab] = useState(0)
  const [answers, setAnswers] = useState<Answer[]>(() => request.questions.map(() => EMPTY))
  useEffect(() => {
    if (autoFocus && canStealFocus()) ref.current?.focus({ preventScroll: true })
  }, [autoFocus, request.id])

  const q = request.questions[tab]
  const a = answers[tab] ?? EMPTY
  const answered = answers.map((x, i) => answerValue(x, request.questions[i].multiSelect) !== undefined)
  const allAnswered = answered.every(Boolean)
  const last = tab === request.questions.length - 1

  const patch = (i: number, p: Partial<Answer>) => setAnswers((prev) => prev.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const pick = (label: string) => {
    if (!canAnswer) return
    if (q.multiSelect) {
      patch(tab, { picked: a.picked.includes(label) ? a.picked.filter((x) => x !== label) : [...a.picked, label] })
    } else {
      patch(tab, { picked: [label], otherOn: false })
      if (!last) setTimeout(() => setTab((t) => Math.min(t + 1, request.questions.length - 1)), 120)
    }
  }
  const submit = () => {
    if (!allAnswered || !canAnswer) return
    const out: Record<string, string | string[]> = {}
    request.questions.forEach((qq, i) => {
      const v = answerValue(answers[i], qq.multiSelect)
      if (v !== undefined) out[qq.question] = v
    })
    answerRequest(request, out)
  }

  // Ctrl+Enter submits from anywhere in the session (Claude Code desktop), unless you are typing
  useEffect(() => {
    if (!canAnswer) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.isComposing) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT") && !ref.current?.contains(t) && (t as HTMLTextAreaElement).value.trim()) return
      if (!allAnswered) return
      e.preventDefault()
      e.stopPropagation()
      submit()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  })

  // several questions: "‹ 2 of 3 ›" beside the question, as Claude Code desktop pages them
  const tabs =
    request.questions.length > 1 ? (
      <span className="flex h-6 shrink-0 items-center gap-0.5 text-xs font-normal text-muted-foreground" aria-label={`Question ${tab + 1} of ${request.questions.length}`}>
        <button type="button" aria-label="Previous question" disabled={tab === 0} onClick={() => setTab(tab - 1)} className={cn("inline-flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:opacity-40", FOCUS)}>
          <ChevronLeft size={14} />
        </button>
        <span className="tabular flex items-center gap-1">
          {answered[tab] && <Check size={11} aria-label="answered" />}
          {tab + 1} of {request.questions.length}
        </span>
        <button type="button" aria-label="Next question" disabled={last} onClick={() => setTab(tab + 1)} className={cn("inline-flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:opacity-40", FOCUS)}>
          <ChevronRight size={14} />
        </button>
      </span>
    ) : undefined

  return (
    <CardFrame
      ref={ref}
      tone="input"
      label="Question from Claude"
      keyHint={`1 to ${Math.min(9, q.options.length)} or A to ${String.fromCharCode(64 + Math.min(26, q.options.length))}: pick an answer. Enter: ${request.questions.length > 1 ? "next question or submit" : "submit"}.${request.questions.length > 1 ? " Left and Right arrows: switch question." : ""}`}
      title={<span className="min-w-0">{q.question}</span>}
      aside={tabs}
      pager={pager}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        const idx = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : /^[a-z]$/i.test(e.key) && !e.metaKey && !e.ctrlKey ? e.key.toLowerCase().charCodeAt(0) - 97 : -1
        if (idx >= 0 && q.options[idx]) {
          e.preventDefault()
          pick(q.options[idx].label)
        } else if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) {
          if (tab < request.questions.length - 1) {
            e.preventDefault()
            setTab(tab + 1)
          }
        } else if (e.key === "ArrowLeft") {
          e.preventDefault()
          setTab(Math.max(0, tab - 1))
        } else if (e.key === "Enter") {
          e.preventDefault()
          if (last || allAnswered) submit()
          else setTab(tab + 1)
        }
      }}
      footerNote={!canAnswer ? "Answer in your terminal" : request.questions[0]?.header && request.questions.length === 1 ? request.questions[0].header : undefined}
      footer={
        <>
          <OptionButton variant="quiet" disabled={!canAnswer} onClick={() => skipQuestion(request)} title="Skip: Claude goes on with its best judgement">
            Skip
          </OptionButton>
          {!last && (
            <OptionButton variant="secondary" onClick={() => setTab(tab + 1)}>
              Next
            </OptionButton>
          )}
          <OptionButton variant="primary" disabled={!allAnswered || !canAnswer} onClick={submit} keys={[MOD, "↵"]} title="Submit">
            Submit
          </OptionButton>
        </>
      }
    >
      <div role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question} className="-mx-1 flex flex-col">
        {q.options.map((o, i) => {
          const on = a.picked.includes(o.label)
          return (
            <button
              key={o.label}
              type="button"
              role={q.multiSelect ? "checkbox" : "radio"}
              aria-checked={on}
              disabled={!canAnswer}
              onClick={() => pick(o.label)}
              title={`${o.description ? `${o.description} · ` : ""}${i + 1} or ${String.fromCharCode(65 + i)}`}
              className={cn(
                "flex min-w-0 flex-col rounded-md px-1.5 py-1.5 text-left disabled:opacity-60",
                FOCUS,
                on ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Mark on={on} multi={q.multiSelect} />
                <span className="shrink-0 text-sm leading-5 font-medium text-foreground">{o.label}</span>
                {o.description && <span className="min-w-0 truncate text-sm text-muted-foreground/80">{o.description}</span>}
              </span>
              {o.preview && on && (
                <pre className="mt-1 ml-[22px] max-h-32 overflow-auto rounded-sm border border-border bg-background p-1.5 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{o.preview}</pre>
              )}
            </button>
          )
        })}
        <div className={cn("flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5", a.otherOn ? "bg-accent" : "hover:bg-accent/60")}>
          <button
            type="button"
            role={q.multiSelect ? "checkbox" : "radio"}
            aria-checked={a.otherOn}
            aria-label="Other"
            disabled={!canAnswer}
            onClick={() => patch(tab, { otherOn: !a.otherOn, picked: q.multiSelect ? a.picked : [] })}
            className={cn("inline-flex rounded-sm", FOCUS)}
          >
            <Mark on={a.otherOn} multi={q.multiSelect} />
          </button>
          <input
            value={a.other}
            disabled={!canAnswer}
            placeholder="Other…"
            aria-label="Other answer"
            onFocus={() => patch(tab, { otherOn: true, picked: q.multiSelect ? a.picked : [] })}
            onChange={(e) => patch(tab, { other: e.target.value, otherOn: true })}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter") {
                e.preventDefault()
                if (last || allAnswered) submit()
                else setTab(tab + 1)
              }
            }}
            className="h-5 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          />
        </div>
      </div>
    </CardFrame>
  )
})

function Mark({ on, multi }: { on: boolean; multi: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center border",
        multi ? "rounded-sm" : "rounded-full",
        on ? "border-foreground bg-foreground text-background" : "border-input",
      )}
    >
      {on && (multi ? <Check size={10} strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-white" />)}
    </span>
  )
}
