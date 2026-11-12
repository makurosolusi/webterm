// Session rotation thresholds (RND/29b open question 2: 70% rotate, 85% hard stop; to be measured).

/** Share of the window at which the next turn starts a fresh session seeded from a checkpoint. */
export const ROTATE_RATIO = 0.7
/** Share of the window at which a turn is refused instead of silently truncated. */
export const REJECT_RATIO = 0.85
/** Window of every current Claude model unless its id asks for the long one. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000
/** Window of a long-context model id (Claude Code's `[1m]` suffix, e.g. `sonnet[1m]`). */
export const LONG_CONTEXT_WINDOW_TOKENS = 1_000_000
/** Env override of the window, in tokens (kept for power users; Settings no longer shows it). */
export const CONTEXT_WINDOW_ENV = 'WEBTERM_CENTRAL_CONTEXT_WINDOW'

/** The window a model id has: 1M only for an id that names the long-context variant, else 200K. */
export const contextWindowForModel = (model: string | undefined): number =>
  /\[1m\]\s*$/i.test(model ?? '') ? LONG_CONTEXT_WINDOW_TOKENS : DEFAULT_CONTEXT_WINDOW_TOKENS

import { CENTRAL_MODEL_FLAG } from '../runtime/runtimeShared'

export type RotationDecision = 'ok' | 'rotate' | 'reject'

/** Window size: a valid env override wins, else the window of Central's model (`WEBTERM_CENTRAL_MODEL`). */
export function contextWindowTokens(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env[CONTEXT_WINDOW_ENV])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : contextWindowForModel(env[CENTRAL_MODEL_FLAG])
}

/** Maps the last measured context size to ok / rotate / reject; unknown size is always ok. */
export function decideRotation(ctxTokens: number | null, windowTokens: number): RotationDecision {
  if (ctxTokens === null || windowTokens <= 0) return 'ok'
  const ratio = ctxTokens / windowTokens
  if (ratio >= REJECT_RATIO) return 'reject'
  return ratio >= ROTATE_RATIO ? 'rotate' : 'ok'
}
