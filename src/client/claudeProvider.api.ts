// Client side of /api/claude-provider (server: claudeProvider/claudeProvider.api.ts) plus the one settings
// write the "Custom command" mode needs: the command lives in a Claude launch profile (single source of truth).
import { TOKEN_HEADER } from './api'
import { peekToken } from './transportToken'
import { settingsUrl } from './useSettings'
import { randomId } from './randomId'
import { CLAUDE_PROFILE_LIMITS, normalizeClaudeProfiles, type ClaudeLaunchProfile } from '../shared/claudeLaunch/claudeLaunch.profiles'

export type Mode = 'login' | 'apiKey' | 'custom' | 'command'
export type Credential = 'apiKey' | 'authToken'
export interface ProviderView {
  mode: Mode; baseUrl?: string; credential?: Credential; model?: string; secretSet: boolean; ready: boolean
  profileId?: string; profile?: { id: string; name: string; command: string }; profileMissing?: boolean
  commandWarning?: 'looks_like_secret'
  /** The stored config file is damaged; Claude starts with the login until it is reset or saved again. */
  configError?: 'unreadable'
}
export interface TestResult { ok: boolean; message: string; at: number; outcome?: string }
export interface State { provider: ProviderView; lastTest: TestResult | null; restartNeeded: number }
export interface DetectedWrapper { name: string; installed: boolean; version?: string }

export const PROVIDER_PATH = '/api/claude-provider'
export const RESET_PATH = `${PROVIDER_PATH}/reset`

/** JSON call to the provider API; throws the server's error code (or http_<status>), never the body. */
export async function providerCall(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const t = peekToken()
  if (t !== '') headers[TOKEN_HEADER] = t
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  let data: unknown
  try { data = await res.json() } catch { data = undefined } // non-JSON: the status is enough
  const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  if (!res.ok) throw new Error(typeof obj.error === 'string' ? obj.error : `http_${res.status}`)
  return obj
}

/** Wrappers found on the server's PATH; an old server without the route simply has none. */
export async function detectWrappers(): Promise<DetectedWrapper[]> {
  const r = await providerCall(`${PROVIDER_PATH}/detect`, 'GET')
  return Array.isArray(r.wrappers) ? (r.wrappers as DetectedWrapper[]) : []
}

async function settingsCall(method: 'GET' | 'PUT', body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(settingsUrl(), {
    method, cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`http_${res.status}`)
  const data: unknown = await res.json().catch(() => ({}))
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
}

/** Saved launch profiles (the built-in Default is not stored, so it is not listed). */
export async function loadLaunchProfiles(): Promise<ClaudeLaunchProfile[]> {
  return normalizeClaudeProfiles((await settingsCall('GET')).claudeLaunchProfiles)
}

/**
 * Create the profile (`id` unknown) or update it in place, on top of a FRESH read so edits made elsewhere
 * are not overwritten. Awaited, unlike the coalesced settings save, because the provider PUT that follows
 * resolves the profile on the server. Returns the id and the whole list for the caller to sync.
 */
export async function upsertLaunchProfile(draft: { id: string | null; name: string; command: string }): Promise<{ id: string; profiles: ClaudeLaunchProfile[] }> {
  const list = await loadLaunchProfiles()
  const name = draft.name.trim().slice(0, CLAUDE_PROFILE_LIMITS.name)
  const command = draft.command.trim()
  const old = list.find((p) => p.id === draft.id)
  const id = old ? old.id : randomId()
  if (old && old.name === name && old.command === command) return { id, profiles: list }
  const profiles = old ? list.map((p) => (p.id === id ? { id, name, command } : p)) : [...list, { id, name, command }]
  await settingsCall('PUT', { claudeLaunchProfiles: profiles })
  return { id, profiles }
}
