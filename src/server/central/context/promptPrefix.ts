/**
 * Cache-friendly prompt prefix for Central (PLAN F5-d, PLAN/rnd/03 §3; Anthropic prompt caching: the cache
 * covers tools -> system -> messages in that order, so one changed byte early invalidates the rest).
 *
 * Central runs `claude -p --resume`: Claude Code places the cache_control breakpoints itself (max 4,
 * 20-block lookback), so what webterm controls is the content and order of what it injects. The stable
 * part is the static steward system prompt plus the stable project context (the checkpoint); retrieved
 * memory, the state header and the human text are the volatile tail. Nothing with a clock or a per-turn
 * id belongs in the prefix. Each distinct prefix is recorded in the v1 `prefix` table (hash, hits), so a
 * prefix that changes every turn shows up as many rows with hits 0.
 */
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { allRows, execWrite, getRow } from '../../ledger/ledgerCore'
import { CENTRAL_STEWARD_PROMPT } from '../runtime/claudeOptions'

const CHARS_PER_TOKEN = 4
const MINUTE_MS = 60_000
/** Human messages within `ACTIVE_WINDOW_MS` that make a session "long/active". */
export const ACTIVE_HUMAN_TURNS = 3
export const ACTIVE_WINDOW_MS = 60 * MINUTE_MS

/** The stable prefix text: static system first, then stable project context. */
export function centralPrefixText(stableContext: string): string {
  return [CENTRAL_STEWARD_PROMPT, stableContext].filter((p) => p !== '').join('\n\n')
}

export const prefixHash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Upserts the prefix row; `reused` = this exact prefix was already recorded (a cache hit candidate). */
export function recordPrefix(db: Database, input: { projectId: string | null; text: string; now: number }): { hash: string; reused: boolean } {
  const hash = prefixHash(input.text)
  const known = getRow(db, 'SELECT 1 AS x FROM prefix WHERE hash = ?', hash) !== null
  if (known) {
    execWrite(db, 'UPDATE prefix SET hits = hits + 1, last_used_at = ? WHERE hash = ?', input.now, hash)
    return { hash, reused: true }
  }
  // FK to project(id): a conversation scope that is not (yet) a ledger project records a global prefix.
  const project = input.projectId !== null && getRow(db, 'SELECT 1 AS x FROM project WHERE id = ?', input.projectId) !== null ? input.projectId : null
  execWrite(db, 'INSERT INTO prefix (id, project_id, hash, text, tokens, hits, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    `pfx_${hash.slice(0, 24)}`, project, hash, input.text, Math.ceil(input.text.length / CHARS_PER_TOKEN), input.now, input.now)
  return { hash, reused: false }
}

export interface PrefixStats {
  /** Distinct prefixes used since `since`. */
  prefixes: number
  /** Builds that reused an already recorded prefix. */
  hits: number
  /** hits / all builds (hits + first uses); null with no builds. Low = the prefix churns. */
  reuseRate: number | null
}

/**
 * Reuse of the prefixes last used since `since`, for the Cost panel.
 * ponytail: `hits` is a lifetime counter per row, not windowed; add a per-day table if the window matters.
 */
export function prefixStats(db: Database, since: number): PrefixStats {
  const r = getRow(db, 'SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS h FROM prefix WHERE COALESCE(last_used_at, created_at) >= ?', since)
  const prefixes = Number(r?.['n'] ?? 0)
  const hits = Number(r?.['h'] ?? 0)
  return { prefixes, hits, reuseRate: prefixes + hits > 0 ? hits / (prefixes + hits) : null }
}

/**
 * Conditional 1h prompt-cache TTL (code.claude.com/docs/en/env-vars, `ENABLE_PROMPT_CACHING_1H`, checked
 * 2026-11-05). A 1h write costs 2x base input vs 1.25x for 5 min, so it only pays when the next turn is
 * likely to land 5-60 min later: a long Telegram or otherwise active session, here at least
 * ACTIVE_HUMAN_TURNS human messages in the last hour. Otherwise nothing is set and Claude Code keeps its
 * default (5 min on API keys; subscriptions already get 1h on the main conversation).
 */
export function centralCacheEnv(db: Database, conversationId: string, now: number): Record<string, string> {
  const n = Number(allRows(db, "SELECT COUNT(*) AS n FROM central_message WHERE conversation_id = ? AND role = 'human' AND created_at >= ?",
    conversationId, now - ACTIVE_WINDOW_MS)[0]?.['n'] ?? 0)
  return n >= ACTIVE_HUMAN_TURNS ? { ENABLE_PROMPT_CACHING_1H: '1' } : {}
}
