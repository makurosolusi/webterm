// Rute `/api/browser/*` (PLAN b §4.5): status, lease, agent-control, cookie. Konvensi `workspacesApi.ts`:
// `{status, body?}`, `null` = bukan milikku. Otorisasi TIDAK di sini: index.ts menggerbangi seluruh `/api/*`
// (Origin + token root) dan node-token tidak punya jalur ke prefix ini (default-deny). Dipasang di api.ts
// oleh WS-11 dengan `cappedBodyGetter(req, method, BROWSER_BODY_MAX_BYTES)`.
import type { BrowserStatusResp, Lease } from '../shared/browser.contract'
import { isSafeNodeId } from '../shared/workspace'
import { isSafeWorkspaceId } from './browser/profile.paths'
import { cookieRoute, fail, readObject } from './browserApi.cookies'
import { profileRoute } from './browserApi.profiles'
import type { ProfileApiDeps } from './browserApi.profiles'
import { isBrowserProfileId } from '../shared/browser.profile'
import type { ProfileResult } from './browser/browser.profiles.service'
import type { BrowserApiResult, CookieApiDeps } from './browserApi.cookies'

export { BROWSER_BODY_MAX_BYTES } from './browserApi.cookies'
export type { BrowserApiResult, CookieInjector } from './browserApi.cookies'

const PREFIX = '/api/browser/'

export interface BrowserApiDeps extends Omit<CookieApiDeps, 'cookieImportEnabled'> {
  /** Ringkasan runtime; `enabled=false` (flag induk off) menjadikan semua rute selain status 404 `disabled`. */
  status(): BrowserStatusResp
  lease: { holder(nodeId: string): Lease; takeover(nodeId: string): void; release(nodeId: string): void }
  /** Simpan toggle `agentControl` node di sisi server (dasar `agentAllowed` handler kontrol). */
  setAgentControl(nodeId: string, enabled: boolean): void
  /** Profile registry + operations (`/api/browser/profiles/*`). */
  profiles: Pick<ProfileApiDeps, 'profiles' | 'ops'>
  /** Move a browser node to another profile (its page reopens on the last URL in that profile's process). */
  setNodeProfile(nodeId: string, profileId: string): Promise<ProfileResult<{ profileId: string }>>
}

/** Segmen path -> nilai terdekode, atau `null` bila bukan UTF-8 percent-encoding sah. */
function decodeSegments(path: string): string[] | null {
  try {
    return path.split('/').map(decodeURIComponent)
  } catch (err) {
    if (err instanceof URIError) return null
    throw err
  }
}

async function agentControl(nodeId: string, body: () => Promise<string>, d: BrowserApiDeps): Promise<BrowserApiResult> {
  const read = await readObject(body)
  if (!read.ok) return read.result
  const { enabled } = read.value
  if (typeof enabled !== 'boolean') return fail(400, 'bad_request')
  if (enabled && !d.status().agentEnabled) return fail(404, 'disabled')
  d.setAgentControl(nodeId, enabled)
  if (!enabled) d.lease.release(nodeId) // agent dimatikan: kendali kembali ke manusia
  return { status: 204 }
}

async function takeLease(nodeId: string, body: () => Promise<string>, d: BrowserApiDeps): Promise<BrowserApiResult> {
  const read = await readObject(body)
  if (!read.ok) return read.result
  if (read.value.holder !== 'human') return fail(400, 'bad_request') // agent mengambil lease lewat verb `handoff`, bukan REST
  d.lease.takeover(nodeId)
  return { status: 200, body: { lease: d.lease.holder(nodeId) } }
}

async function nodeProfile(nodeId: string, body: () => Promise<string>, d: BrowserApiDeps): Promise<BrowserApiResult> {
  const read = await readObject(body)
  if (!read.ok) return read.result
  if (!isBrowserProfileId(read.value.profileId)) return fail(400, 'bad_request')
  const r = await d.setNodeProfile(nodeId, read.value.profileId)
  return r.ok ? { status: 200, body: r.value } : fail(r.code === 'profile_not_found' ? 404 : 400, r.code)
}

/**
 * Rute satu request browser. `body` = getter malas (hanya dibaca POST/DELETE). Mengembalikan `null`
 * bila `pathname` di luar `/api/browser/`.
 */
export async function handleBrowserApi(
  method: string, pathname: string, body: () => Promise<string>, d: BrowserApiDeps, search: URLSearchParams = new URLSearchParams()
): Promise<BrowserApiResult | null> {
  if (!pathname.startsWith(PREFIX)) return null
  const segs = decodeSegments(pathname.slice(PREFIX.length))
  if (!segs) return fail(400, 'bad_request')
  const [id, kind, ...rest] = segs

  // Status selalu menjawab (klien memakai `enabled` untuk menyembunyikan fitur); sisanya mati bila flag off.
  if (id === 'status' && kind === undefined) return method === 'GET' ? { status: 200, body: d.status() } : fail(405, 'method_not_allowed')
  if (!d.status().enabled) return fail(404, 'disabled')

  if (id === 'profiles') {
    const cookies: CookieApiDeps = { ...d, cookieImportEnabled: () => d.status().cookieImportEnabled }
    return (await profileRoute(method, [kind, ...rest].filter((x): x is string => x !== undefined), search, body, { ...d.profiles, cookies })) ?? fail(404, 'not_found')
  }
  if (kind === 'profile' && !rest.length && method === 'POST') {
    return isSafeNodeId(id) ? nodeProfile(id, body, d) : fail(400, 'bad_request')
  }
  if (kind === 'agent-control' && !rest.length && method === 'POST') {
    return isSafeNodeId(id) ? agentControl(id, body, d) : fail(400, 'bad_request')
  }
  if (kind === 'lease' && !rest.length && method === 'POST') {
    return isSafeNodeId(id) ? takeLease(id, body, d) : fail(400, 'bad_request')
  }
  if (kind === 'cookies') {
    if (!isSafeWorkspaceId(id)) return fail(400, 'bad_request')
    const cookieDeps: CookieApiDeps = { ...d, cookieImportEnabled: () => d.status().cookieImportEnabled }
    return (await cookieRoute(method, id, rest, body, cookieDeps)) ?? fail(404, 'not_found')
  }
  return fail(404, 'not_found')
}
