// Readiness of the central runtime for `GET /api/central/health` and the claude preflight wiring
// (PLAN CENTRAL-RUNTIME-b 1.4). The probe is lazy (first turn or first health call), never at boot.
import type { RuntimeKind } from './central/runtime/centralRuntime'
import {
  type ClaudeReady, type ClaudeRuntimeOptions, type ClaudeUnavailableCode, claudeChildEnv,
} from './central/runtime/claudeOptions'
import { createClaudePreflight } from './central/runtime/claudePreflight'
import { createLogger } from './logs'

const log = createLogger('central')

export interface RuntimeReadiness {
  runtimeReady: boolean
  runtimeIssue?: ClaudeUnavailableCode
}

type Preflight = () => Promise<ClaudeReady>

/** Wraps a preflight so the first not-ready result is logged once (code only, no CLI output). */
export function onceWarn(preflight: Preflight): Preflight {
  let warned = false
  return async () => {
    const ready = await preflight()
    if (!ready.ok && !warned) {
      warned = true
      log.warn('central.runtime_unready', 'central claude runtime is not ready', { code: ready.code })
    }
    return ready
  }
}

let shared: Preflight | null = null

/** Process-wide preflight (30 s cache inside); tests inject their own via `claudeOptions.preflight`. */
export function claudePreflightOf(options?: ClaudeRuntimeOptions): Preflight {
  if (options?.preflight) return options.preflight
  shared ??= onceWarn(createClaudePreflight({ env: claudeChildEnv(process.env) }))
  return shared
}

/** `off` is never ready; `mock`/`opencode` need no probe; `claude` runs the (cached) preflight. */
export async function runtimeReadiness(kind: RuntimeKind, preflight: Preflight): Promise<RuntimeReadiness> {
  if (kind === 'off') return { runtimeReady: false }
  if (kind !== 'claude') return { runtimeReady: true }
  try {
    const ready = await preflight()
    return ready.ok ? { runtimeReady: true } : { runtimeReady: false, runtimeIssue: ready.code }
  } catch {
    // The probe itself threw: report "cannot check" rather than failing the health endpoint.
    return { runtimeReady: false, runtimeIssue: 'claude_check_failed' }
  }
}
