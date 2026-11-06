// Client side of POST /api/claude-launch/test (server/claudeLauncher/claudeLauncher.api.ts).

export interface LaunchStep { stage: 'wrapper' | 'claude' | 'auth'; ok: boolean; message: string; hint?: string }
export interface LaunchTest {
  ok: boolean
  profile: { id: string; name: string }
  steps: LaunchStep[]
  failed?: string
  warnings: string[]
}

/** Event that opens Settings on a section (App listens); `detail.section` = SettingsPanel section id. */
export const OPEN_SETTINGS_EVENT = 'webterm:open-settings'
export const openLaunchProfileSettings = (): void => {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'agent' } }))
}

/** Probe a saved profile, or the one Central uses. Throws with the server's error code. */
export async function testClaudeLaunch(target: { profileId: string } | { central: true }): Promise<LaunchTest> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
  const res = await fetch('/api/claude-launch/test', { method: 'POST', headers, cache: 'no-store', body: JSON.stringify(target) })
  let data: unknown
  try { data = await res.json() } catch { data = undefined } // non-JSON: the status is enough
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  if (!res.ok) throw new Error(typeof obj.error === 'string' ? obj.error : `http_${res.status}`)
  return obj as unknown as LaunchTest
}
