// The prompt cache of a session, from its newest API call: still warm (the next message re-reads the
// conversation at a tenth of the input price) or expired (the whole conversation is written to the
// cache again, at 1.25× or 2× the input price). Shown where you decide whether to send now.
import type { ID } from "@/lib/model"
import { useApp } from "@/store/app"
import { useNow } from "@/components/common/RelativeTime"
import { cacheCost } from "@/features/usage/usageData"

export interface CacheState {
  warm: boolean
  /** ms until it expires (warm) or since it expired (cold) */
  ms: number
  tokens: number
  ttl: number
  cost: { warm: number; cold: number } | null
}

export function useCache(sessionId: ID): CacheState | null {
  const last = useApp((s) => s.transcripts[sessionId]?.lastCall)
  const now = useNow()
  if (!last) return null
  const expires = Date.parse(last.at) + last.ttl * 1000
  const warm = now < expires
  return { warm, ms: Math.abs(expires - now), tokens: last.tokens, ttl: last.ttl, cost: cacheCost(last.model, last.tokens, last.ttl) }
}

export const minutes = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 1 ? "under a minute" : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`
}
