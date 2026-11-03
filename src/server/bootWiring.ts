// Kabel boot yang dipisah dari index.ts (yang mulai server saat diimpor): urutan efek samping
// mengikuti PLAN ENV-MINIMAL (b) §2.4 dan DILARANG diubah — tiap langkah bergantung pada yang
// sebelumnya. index.ts hanya memanggil fungsi di sini.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { type AllowedHostsArg, denyReason, writeTokenToEnv } from './auth'
import { dataDir } from './config'
import { recordDotenvBoot } from './dotenvFiles'
import { buildAllowedHosts } from './hostAllow'
import { describeListenError, isKnownListenError } from './listenError'
import { createLogger } from './logs'
import { resolveHostPort } from './serverConfig'
import { bootstrapToken, getTokenState, setTokenState, tokenFilePath, type TokenState } from './tokenBootstrap'

const SECRETS_SUBDIR = 'secrets'
const TOKEN_FILE_MODE_LABEL = '0600'
/** Kode `error` di body 403 saat header Host ditolak allowlist. */
export const HOST_DENIED_ERROR = 'host_not_allowed'
const LISTEN_FAILED_EXIT_CODE = 1

const log = createLogger('server')

/** Token baru: URL ber-token hanya ke stderr TTY (sekali, bukan logger); selain TTY hanya path + panjang. */
function announceToken(state: TokenState, host: string, port: number, secretsDir: string): void {
  if (!state.created || state.token === undefined) return
  const path = tokenFilePath(secretsDir)
  if (!process.stderr.isTTY) {
    log.info('auth.token_created', 'Access token created', { path, len: state.token.length })
    return
  }
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  process.stderr.write(`webterm: access token created at ${path} (${TOKEN_FILE_MODE_LABEL}). Open: http://${urlHost}:${port}/?token=${state.token}\n`)
}

/**
 * Langkah boot 1-6: host/port (galat sebelum menyentuh disk), provenance `.env` SEBELUM overlay
 * Settings memutasi env, dataDir, token (token rusak berhenti di sini), lalu allowlist Host.
 * Allowlist hanya aktif selama token belum ditegakkan (dievaluasi per request, mati sendiri setelah enable).
 */
export function bootWiring(env: NodeJS.ProcessEnv, cwd: string): { host: string; port: number; hosts: AllowedHostsArg } {
  const { host, port } = resolveHostPort(env)
  recordDotenvBoot(cwd, env)
  const secretsDir = join(dataDir(), SECRETS_SUBDIR)
  const state = bootstrapToken({ host, env, secretsDir })
  setTokenState(state)
  // Semua pembaca process.env.WEBTERM_TOKEN (PTY anak, penjaga auth) harus melihat bentuk kanonik.
  writeTokenToEnv(state.token)
  announceToken(state, host, port, secretsDir)
  const list = buildAllowedHosts({ host, port, env })
  if (list.ignored > 0) log.warn('hosts.ignored', 'WEBTERM_ALLOWED_HOSTS entries ignored (malformed or over the limit)', { count: list.ignored })
  return { host, port, hosts: () => (getTokenState().source === 'none' ? list : undefined) }
}

/** 403 untuk request yang ditolak gerbang: Host ditolak => JSON `host_not_allowed` (Host tak dipantulkan). */
export function refuseRequest(req: IncomingMessage, res: ServerResponse, hosts: AllowedHostsArg): void {
  res.statusCode = 403
  if (denyReason(req.headers, undefined, null, hosts) !== 'host') return void res.end('forbidden')
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: HOST_DENIED_ERROR }))
}

/** Handler 'error' server: galat bind yang dikenal keluar kode 1 dengan satu pesan; sisanya dilempar dengan konteks. */
export function onListenError(host: string, port: number): (err: unknown) => void {
  return (err) => {
    if (!isKnownListenError(err)) throw new Error(`listen on ${host}:${port} failed`, { cause: err })
    log.error('server.listen_failed', `Cannot listen on ${host}:${port}`, { code: (err as NodeJS.ErrnoException).code })
    process.stderr.write(`${describeListenError(err, host, port)}\n`)
    process.exit(LISTEN_FAILED_EXIT_CODE)
  }
}
