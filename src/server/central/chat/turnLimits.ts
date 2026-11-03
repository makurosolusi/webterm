// Per-turn resource caps for central chat (RND/28 B3). Pure: env in, limits out.
import type { TurnLimits } from '../runtime/centralRuntime'

export const TURN_STEPS_FLAG = 'WEBTERM_CENTRAL_TURN_STEPS'
export const TURN_WALL_MS_FLAG = 'WEBTERM_CENTRAL_TURN_WALL_MS'
export const TURN_TOKENS_FLAG = 'WEBTERM_CENTRAL_TURN_TOKENS'

export const DEFAULT_TURN_STEPS = 12
export const DEFAULT_TURN_WALL_MS = 120_000
export const DEFAULT_TURN_TOKENS = 60_000

/** `TurnLimits` plus the token cap; adapters ignore `maxTokens` until one enforces it. */
export interface CentralTurnLimits extends TurnLimits {
  maxTokens: number
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const text = (raw ?? '').trim()
  if (!/^\d+$/.test(text)) return fallback
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** Steps/wall/token caps from env; unset, blank, zero or malformed values keep the defaults. */
export function resolveLimits(env: NodeJS.ProcessEnv = process.env): CentralTurnLimits {
  return {
    maxTurns: positiveInt(env[TURN_STEPS_FLAG], DEFAULT_TURN_STEPS),
    maxWallMs: positiveInt(env[TURN_WALL_MS_FLAG], DEFAULT_TURN_WALL_MS),
    maxTokens: positiveInt(env[TURN_TOKENS_FLAG], DEFAULT_TURN_TOKENS),
  }
}
