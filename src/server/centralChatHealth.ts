// Readiness of the central runtime for `GET /api/central/health` and the claude preflight wiring
// (PLAN CENTRAL-RUNTIME-b 1.4). The probe is lazy (first turn or first health call), never at boot.
import type { RuntimeKind } from './central/runtime/centralRuntime'
import {
  type ClaudeReady, type ClaudeRuntimeOptions, type ClaudeUnavailableCode, claudeChildEnv,
} from './central/runtime/claudeOptions'
import { createClaudePreflight, preflightLogFields } from './central/runtime/claudePreflight'
import { createLogger } from './logs'

const log = createLogger('central')

export interface RuntimeReadiness {
  runtimeReady: boolean
  runtimeIssue?: ClaudeUnavailableCode
}

type Preflight = () => Promise<ClaudeReady>

/** Wraps a preflight so a not-ready result is logged with its stage, profile and timing (the probe's
 *  redacted message, no raw CLI output), once per distinct cause so health polling does not repeat it. */
export function onceWarn(preflight: Preflight): Preflight {
  let last = ''
  return async () => {
    const ready = await preflight()
    if (ready.ok) { last = ''; return ready }
    const fields = preflightLogFields(ready)
    const key = JSON.stringify([fields['code'], fields['stage'], fields['failed'], fields['profileId'], fields['timedOut']])
    if (key !== last) {
      last = key
      log.warn('central.runtime_unready', 'central claude runtime is not ready', fields)
    }
    return ready
  }
}

let shared: Preflight | null = null
const current = (): Preflight => (shared ??= onceWarn(createClaudePreflight({ env: claudeChildEnv(process.env) })))
/** Stable handle the long-lived Central runtime holds: it always reaches the current shared probe, so a
 *  fresh check (Settings test, profile edit) is what the next turn sees too. */
const sharedPreflight: Preflight = () => current()()

/** Process-wide preflight (successes cached 30 s inside); tests inject their own via `claudeOptions.preflight`. */
export function claudePreflightOf(options?: ClaudeRuntimeOptions): Preflight {
  return options?.preflight ?? sharedPreflight
}

/**
 * Explicit re-check (Check again after logging in): drop the cached claude probe so the next call runs a new one,
 * for the health view and for Central's next turn alike; normal polling never calls this.
 */
export function freshClaudePreflight(): Preflight {
  shared = null
  return sharedPreflight
}

/** `off` is never ready; `mock` (explicit only) needs no probe; `claude` runs its (cached) preflight. */
export async function runtimeReadiness(kind: RuntimeKind, preflight: Preflight): Promise<RuntimeReadiness> {
  if (kind === 'off') return { runtimeReady: false }
  if (kind === 'mock') return { runtimeReady: true }
  try {
    const ready = await preflight()
    return ready.ok ? { runtimeReady: true } : { runtimeReady: false, runtimeIssue: ready.code }
  } catch {
    // The probe itself threw: report "cannot check" rather than failing the health endpoint.
    return { runtimeReady: false, runtimeIssue: 'claude_check_failed' }
  }
}
