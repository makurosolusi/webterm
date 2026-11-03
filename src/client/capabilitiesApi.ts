// Klien REST tipis untuk /api/capabilities (kontrak ENVSIMPLE-b §1). Token hanya di header.
import type { CapabilitiesResponse, CapabilityId } from '../shared/featureCapabilities'
import { TOKEN_HEADER } from './api'
import { peekToken } from './transportToken'

const PATH = '/api/capabilities'
const HTTP_BAD_GATEWAY = 502

/** Galat API kemampuan: hanya status + kode statis; body mentah tidak pernah ikut. */
export class CapabilitiesApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`capabilities request failed (${status} ${code})`)
    this.name = 'CapabilitiesApiError'
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Bentuk minimum respons yang dibaca klien. */
export function isCapabilitiesResponse(body: unknown): body is CapabilitiesResponse {
  return isObj(body) && Array.isArray(body.capabilities) && isObj(body.advanced) &&
    body.capabilities.every((c) => isObj(c) && typeof c.id === 'string' && typeof c.status === 'string')
}

/** Satu panggilan JSON ke rute kemampuan (untuk ES-11); non-2xx -> CapabilitiesApiError berkode. */
export async function callCapabilities<T = CapabilitiesResponse>(
  suffix: string, method = 'GET', body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const t = peekToken()
  if (t !== '') headers[TOKEN_HEADER] = t
  const res = await fetch(PATH + suffix, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let parsed: unknown
  try { parsed = await res.json() } catch { parsed = undefined } // body bukan JSON: cukup status
  if (!res.ok) {
    const code = isObj(parsed) && typeof parsed.error === 'string' ? parsed.error : `http_${res.status}`
    throw new CapabilitiesApiError(res.status, code)
  }
  return parsed as T
}

async function state(suffix: string, method?: string, body?: unknown): Promise<CapabilitiesResponse> {
  const out = await callCapabilities<unknown>(suffix, method, body)
  if (!isCapabilitiesResponse(out)) throw new CapabilitiesApiError(HTTP_BAD_GATEWAY, 'bad_response')
  return out
}

/** Semua kemampuan + bagian Lanjutan. */
export const fetchCapabilities = (): Promise<CapabilitiesResponse> => state('')

/** Nyalakan/matikan satu kemampuan (server menutup prasyarat dan dependen). */
export const setCapability = (id: CapabilityId, enabled: boolean): Promise<CapabilitiesResponse> =>
  state(`/${id}`, 'POST', { enabled })

/** Nyalakan/matikan satu sub-opsi kemampuan induk. */
export const setCapabilitySub = (id: CapabilityId, key: string, on: boolean): Promise<CapabilitiesResponse> =>
  state(`/${id}/sub`, 'POST', { key, on })
