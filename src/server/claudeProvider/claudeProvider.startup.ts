// THE answer to "how does Claude start and authenticate here": the saved provider (mode + readiness) and
// the launch profile it runs (wrapper + claude). Test connection, Doctor, Central's preflight and the
// launch test resolve through this one function, so they judge exactly what agents and Central run
// (claudeLauncher resolves the profiles; this adds which one the provider means).
import { centralClaudeLaunch, resolveClaudeLaunch, type ResolvedClaudeLaunch } from '../claudeLauncher/claudeLauncher'
import type { ProviderMode, ProviderView } from './claudeProvider.model'
import { providerView } from './claudeProvider.store'

/** `provider`: the provider's own launch (command mode: its profile, else Central's). `central`: what Central runs. */
export type StartupTarget = 'provider' | 'central'

export interface ClaudeStartup {
  provider: ProviderView
  launch: ResolvedClaudeLaunch
  /** How Claude gets its credential, for messages: the wrapper's name, else the mode's name. */
  method: string
}

const MODE_NAME: Record<ProviderMode, string> = { login: 'Claude Code login', apiKey: 'Anthropic API key', custom: 'custom endpoint', command: 'custom command' }

/** The wrapper's base name when the launch has one, else the provider mode's name. */
export function startupMethod(mode: string, launch: Pick<ResolvedClaudeLaunch, 'wrapper'>): string {
  const w = launch.wrapper[0]
  return w ? w.slice(w.lastIndexOf('/') + 1) : MODE_NAME[mode as ProviderMode] ?? 'Claude Code'
}

/** Resolves provider + launch. Command mode names its profile explicitly, so a deleted one reports `missingId`. */
export function claudeStartup(target: StartupTarget = 'provider'): ClaudeStartup {
  const provider = providerView()
  const launch = target === 'provider' && provider.mode === 'command' ? resolveClaudeLaunch(provider.profileId) : centralClaudeLaunch()
  return { provider, launch, method: startupMethod(provider.mode, launch) }
}
