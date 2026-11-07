// Context-size bookkeeping (RND/23 F5): context size is the LAST step_finish of a turn,
// not the sum over steps (every step repeats the history, so a sum is the bill, not the window).
import type { Database } from 'bun:sqlite'
import type { RuntimeUsage } from '../runtime/centralRuntime'

/** Prompt-side tokens of one step: fresh input plus cache reads and writes. */
export function ctxTokensOf(usage: Pick<RuntimeUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Keeps the context size of the most recent usage event (overwrite, never add). */
export interface CtxTracker {
  observe(usage: Pick<RuntimeUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): void
  /** Null until a usage event was observed. */
  value(): number | null
}

/** Creates a tracker for one turn. */
export function createCtxTracker(): CtxTracker {
  let last: number | null = null
  return { observe: (usage) => { last = ctxTokensOf(usage) }, value: () => last }
}

/** Writes `ctx_tokens` on a turn row (column added by migration v8). */
export function recordCtxTokens(db: Database, turnId: string, tokens: number): void {
  db.query('UPDATE central_turn SET ctx_tokens = ? WHERE id = ?').run(Math.max(0, Math.floor(tokens)), turnId)
}

/** Context size of the newest succeeded turn that recorded one; null if none yet. */
export function lastCtxTokens(db: Database, conversationId: string): number | null {
  const row = db.query(
    `SELECT ctx_tokens FROM central_turn
     WHERE conversation_id = ? AND status = 'succeeded' AND ctx_tokens IS NOT NULL
     ORDER BY started_at DESC, id DESC LIMIT 1`
  ).get(conversationId) as { ctx_tokens: number } | null
  return row === null ? null : Number(row.ctx_tokens)
}
