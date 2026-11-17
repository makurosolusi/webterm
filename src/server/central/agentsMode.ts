// Owner decision 2026-11-17 (docs/decisions/central-autonomy-default.md): with `WEBTERM_CENTRAL_AGENTS` unset, Central may
// start workers and act on its own ('auto'). Only an explicit owner value narrows it: 'propose' = approval cards, 'off' = no workers.
export type AgentsMode = 'off' | 'propose' | 'auto'
export const AGENTS_ENV = 'WEBTERM_CENTRAL_AGENTS'

/** Effective worker mode of `env`: unset or empty = 'auto'; an unknown value fails closed to 'off'. */
export function agentsModeOf(env: Record<string, string | undefined>): AgentsMode {
  const mode = (env[AGENTS_ENV] ?? '').trim().toLowerCase()
  if (mode === '') return 'auto'
  return mode === 'propose' || mode === 'auto' ? mode : 'off'
}
