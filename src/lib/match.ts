/**
 * Word-start chunk matching shared by session search and the palette. The query splits into
 * pieces that each begin a word of the text, in order ("frd" → Fix invoice Rounding … Decimal,
 * "ratlim" → RATe LIMiter). A plain subsequence let "oidc" match "andrOID baCk" and "frd" match
 * "PerFormance haRness"; this keeps abbreviations without the random hits.
 * Both arguments must already be lowercased. Returns 0 for no match, else 8–25 (fewer chunks = higher).
 */
export function chunkScore(tok: string, text: string, ti = 0, from = 0, chunks = 0): number {
  for (let p = from; p < text.length; p++) {
    if (text[p] !== tok[ti] || !isWordStart(text, p)) continue
    let k = 0
    while (ti + k < tok.length && text[p + k] === tok[ti + k]) k++
    for (let len = k; len >= 1; len--) {
      if (ti + len === tok.length) return Math.max(8, 25 - chunks * 4)
      const r = chunkScore(tok, text, ti + len, p + len, chunks + 1)
      if (r) return r
    }
  }
  return 0
}

/** Position `i` starts a word (start of text, or after a non-alphanumeric character). */
export function isWordStart(text: string, i: number) {
  if (i === 0) return true
  const c = text.charCodeAt(i - 1)
  return !((c >= 48 && c <= 57) || (c >= 97 && c <= 122))
}

/**
 * Score `query` against `text`: every whitespace-separated token must match as a substring
 * (word-start substrings rank higher) or as word-start chunks. 0 = no match.
 */
export function matchScore(query: string, text: string) {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const t = text.toLowerCase()
  let score = 0
  for (const tok of q.split(/\s+/)) {
    const i = t.indexOf(tok)
    if (i >= 0) {
      score += 100 + (isWordStart(t, i) ? 40 : 0) - Math.min(20, i * 0.2)
      continue
    }
    const c = tok.length > 1 ? chunkScore(tok, t) : 0
    if (!c) return 0
    score += c
  }
  return score
}
