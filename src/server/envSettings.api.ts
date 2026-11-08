// Rute `/api/settings/env`. Terpisah dari `settings` biasa: respons di sini membawa metadata
// sumber/secret dan tak pernah memuat nilai secret (hanya `set`). Gerbang auth /api tetap di
// index.ts; mutasi (PUT/POST) tambahan lewat `settingsGuard` (featureCapabilities.guard) dan dicatat ke audit.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readCappedRequestBody, SETTINGS_BODY_MAX_BYTES } from './cappedRequestBody'
import { parseChange } from './envSettings.control'
import { importDotenv } from './envSettings.import'
import type { EnvSettings } from './envSettings.service'
import type { AuditEntry } from './featureCapabilities.audit'
import { peerOf, type GuardResult } from './featureCapabilities.guard'
import { createLogger } from './logs'

const log = createLogger('settings')

export const ENV_SETTINGS_PATH = '/api/settings/env'
export const IMPORT_ENDPOINT = '/api/settings/env/import'
// Settings › Developer route (read model, writes, Doctor) lives in envSettings.control.ts; re-exported for its mount.
export { CONTROL_EFFECTIVE_PATH, controlEffectiveRoute } from './envSettings.control'

export interface EnvSettingsApiDeps {
  service: EnvSettings
  /** Penjaga mutasi; jalur nyata = `settingsGuard`. */
  guard(req: IncomingMessage): GuardResult
  /** Catat keputusan (tanpa nilai); opsional di tes. */
  audit?(entry: AuditEntry): void
}

/** Request yang lolos penjaga setara pemilik: kunci `dangerous` tidak lagi digerbangi per kunci. */
const OWNER_CTX = { root: true }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Tulis audit; gagal tulis hanya di-warn (audit tak boleh menjatuhkan mutasi yang sudah sah). */
function audit(deps: EnvSettingsApiDeps, req: IncomingMessage, entry: Pick<AuditEntry, 'action' | 'via' | 'detail'>): void {
  try {
    deps.audit?.({ capability: 'advanced', peer: peerOf(req), ...entry })
  } catch (err) {
    log.warn('audit.write_failed', 'Cannot write settings audit row', { cause: err instanceof Error ? err.name : 'error' })
  }
}

/** Jalankan penjaga; bila ditolak balas 403 `forbidden` generik + audit `denied`, dan kembalikan via bila lolos. */
function guarded(req: IncomingMessage, res: ServerResponse, deps: EnvSettingsApiDeps): 'ui' | 'token' | undefined {
  const verdict = deps.guard(req)
  if (verdict.ok) return verdict.via
  audit(deps, req, { action: 'denied', via: 'rejected', detail: verdict.reason })
  json(res, 403, { error: 'forbidden' })
  return undefined
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
  if (method === 'GET') return json(res, 200, deps.service.state(OWNER_CTX))
  if (method !== 'PUT') return json(res, 405, { error: 'method_not_allowed' })
  const via = guarded(req, res, deps)
  if (!via) return
  const body = await readJson(req, res)
  if (!body.ok) return
  const change = parseChange(body.value)
  if (!change) return json(res, 400, { error: 'invalid_body' })
  const result = deps.service.update(change, OWNER_CTX)
  if (!result.ok) return json(res, result.status, { error: result.error, key: result.key, reason: result.reason })
  audit(deps, req, { action: 'advanced', via, detail: [...Object.keys(change.set), ...change.unset].join(',') })
  json(res, 200, { ...result.state, restartRequired: result.restartRequired })
}

/** `POST` impor `.env` (default dry-run; `{ apply: true }` menulis). Body hanya `apply`; path tak pernah dari klien. */
export async function envImportRoute(req: IncomingMessage, res: ServerResponse, method: string, deps: EnvSettingsApiDeps): Promise<void> {
  if (method !== 'POST') return json(res, 405, { error: 'method_not_allowed' })
  const via = guarded(req, res, deps)
  if (!via) return
  const body = await readJson(req, res, {})
  if (!body.ok) return
  const v = body.value
  if (!isRecord(v) || (v.apply !== undefined && typeof v.apply !== 'boolean')) return json(res, 400, { error: 'invalid_body' })
  const out = importDotenv({ service: deps.service }, v.apply === true)
  if (v.apply === true && out.status === 200 && 'items' in out.body) {
    const keys = out.body.items.filter((i) => i.action === 'add').map((i) => i.key)
    if (keys.length > 0) audit(deps, req, { action: 'advanced', via, detail: keys.join(',') })
  }
  json(res, out.status, out.body)
}
