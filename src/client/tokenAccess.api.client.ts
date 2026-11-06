// Klien REST tipis untuk /api/settings/token (server: tokenAccess.api.ts). Token transport hanya di header;
// nilai token baru hanya dikembalikan ke pemanggil, tidak pernah ditulis ke log atau pesan galat.
import { TOKEN_TEXT } from './tokenAccessLabels'
import { TOKEN_PARAM } from './transportToken'

const PATH = '/api/settings/token'

export type TokenSource = 'none' | 'env' | 'file'
export interface TokenStatus { enforced: boolean; source: TokenSource; canEnable: boolean }

/** Galat rute token: status + kode statis saja, body mentah tidak ikut. */
export class TokenAccessError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`token access request failed (${status} ${code})`)
    this.name = 'TokenAccessError'
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

async function call(suffix: string, method: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const res = await fetch(PATH + suffix, { method, headers, cache: 'no-store' })
  let body: unknown
  try { body = await res.json() } catch { body = undefined } // body bukan JSON: cukup status
  if (!res.ok) throw new TokenAccessError(res.status, isObj(body) && typeof body.error === 'string' ? body.error : `http_${res.status}`)
  if (!isObj(body)) throw new TokenAccessError(res.status, 'bad_response')
  return body
}

/** Status token tanpa nilai. */
export async function fetchTokenStatus(): Promise<TokenStatus> {
  const b = await call('', 'GET')
  if (typeof b.enforced !== 'boolean' || typeof b.canEnable !== 'boolean' || !['none', 'env', 'file'].includes(b.source as string)) {
    throw new TokenAccessError(200, 'bad_response')
  }
  return { enforced: b.enforced, source: b.source as TokenSource, canEnable: b.canEnable }
}

async function mint(suffix: string): Promise<string> {
  const b = await call(suffix, 'POST')
  if (typeof b.token !== 'string' || b.token === '') throw new TokenAccessError(200, 'bad_response')
  return b.token
}

/** Nyalakan token (loopback, belum aktif); nilai token keluar sekali. */
export const enableToken = (): Promise<string> => mint('/enable')
/** Ganti token berbasis berkas; nilai token keluar sekali. */
export const rotateToken = (): Promise<string> => mint('/rotate')

/** One-time sign-in link; transportToken.exchangeLandingToken trades its `?token=` for the session cookie. */
export const tokenLink = (origin: string, token: string): string => `${origin}/?${TOKEN_PARAM}=${encodeURIComponent(token)}`

/** Kode galat -> kalimat jujur untuk pengguna. */
export function tokenErrorText(err: unknown): string {
  if (!(err instanceof TokenAccessError)) return TOKEN_TEXT.failed
  switch (err.code) {
    case 'agent_cannot_approve': return TOKEN_TEXT.agentCannot
    case 'approval_browser_only': return TOKEN_TEXT.browserOnly
    case 'loopback_only': return TOKEN_TEXT.loopbackOnly
    case 'already_enabled': case 'env_managed': case 'not_enabled': return TOKEN_TEXT.changed
    default: return TOKEN_TEXT.failed
  }
}
