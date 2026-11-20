import type { ID } from "@/lib/model"
import { REAL } from "./mode"
import { ensureRealTranscript } from "./real"

// The mock world's transcripts come from mocks/transcript, a chunk of its own that mocks/boot
// loads before the first render; the desktop app reads real transcripts and never parses it.
let ensureMock: ((sessionId: ID) => void) | null = null

export function setMockTranscripts(ensure: (sessionId: ID) => void) {
  ensureMock = ensure
}

/** Load a session's transcript if it isn't loaded yet. */
export function ensureTranscript(sessionId: ID) {
  if (REAL) return ensureRealTranscript(sessionId)
  ensureMock?.(sessionId)
}
