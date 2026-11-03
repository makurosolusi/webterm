// Rute `/api/settings/env`. Terpisah dari `settings` biasa: respons di sini membawa metadata
// sumber/secret dan tak pernah memuat nilai secret (hanya `set`). Gerbang auth /api tetap di
// index.ts; `rootGate` menambah syarat untuk kunci `dangerous` (root token benar-benar terkonfigurasi).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readCappedRequestBody, SETTINGS_BODY_MAX_BYTES } from './cappedRequestBody'
import { importDotenv } from './envSettings.import'
import type { EnvChange, EnvSettings } from './envSettings.service'

export const ENV_SETTINGS_PATH = '/api/settings/env'
export const IMPORT_ENDPOINT = '/api/settings/env/import'

export interface EnvSettingsApiDeps {
  service: EnvSettings
  /** True bila root token terkonfigurasi (request yang sampai sini sudah lolos gerbangnya). */
  rootGate(): boolean
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Baca + parse body JSON berbatas; pada kegagalan sudah membalas (413/400) dan `ok:false`. Body kosong = `empty` bila diberikan. */
async function readJson(req: IncomingMessage, res: ServerResponse, empty?: unknown): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const read = await readCappedRequestBody(req, SETTINGS_BODY_MAX_BYTES)
  if (!read.ok) {
    const big = read.reason === 'too_large'
    json(res, big ? 413 : 400, { error: big ? 'payload_too_large' : 'body_read_failed' })
    return { ok: false }
  }
  if (empty !== undefined && read.body.trim() === '') return { ok: true, value: empty }
  try { return { ok: true, value: JSON.parse(read.body) } } catch { json(res, 400, { error: 'bad_json' }); return { ok: false } }
}

/** Bentuk body `{ set?: {KEY: string}, unset?: KEY[] }`, atau null bila salah bentuk. */
function parseChange(body: unknown): EnvChange | null {
  if (!isRecord(body)) return null
  const { set = {}, unset = [] } = body
  if (!isRecord(set) || !Array.isArray(unset) || !unset.every((k) => typeof k === 'string')) return null
  return { set, unset: unset as string[] }
}

/**
 * `GET` = state penuh. `PUT` = ubah atomik (semua valid atau tidak ada yang berubah), balas state
 * baru + `restartRequired`. Pesan error statis dan hanya menyebut NAMA kunci, tak pernah nilai.
 */
export async function envSettingsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  deps: EnvSettingsApiDeps
): Promise<void> {
  const ctx = { root: deps.rootGate() }
  if (method === 'GET') return json(res, 200, deps.service.state(ctx))
  if (method !== 'PUT') return json(res, 405, { error: 'method_not_allowed' })
  const body = await readJson(req, res)
  if (!body.ok) return
  const change = parseChange(body.value)
  if (!change) return json(res, 400, { error: 'invalid_body' })
  const result = deps.service.update(change, ctx)
  if (!result.ok) return json(res, result.status, { error: result.error, key: result.key, reason: result.reason })
  json(res, 200, { ...result.state, restartRequired: result.restartRequired })
}

/** `POST` impor `.env` (default dry-run; `{ apply: true }` menulis). Body hanya `apply`; path tak pernah dari klien. */
export async function envImportRoute(req: IncomingMessage, res: ServerResponse, method: string, deps: EnvSettingsApiDeps): Promise<void> {
  if (method !== 'POST') return json(res, 405, { error: 'method_not_allowed' })
  const body = await readJson(req, res, {})
  if (!body.ok) return
  const v = body.value
  if (!isRecord(v) || (v.apply !== undefined && typeof v.apply !== 'boolean')) return json(res, 400, { error: 'invalid_body' })
  const out = importDotenv(deps, v.apply === true)
  json(res, out.status, out.body)
}
