// Command mode: the provider card only picks a Claude launch profile (the one store of launch
// commands, claudeLauncher). The user's command (e.g. `envman -e claude:x -- claude`) injects its own
// credential, so webterm never reads, stores or sets one here.
import { DEFAULT_CLAUDE_PROFILE, listClaudeProfiles } from '../claudeLauncher/claudeLauncher'
import type { ProviderConfig, ProviderView } from './claudeProvider.model'

// Credential shapes typed into a command line. Settings are not a secret store, so the card warns
// (the value itself is never returned).
const SECRET_SHAPES: readonly RegExp[] = [
  /sk-ant-/i,
  /(?:^|[\s'"-])[A-Za-z0-9_-]*(?:API_KEY|AUTH_TOKEN|TOKEN|KEY)=[^\s'"]/i, // NAME=value
  /:\/\/[^\s/@:]+:[^\s/@]+@/, // https://user:pass@host
]

/** True when `command` looks like it carries a secret. */
export const commandSecretWarning = (command: string): boolean => SECRET_SHAPES.some((re) => re.test(command))

/** Whether command-mode config `c` points at a launch profile that still exists. */
export const commandProfileExists = (c: ProviderConfig): boolean =>
  c.mode === 'command' && !!c.profileId && listClaudeProfiles().some((p) => p.id === c.profileId)

/** Extra view fields for command mode: the resolved profile or `profileMissing`, plus the secret warning. */
export function commandViewExtras(c: ProviderConfig): Partial<ProviderView> {
  if (c.mode !== 'command') return {}
  const profile = listClaudeProfiles().find((p) => p.id === c.profileId)
  if (!profile) return { profileMissing: true }
  return {
    profile: { id: profile.id, name: profile.name, command: profile.command },
    ...(commandSecretWarning(profile.command) ? { commandWarning: 'looks_like_secret' as const } : {}),
  }
}

/**
 * The stored `defaultClaudeProfileId` after the provider changes from `prev` to `next`, or null = leave it.
 * Command mode's profile IS the default for new agents (one concept): saving it writes it; leaving command
 * mode puts a default that still points at the old command profile back to Default. Also the boot migration
 * (`prev` = login): idempotent, it writes nothing once the two agree.
 */
export function defaultProfileAfter(prev: Pick<ProviderConfig, 'mode' | 'profileId'>, next: Pick<ProviderConfig, 'mode' | 'profileId'>, storedDefault: string): string | null {
  if (next.mode === 'command' && next.profileId) return next.profileId === storedDefault ? null : next.profileId
  if (prev.mode === 'command' && prev.profileId === storedDefault && storedDefault !== DEFAULT_CLAUDE_PROFILE.id) return DEFAULT_CLAUDE_PROFILE.id
  return null
}
