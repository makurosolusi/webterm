// Readiness of the central runtime for `GET /api/central/health` and the claude preflight wiring
// (PLAN CENTRAL-RUNTIME-b 1.4). The probe is lazy (first turn or first health call), never at boot.
import type { RuntimeKind } from './central/runtime/centralRuntime'
import {
  type ClaudeReady, type ClaudeRuntimeOptions, type ClaudeUnavailableCode, claudeChildEnv,
} from './central/runtime/claudeOptions'
import { createClaudePreflight } from './central/runtime/claudePreflight'
import { type OpencodeIssue, type OpencodeReady, sharedOpencodePreflight } from './central/runtime/opencodeAuth'
import { opencodeBin, opencodeModel } from './central/runtime/opencodeOptions'
import { defaultOpencodeHomeDir } from './central/runtime/opencodeSession'
import { createLogger } from './logs'

const log = createLogger('central')

export interface RuntimeReadiness {
  runtimeReady: boolean
  runtimeIssue?: ClaudeUnavailableCode | OpencodeIssue
  /** Human-readable cause, set for opencode not-ready (model/credential/binary). */
  runtimeHint?: string
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

/** The same cached probe the opencode runtime runs before a turn (model/bin read per call: hot env). */
export function defaultOpencodePreflight(): Promise<OpencodeReady> {
  return sharedOpencodePreflight({
    executable: opencodeBin(), model: opencodeModel(), homeDir: defaultOpencodeHomeDir(), env: process.env,
  })()
}

/** `off` is never ready; `mock` needs no probe; `claude` and `opencode` run their (cached) preflight. */
export async function runtimeReadiness(
  kind: RuntimeKind, preflight: Preflight, opencodePreflight: () => Promise<OpencodeReady> = defaultOpencodePreflight
): Promise<RuntimeReadiness> {
  if (kind === 'off') return { runtimeReady: false }
  if (kind === 'opencode') {
    const ready = await opencodePreflight()
    return ready.ok ? { runtimeReady: true } : { runtimeReady: false, runtimeIssue: ready.code, runtimeHint: ready.reason }
  }
  if (kind !== 'claude') return { runtimeReady: true }
  try {
    const ready = await preflight()
    return ready.ok ? { runtimeReady: true } : { runtimeReady: false, runtimeIssue: ready.code }
  } catch {
    // The probe itself threw: report "cannot check" rather than failing the health endpoint.
    return { runtimeReady: false, runtimeIssue: 'claude_check_failed' }
  }
}
