import type { Session } from "@/lib/model"
import { chunkScore, isWordStart } from "@/lib/match"

/**
 * Session search. Whitespace-separated tokens must all match.
 * A token matches as a substring of the title (best), at a word start in the repo /
 * branch / first prompt, or as word-start chunks of the title only (see chunkScore). Subsequence matching over
 * the long prompt text made "auth" match nearly every session; plain substrings there made
 * "rate" match every prompt that says "migrate" or "generate".
 * Haystacks are lowercased once per session object (records are replaced on update).
 */
const hayCache = new WeakMap<Session, { title: string; rest: string }>()

function hay(s: Session, extra: string) {
  let h = hayCache.get(s)
  if (!h) {
    h = { title: s.title.toLowerCase(), rest: `${extra} ${s.handle} ${s.cwd} ${s.firstPrompt}`.toLowerCase() }
    hayCache.set(s, h)
  }
  return h
}

/** `tok` occurs in `text` at the start of a word (after a non-alphanumeric character). */
function hasWordStart(text: string, tok: string) {
  let i = text.indexOf(tok)
  while (i >= 0) {
    // after a non-letter, in any script (Cyrillic, CJK…), not only ASCII
    if (isWordStart(text, i)) return true
    i = text.indexOf(tok, i + 1)
  }
  return false
}

export function prepareQuery(q: string) {
  const lower = q.trim().toLowerCase()
  return { lower, tokens: lower.split(/\s+/).filter(Boolean) }
}

/** 0 = no match; higher is better. `extra` = repo name (stable per session). */
export function scoreSession(q: ReturnType<typeof prepareQuery>, s: Session, extra: string): number {
  if (!q.tokens.length) return 1
  const h = hay(s, extra)
  let score = 0
  for (const tok of q.tokens) {
    const ti = h.title.indexOf(tok)
    if (ti >= 0) {
      score += 100 + (ti === 0 || h.title[ti - 1] === " " ? 40 : 0)
      continue
    }
    if (hasWordStart(h.rest, tok)) {
      score += 30
      continue
    }
    const f = tok.length > 1 ? chunkScore(tok, h.title) : 0
    if (!f) return 0
    score += f
  }
  if (q.tokens.length > 1 && h.title.includes(q.lower)) score += 200
  return score
}

/** ISO-8601 timestamps sort lexicographically; plain comparison is ~20x faster than localeCompare. */
export function cmpIso(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Attention order without localeCompare (lib/status.compareAttention uses it). */
export function compareAttentionFast(a: Session, b: Session, tier: Record<string, number>) {
  return tier[a.status] - tier[b.status] || cmpIso(b.statusObservedAt, a.statusObservedAt)
}
