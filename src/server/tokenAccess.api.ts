// Opt-in token akses root untuk bind loopback: `GET /api/settings/token` (status tanpa nilai),
// `POST .../enable` (loopback tanpa token -> bangkitkan + simpan, nilai keluar SEKALI di respons)
// dan `POST .../rotate`. Kontrak: PLAN/ENV-MINIMAL-b.md §3. Tidak ada `disable` (kembali terbuka =
// hentikan server, hapus berkas token). Gerbang auth + allowlist Host sudah dijalankan index.ts
// sebelum rute ini dipanggil. enable/rotate hanya dari UI (`uiOnlyDenial`, approvalAuth.ts): tanpa itu
// shell agent cukup dua curl untuk mencetak token sendiri lalu menyetujui aksinya sendiri.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { uiOnlyDenial } from './approvalAuth'
import { writeTokenToEnv } from './auth'
import { isValidNodeToken } from './hooksTokens'
import { readCappedRequestBody } from './cappedRequestBody'
import { createLogger } from './logs'
import { getTokenState, mintToken, persistToken, setTokenState } from './tokenBootstrap'

const log = createLogger('auth')

export const TOKEN_ACCESS_PATH = '/api/settings/token'
const ENABLE_PATH = `${TOKEN_ACCESS_PATH}/enable`
const ROTATE_PATH = `${TOKEN_ACCESS_PATH}/rotate`
/** Body enable/rotate tidak dipakai; 1 KiB cukup untuk bidang opsional masa depan. */
export const TOKEN_BODY_MAX_BYTES = 1024
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const
/** Peer loopback dilihat dari socket; X-Forwarded-For sengaja tidak dipakai (bisa dipalsukan). */
const LOOPBACK_PEERS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(JSON.stringify(body))
}

function isLoopbackPeer(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress
  return addr !== undefined && LOOPBACK_PEERS.has(addr)
}

/** Nilai token hanya keluar lewat sini: sekali, tanpa cache. */
function sendToken(res: ServerResponse, token: string): void {
  json(res, 200, { token }, NO_STORE_HEADERS)
}

/** Bangkitkan + simpan + tegakkan token baru; sinkron seluruhnya. Mengembalikan null bila gagal tulis (state tak berubah). */
function installToken(secretsDir: string, event: string): string | null {
  const token = mintToken()
  try {
    persistToken(secretsDir, token)
  } catch (err) {
    log.error('auth.token_persist_failed', `Cannot persist access token (${event})`, {
      cause: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  setTokenState({ token, source: 'file', created: true })
  writeTokenToEnv(token)
  log.info(event, 'Access token installed', { source: 'file' })
  return token
}

/** Baca-dan-buang body kecil; false = sudah dijawab (413 / gagal baca). */
async function drainBody(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const read = await readCappedRequestBody(req, TOKEN_BODY_MAX_BYTES)
  if (read.ok) return true
  if (read.reason === 'too_large') json(res, 413, { error: 'payload_too_large' })
  else json(res, 400, { error: 'body_read_failed' })
  return false
}

async function enable(req: IncomingMessage, res: ServerResponse, secretsDir: string): Promise<void> {
  if (!isLoopbackPeer(req)) return json(res, 403, { error: 'loopback_only' })
  if (!(await drainBody(req, res))) return
  // Setelah await terakhir semuanya sinkron: dua permintaan konkuren tak bisa sama-sama lolos cek ini.
  if (getTokenState().source !== 'none') return json(res, 409, { error: 'already_enabled' })
  const token = installToken(secretsDir, 'auth.token_enabled')
  if (token === null) return json(res, 500, { error: 'token_persist_failed' })
  sendToken(res, token)
}

async function rotate(req: IncomingMessage, res: ServerResponse, secretsDir: string): Promise<void> {
  if (!(await drainBody(req, res))) return
  const { source } = getTokenState()
  if (source === 'env') return json(res, 409, { error: 'env_managed' })
  if (source === 'none') return json(res, 409, { error: 'not_enabled' })
  const token = installToken(secretsDir, 'auth.token_rotated')
  if (token === null) return json(res, 500, { error: 'token_persist_failed' })
  sendToken(res, token)
}

async function dispatch(req: IncomingMessage, res: ServerResponse, path: string, secretsDir: string): Promise<void> {
  const method = req.method ?? 'GET'
  if (path === TOKEN_ACCESS_PATH) {
    if (method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const { token, source } = getTokenState()
    return json(res, 200, { enforced: token !== undefined, source, canEnable: source === 'none' && isLoopbackPeer(req) })
  }
  if (method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  const denial = uiOnlyDenial(req, new URL(req.url ?? path, 'http://x'), isValidNodeToken)
  if (denial) return json(res, 403, { error: denial })
  return path === ENABLE_PATH ? enable(req, res, secretsDir) : rotate(req, res, secretsDir)
}

/**
 * Layani rute token opt-in; true = path milik keluarga ini (respons ditulis, async), false = bukan.
 * Dipanggil index.ts SETELAH gerbang auth/Host.
 */
export function tokenAccessRoute(req: IncomingMessage, res: ServerResponse, pathname: string, secretsDir: string): boolean {
  if (pathname !== TOKEN_ACCESS_PATH && pathname !== ENABLE_PATH && pathname !== ROTATE_PATH) return false
  dispatch(req, res, pathname, secretsDir).catch((err: unknown) => {
    log.error('auth.token_route_failed', `Token route failed: ${pathname}`, { cause: err instanceof Error ? err.message : String(err) })
    if (!res.headersSent) json(res, 500, { error: 'internal' })
  })
  return true
}
