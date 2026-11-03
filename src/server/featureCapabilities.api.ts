// Rute `/api/capabilities*` (ES-09). GET lewat gerbang /api biasa; semua mutasi lewat `settingsGuard`
// (urutan: guard -> id -> body), dicatat ke audit, dan respons tak pernah memuat secret atau nama env var.
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CAPABILITY_IDS, type CapabilityId } from '../shared/featureCapabilities'
import { readCappedRequestBody, SETTINGS_BODY_MAX_BYTES } from './cappedRequestBody'
import { dataDir } from './config'
import { createFileSecretStore } from './envSecrets.store'
import type { EnvSettingsApiDeps } from './envSettings.api'
import { peerOf } from './featureCapabilities.guard'
import { buildResponse, connect, defaultDetect, reset, setAdvanced, setSub, toggle, type CapCtx, type Detect, type Reply } from './featureCapabilities.service'
import { createLogger } from './logs'

const log = createLogger('capabilities')
export const CAPABILITIES_PATH = '/api/capabilities'
const SECRETS_SUBDIR = 'secrets'
/** Metode yang diizinkan per rute tetap; rute `/:id` dan `/:id/sub` hanya POST. */
const FIXED_METHODS: Record<string, string> = { '/': 'GET', 'advanced/': 'GET|PUT', 'reset/': 'POST', 'telegram/connect': 'POST' }

/** Seam produksi yang bisa diganti tes. */
export interface CapabilityExtras { env: NodeJS.ProcessEnv; detect: () => Detect; dataDir: string; secrets: CapCtx['secrets']; fetch: CapCtx['fetch'] }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isCapabilityId = (v: string): v is CapabilityId => (CAPABILITY_IDS as readonly string[]).includes(v)

function send(res: ServerResponse, reply: Reply): true {
  res.statusCode = reply.status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(reply.body))
  return true
}
const fail = (res: ServerResponse, status: number, error: string): true => send(res, { status, body: { error } })

/** Body JSON berbatas; kosong = `{}`. Gagal baca/parse sudah dibalas dan mengembalikan undefined. */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const read = await readCappedRequestBody(req, SETTINGS_BODY_MAX_BYTES)
  if (!read.ok) return void fail(res, read.reason === 'too_large' ? 413 : 400, read.reason === 'too_large' ? 'payload_too_large' : 'body_read_failed')
  try { return read.body.trim() === '' ? {} : JSON.parse(read.body) } catch { return void fail(res, 400, 'bad_json') }
}

/** Tangani `/api/capabilities*`; false bila path bukan milik rute ini. */
export async function capabilitiesRoute(
  req: IncomingMessage, res: ServerResponse, method: string, path: string,
  envDeps: () => EnvSettingsApiDeps, extras: Partial<CapabilityExtras> = {},
): Promise<boolean> {
  if (path !== CAPABILITIES_PATH && !path.startsWith(`${CAPABILITIES_PATH}/`)) return false
  const [seg = '', sub = ''] = path.slice(CAPABILITIES_PATH.length + 1).split('/')
  const fixed = FIXED_METHODS[`${seg}/${sub}`]
  const allowed = fixed ?? (sub === '' || sub === 'sub' ? 'POST' : undefined)
  if (!allowed) return fail(res, 404, 'not_found')
  if (!allowed.split('|').includes(method)) return fail(res, 405, 'method_not_allowed')

  const deps = envDeps()
  const env = extras.env ?? process.env
  const dir = extras.dataDir ?? dataDir() // lazy: tes menyuntik dir sendiri dan tak boleh menyentuh home
  const x = {
    detect: () => defaultDetect(env), fetch: globalThis.fetch as unknown as CapCtx['fetch'], ...extras,
    dataDir: dir, secrets: extras.secrets ?? createFileSecretStore(join(dir, SECRETS_SUBDIR)),
  }
  if (method === 'GET') return send(res, { status: 200, body: buildResponse(env, x.detect(), x.dataDir) })

  const verdict = deps.guard(req)
  const [peer, via] = [peerOf(req), verdict.ok ? verdict.via : 'rejected' as const]
  // Audit tak boleh menjatuhkan mutasi yang sudah sah: gagal tulis hanya di-warn.
  const note: CapCtx['audit'] = (entry) => {
    try { deps.audit?.({ peer, via, ...entry }) } catch (err) { log.warn('audit.write_failed', 'Cannot write capability audit row', { cause: err instanceof Error ? err.name : 'error' }) }
  }
  if (!verdict.ok) {
    note({ capability: isCapabilityId(seg) ? seg : 'advanced', action: 'denied', detail: verdict.reason })
    return fail(res, 403, 'forbidden')
  }
  if (!fixed && !isCapabilityId(seg)) return fail(res, 404, 'unknown_capability')

  const body = await readBody(req, res)
  if (body === undefined) return true
  const c: CapCtx = { settings: deps.service, env, detect: x.detect, dataDir: x.dataDir, secrets: x.secrets, fetch: x.fetch, audit: note }
  if (seg === 'reset') return send(res, await reset(c))
  if (!isRecord(body)) return fail(res, 400, 'invalid_body')
  if (seg === 'advanced') return send(res, await setAdvanced(c, body))
  if (sub === 'connect') return typeof body.token === 'string' ? send(res, await connect(c, body.token)) : fail(res, 400, 'invalid_body')
  if (sub === 'sub') {
    return typeof body.key === 'string' && typeof body.on === 'boolean' ? send(res, setSub(c, seg as CapabilityId, body.key, body.on)) : fail(res, 400, 'invalid_body')
  }
  return typeof body.enabled === 'boolean' ? send(res, await toggle(c, seg as CapabilityId, body.enabled)) : fail(res, 400, 'invalid_body')
}
