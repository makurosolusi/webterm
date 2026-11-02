// Klien REST untuk /api/settings/env. Token hanya di header (sessionStorage, seperti inboxTransport);
// nilai yang dikirim tak pernah masuk URL, log, atau pesan error.
import { TOKEN_HEADER } from './api'
import { ENV } from './envLabels'

const PATH = '/api/settings/env'
const TOKEN_KEY = 'webterm.token'

export type EnvSource = 'override' | 'env' | 'default'
export type EnvKind = 'flag' | 'string' | 'number' | 'enum' | 'secret'

export interface EnvEntry {
  key: string
  group: string
  kind: EnvKind
  label: string
  description: string
  default?: string
  options?: readonly string[]
  source: EnvSource
  /** Non-secret saja. */
  value?: string
  /** Secret / bootstrap saja: terisi atau tidak. */
  set?: boolean
  restartRequired: boolean
  pendingRestart: boolean
  dangerous: boolean
  editable: boolean
}
export interface EnvState { locked: boolean; entries: EnvEntry[] }
export interface EnvChange { set?: Record<string, string>; unset?: string[] }

/** Error API env: hanya status + kode + reason statis dari server. */
export class EnvApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly reason?: string) {
    super(`env settings request failed (${status} ${code})`)
    this.name = 'EnvApiError'
  }
}

function token(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return '' // sessionStorage diblokir: loopback tanpa token tetap jalan, server yang menolak sisanya.
  }
}

async function call<T>(init: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) }
  const t = token()
  if (t !== '') headers[TOKEN_HEADER] = t
  const res = await fetch(PATH, { ...init, headers })
  let body: unknown
  try { body = await res.json() } catch { body = undefined }
  if (!res.ok) {
    const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; reason?: unknown }
    throw new EnvApiError(res.status, typeof b.error === 'string' ? b.error : `http_${res.status}`,
      typeof b.reason === 'string' ? b.reason : undefined)
  }
  if (!body || typeof body !== 'object' || !Array.isArray((body as EnvState).entries)) throw new EnvApiError(502, 'bad_response')
  return body as T
}

/** State env penuh. */
export function fetchEnv(): Promise<EnvState> {
  return call<EnvState>({})
}

/** Ubah atomik; balas state baru + kunci yang butuh restart. */
export function putEnv(change: EnvChange): Promise<EnvState & { restartRequired: string[] }> {
  return call({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) })
}

/** Pesan ringkas untuk UI; tidak pernah memuat URL, body, atau nilai yang diketik. */
export function envErrorMessage(error: unknown): string {
  if (error instanceof EnvApiError) {
    if (error.code === 'invalid_value') return error.reason ? `${ENV.errInvalid}: ${error.reason}.` : `${ENV.errInvalid}.`
    if (error.code === 'token_required') return ENV.errTokenRequired
    if (error.code === 'locked') return ENV.errLocked
    if (error.status === 413) return ENV.errTooLarge
    if (error.status === 401 || error.status === 403) return ENV.errAuth
    if (error.code === 'store_failed') return ENV.errStore
    if (error.status === 400) return ENV.errRejected
    return ENV.errGeneric
  }
  if (error instanceof TypeError) return ENV.errNetwork
  return ENV.errGeneric
}
