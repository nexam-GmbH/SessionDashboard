import type { Session } from "@/lib/model"
import { fuzzyScore } from "@/features/palette/commands"

/**
 * Session search (UI_PLAN §5.2, §5.9). Whitespace-separated tokens must all match.
 * A token matches as a substring of the title (best), of the repo / branch / first
 * prompt, or as a subsequence of the title only. Subsequence matching over the long
 * prompt text is what made "auth" match nearly every session before.
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
    if (h.rest.includes(tok)) {
      score += 30
      continue
    }
    const f = tok.length > 1 ? fuzzyScore(tok, h.title) : 0
    if (!f) return 0
    score += Math.min(25, f)
  }
  if (q.tokens.length > 1 && h.title.includes(q.lower)) score += 200
  return score
}

/** ISO-8601 timestamps sort lexicographically; plain comparison is ~20x faster than localeCompare. */
export function cmpIso(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Attention order (UI_PLAN §2.3) without localeCompare (lib/status.compareAttention uses it). */
export function compareAttentionFast(a: Session, b: Session, tier: Record<string, number>) {
  return tier[a.status] - tier[b.status] || cmpIso(b.statusObservedAt, a.statusObservedAt)
}
