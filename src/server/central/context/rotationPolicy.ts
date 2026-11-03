// Session rotation thresholds (RND/29b open question 2: 70% rotate, 85% hard stop; to be measured).

/** Share of the window at which the next turn starts a fresh session seeded from a checkpoint. */
export const ROTATE_RATIO = 0.7
/** Share of the window at which a turn is refused instead of silently truncated. */
export const REJECT_RATIO = 0.85
/** Conservative window for models whose real window is unknown (RND/23 §4.2). */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
/** Env override of the window, in tokens. */
export const CONTEXT_WINDOW_ENV = 'WEBTERM_CENTRAL_CONTEXT_WINDOW'

export type RotationDecision = 'ok' | 'rotate' | 'reject'

/** Window size from env; invalid or non-positive values fall back to the default. */
export function contextWindowTokens(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env[CONTEXT_WINDOW_ENV])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CONTEXT_WINDOW_TOKENS
}

/** Maps the last measured context size to ok / rotate / reject; unknown size is always ok. */
export function decideRotation(ctxTokens: number | null, windowTokens: number): RotationDecision {
  if (ctxTokens === null || windowTokens <= 0) return 'ok'
  const ratio = ctxTokens / windowTokens
  if (ratio >= REJECT_RATIO) return 'reject'
  return ratio >= ROTATE_RATIO ? 'rotate' : 'ok'
}
