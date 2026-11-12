// Per-turn resource caps for central chat (RND/28 B3). Pure: env in, limits out.
import type { TurnLimits } from '../runtime/centralRuntime'
import { CENTRAL_MODEL_FLAG } from '../runtime/runtimeShared'

export const TURN_STEPS_FLAG = 'WEBTERM_CENTRAL_TURN_STEPS'
export const TURN_WALL_MS_FLAG = 'WEBTERM_CENTRAL_TURN_WALL_MS'

export const DEFAULT_TURN_STEPS = 12
export const DEFAULT_TURN_WALL_MS = 120_000

function positiveInt(raw: string | undefined, fallback: number): number {
  const text = (raw ?? '').trim()
  if (!/^\d+$/.test(text)) return fallback
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** Bigger models think longer per step: their replies get more steps and time. Unlisted (haiku, sonnet, auto) = 1. */
const TIER_SCALE: readonly (readonly [family: string, scale: number])[] = [['fable', 2], ['opus', 1.5]]

/** Scale of the defaults for Central's model id or alias. */
export const limitScale = (model: string | undefined): number =>
  TIER_SCALE.find(([family]) => (model ?? '').toLowerCase().includes(family))?.[1] ?? 1

/** Steps/wall caps: valid env values win; unset, blank, zero or malformed ones get the defaults scaled to Central's model. */
export function resolveLimits(env: NodeJS.ProcessEnv = process.env): TurnLimits {
  const scale = limitScale(env[CENTRAL_MODEL_FLAG])
  return {
    maxTurns: positiveInt(env[TURN_STEPS_FLAG], Math.round(DEFAULT_TURN_STEPS * scale)),
    maxWallMs: positiveInt(env[TURN_WALL_MS_FLAG], Math.round(DEFAULT_TURN_WALL_MS * scale)),
  }
}
