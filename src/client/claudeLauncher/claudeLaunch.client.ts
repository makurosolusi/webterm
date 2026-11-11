// Client side of POST /api/claude-launch/test (server/claudeLauncher/claudeLauncher.api.ts).
import { flushSettingsSaves } from '../useSettings'
import { openSettingsAt } from '../settings.link'

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
/** Reveals Settings › Central Agent › Claude launch profile (Central's pick; the row links to the profile list). */
export const openLaunchProfileSettings = (): void => openSettingsAt('central', 'central.profile')

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
