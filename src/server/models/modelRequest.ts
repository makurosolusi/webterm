// What `--model` to pass so webterm never overrides a model the user chose for their provider.
// Claude Code resolves the aliases through ANTHROPIC_DEFAULT_<ALIAS>_MODEL, and `--model` outranks
// ANTHROPIC_MODEL (docs: model-config), so an alias is kept when its tier var is set and dropped when
// only ANTHROPIC_MODEL (the Provider card's model) is set. ANTHROPIC_SMALL_FAST_MODEL is the deprecated
// haiku var: its value is passed by name, since the alias may no longer resolve through it.
import { claudeEnv } from '../claudeProvider/claudeProvider.store'

export type ModelEnv = Readonly<Record<string, string | undefined>>

/** `flag` = the `--model` value to pass (null = none); `requested` = the model the run actually asks for. */
export interface ModelRequest { flag: string | null; requested: string }

const ALIASES = new Set(['haiku', 'sonnet', 'opus', 'fable'])
const val = (env: ModelEnv, key: string): string | undefined => env[key]?.trim() || undefined

export function modelRequest(model: string, env: ModelEnv): ModelRequest {
  const tierVar = ALIASES.has(model) ? val(env, `ANTHROPIC_DEFAULT_${model.toUpperCase()}_MODEL`) : undefined
  if (tierVar) return { flag: model, requested: tierVar }
  const smallFast = model === 'haiku' ? val(env, 'ANTHROPIC_SMALL_FAST_MODEL') : undefined
  if (smallFast) return { flag: smallFast, requested: smallFast }
  const main = val(env, 'ANTHROPIC_MODEL')
  return main ? { flag: null, requested: main } : { flag: model, requested: model }
}

/** A Claude child's model-relevant env: `process.env` with the active provider applied. */
export const defaultModelEnv = (): ModelEnv => claudeEnv(process.env)

/** The model a ladder pick actually requests under the provider, for cost rows (null = CLI default). */
export const requestedModel = (model: string | null, env: () => ModelEnv = defaultModelEnv): string | null =>
  model ? modelRequest(model, env()).requested : null
