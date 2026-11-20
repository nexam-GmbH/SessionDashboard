import { setApp } from "@/store/app"
import { setMockTranscripts } from "@/backend/transcript"
import { generateWorld } from "./world"
import { ensureTranscript } from "./transcript"
import { startEngine } from "./engine"

/** The browser preview's world: main.tsx loads this chunk only in mock mode, before the first render. */
export function bootMocks() {
  setApp(generateWorld())
  setMockTranscripts(ensureTranscript)
  startEngine()
}
