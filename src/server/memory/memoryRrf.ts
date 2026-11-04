/**
 * Pure ranking for hybrid memory retrieval (RND/24 3.4): reciprocal-rank fusion over several
 * candidate lists, then a weighted score mixing recency, kind importance, scope and staleness.
 * No SQL here so the weights are testable on their own.
 */
import type { MemoryAnyScope, MemoryKind } from './memoryModel'

/** Standard RRF damping constant. */
export const RRF_K = 60

/** Weights of RND/12 4.2 / RND/24 3.4; they sum to 1.0 before the stale penalty. */
export const SCORE_WEIGHTS = { rrf: 0.55, recency: 0.2, importance: 0.15, scope: 0.1, stale: 0.2 } as const

const DAY_MS = 86_400_000

/** Recency half-life in days per kind; Infinity = never decays (preferences and decisions). */
const HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  preference: Infinity, decision: Infinity, procedure: 90, fact: 90, episode: 90, summary: 14, claim: 90,
}

/** Importance comes from the kind, never from an LLM-assigned number. */
const IMPORTANCE: Record<MemoryKind, number> = {
  decision: 1, preference: 1, procedure: 0.7, fact: 0.6, episode: 0.3, summary: 0.2, claim: 0.3,
}

const SCOPE_BOOST: Record<MemoryAnyScope, number> = {
  project: 1, core: 1, user: 0.9, global: 0.7, central: 0.5, scratch: 0.3,
}

/** Sums 1/(k+rank) per id over every ranking (rank is 1-based list position). */
export function rrfFuse(rankings: ReadonlyArray<readonly string[]>, k = RRF_K): Map<string, number> {
  const fused = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, index) => fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1)))
  }
  return fused
}

/**
 * Freshness in 0..1: 1 right after the last verification, halving every kind half-life (F5-a
 * re-verification). Preferences and decisions never decay. Below `REVIEW_FRESHNESS` a fact is
 * surfaced for review in the memory panel.
 */
export function freshnessScore(kind: MemoryKind, since: number, now: number): number {
  const halfLife = HALF_LIFE_DAYS[kind] ?? 90
  return Number.isFinite(halfLife) ? 0.5 ** (Math.max(0, now - since) / DAY_MS / halfLife) : 1
}

/** One half-life without re-verification. */
export const REVIEW_FRESHNESS = 0.5

export interface RankInput {
  /** Raw fused RRF score of the candidate. */
  rrf: number
  /** Number of candidate lists that took part, used to normalise `rrf` into 0..1. */
  lists: number
  /** Latest of last verification and last update: recency decays from here. */
  updatedAt: number
  now: number
  kind: MemoryKind
  scope: MemoryAnyScope
  stale: boolean
}

/** Final score in roughly 0..1; higher is better. */
export function rankScore(input: RankInput): number {
  const best = Math.max(1, input.lists) / (RRF_K + 1)
  const recency = freshnessScore(input.kind, input.updatedAt, input.now)
  return (
    SCORE_WEIGHTS.rrf * (input.rrf / best) +
    SCORE_WEIGHTS.recency * recency +
    SCORE_WEIGHTS.importance * IMPORTANCE[input.kind] +
    SCORE_WEIGHTS.scope * SCOPE_BOOST[input.scope] -
    (input.stale ? SCORE_WEIGHTS.stale : 0)
  )
}
