// Client side of POST /api/claude-launch/test (server/claudeLauncher/claudeLauncher.api.ts).
import { flushSettingsSaves } from '../useSettings'
import { openSettingsAt } from '../settings.link'
import { CLAUDE_LAUNCH_EFFECTIVE_PATH, type EffectiveClaudeLaunch } from '../../shared/claudeLaunch/claudeLaunch.effective'

/** `install`: on a claude-missing row, the official install commands (server `CLAUDE_INSTALL`).
 *  `signIn`: on a wrapper that is not signed in, the sign-in command it suggested (server `WrapperSignIn`). */
export interface LaunchStep { stage: 'wrapper' | 'claude' | 'auth'; ok: boolean; message: string; hint?: string; install?: ClaudeInstall; signIn?: { tool: string; hint: string; command?: string } }
export interface ClaudeInstall { installCommand: string; npmCommand: string; docsUrl: string }
export interface LaunchTest {
  ok: boolean
  profile: { id: string; name: string }
  steps: LaunchStep[]
  failed?: string
  warnings: string[]
}

export { OPEN_SETTINGS_EVENT } from '../settings.link'
/** Reveals Settings › Claude › launch profiles (Central's own pick is under Advanced there). */
export const openLaunchProfileSettings = (): void => openSettingsAt('claude', 'claudeLaunchProfiles')

/** Probe a saved profile, or the one Central uses. Throws with the server's error code. */
export async function testClaudeLaunch(target: { profileId: string } | { central: true }): Promise<LaunchTest> {
  await flushSettingsSaves() // the server tests what is STORED: a profile saved a moment ago must be there
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
  const res = await fetch('/api/claude-launch/test', { method: 'POST', headers, cache: 'no-store', body: JSON.stringify(target) })
  let data: unknown
  try { data = await res.json() } catch { data = undefined } // non-JSON: the status is enough
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  if (!res.ok) throw new Error(typeof obj.error === 'string' ? obj.error : `http_${res.status}`)
  return obj as unknown as LaunchTest
}

/** GET /api/claude-launch/effective: what agents, Central and helpers really start with (server truth). */
export async function fetchEffectiveLaunch(signal?: AbortSignal): Promise<EffectiveClaudeLaunch> {
  const res = await fetch(CLAUDE_LAUNCH_EFFECTIVE_PATH, { headers: { Accept: 'application/json' }, cache: 'no-store', signal })
  const data = (await res.json().catch(() => undefined)) as Partial<EffectiveClaudeLaunch> & { error?: string } | undefined
  if (!res.ok || !data?.agents || !data.central) throw new Error(data?.error ?? `http_${res.status}`)
  return data as EffectiveClaudeLaunch
}
