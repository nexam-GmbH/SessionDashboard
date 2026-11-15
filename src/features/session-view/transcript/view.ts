// The chat transcript's level of detail, as in Claude Code desktop (session title menu → Transcript
// view, or Ctrl+O to cycle): Normal folds tool calls into summaries, Thinking adds Claude's
// thinking, Verbose opens every tool call and step.
import { getApp, setApp } from "@/store/app"
import type { TranscriptView } from "./rowModel"

export const TRANSCRIPT_VIEWS: { id: TranscriptView; label: string; hint: string }[] = [
  { id: "normal", label: "Normal", hint: "Tool calls collapsed into summaries, with full text responses" },
  { id: "thinking", label: "Thinking", hint: "Normal, plus Claude's thinking" },
  { id: "verbose", label: "Verbose", hint: "Every tool call, file read and intermediate step, plus Claude's thinking" },
]

export function setTranscriptView(view: TranscriptView) {
  setApp((s) => ({ settings: { ...s.settings, transcriptView: view } }))
}

/** Ctrl+O: Normal → Thinking → Verbose → Normal. */
export function cycleTranscriptView() {
  const cur = getApp().settings.transcriptView ?? "normal"
  const i = TRANSCRIPT_VIEWS.findIndex((v) => v.id === cur)
  setTranscriptView(TRANSCRIPT_VIEWS[(i + 1) % TRANSCRIPT_VIEWS.length].id)
}
