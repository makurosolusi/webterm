// Kabel boot yang dipisah dari index.ts (yang mulai server saat diimpor): urutan efek samping
// mengikuti PLAN ENV-MINIMAL (b) §2.4 dan DILARANG diubah — tiap langkah bergantung pada yang
// sebelumnya. index.ts hanya memanggil fungsi di sini.
import type { ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { writeTokenToEnv } from './auth'
import { dataDir } from './config'
import { recordDotenvBoot } from './dotenvFiles'
import { describeListenError, isKnownListenError } from './listenError'
import { createLogger } from './logs'
import { resolveHostPort } from './serverConfig'
import { bootstrapToken, getTokenState, setTokenState, tokenFilePath, type TokenState } from './tokenBootstrap'
import { writeInstanceFile } from './instanceFile'

const SECRETS_SUBDIR = 'secrets'
const LISTEN_FAILED_EXIT_CODE = 1

const log = createLogger('server')

/** A new access token is logged (path + length, never the value). It is for machines (header,
 *  MCP, scripts); humans sign in with an account, so the terminal no longer points them at it. */
function announceToken(state: TokenState, secretsDir: string): void {
  if (state.token === undefined || !state.created) return
  log.info('auth.token_created', 'Access token created', { path: tokenFilePath(secretsDir), len: state.token.length })
}

/** Setup hint printed once at boot while no account exists. Exported for tests. */
export const setupLine = (path: string): string =>
  `No account yet — open webterm in a browser on this machine to create one, or use the setup code in ${path}`

/**
 * While no account exists, make sure a setup code exists and print ONE line naming its file (never the
 * value). `ensure` is setupCode.ts `ensureSetupCode` bound to the data dir (injected: it opens webterm.db).
 */
export function announceSetup(ensure: () => string | null): void {
  const path = ensure()
  if (path !== null) process.stderr.write(`webterm: ${setupLine(path)}\n`)
}

/**
 * Langkah boot: host/port (galat sebelum menyentuh disk), provenance `.env` SEBELUM overlay
 * Settings memutasi env, dataDir, lalu token (token rusak berhenti di sini).
 */
export function bootWiring(env: NodeJS.ProcessEnv, cwd: string): { host: string; port: number } {
  const { host, port } = resolveHostPort(env)
  recordDotenvBoot(cwd, env)
  const secretsDir = join(dataDir(), SECRETS_SUBDIR)
  const state = bootstrapToken({ env, secretsDir })
  setTokenState(state)
  // Semua pembaca process.env.WEBTERM_TOKEN (PTY anak, penjaga auth) harus melihat bentuk kanonik.
  writeTokenToEnv(state.token)
  announceToken(state, secretsDir)
  return { host, port }
}

/** Plain 403 for a request the /api gate refused; the reason stays in the `auth.reject` log, not the body. */
export function refuseRequest(res: ServerResponse): void {
  res.statusCode = 403
  res.end('forbidden')
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

/**
 * Main listener bound: record this server in the run dir (the native app finds it there instead of
 * starting a second one, instanceFile.ts), log the start line, then run `autoOpen`.
 */
export function announceListening(o: { host: string; port: number; dev: boolean; runDir: string; autoOpen: () => void }): void {
  try { writeInstanceFile(o.runDir, { pid: process.pid, host: o.host, port: o.port }) } catch (e) {
    log.warn('server.instance_file_failed', 'Cannot record this server in the run dir', { cause: e instanceof Error ? e.message : String(e) })
  }
  // Never log the token itself — only whether one is in force, how long it is, and where it came from.
  const { token: TOKEN, source } = getTokenState()
  const token = TOKEN === undefined ? 'off: loopback only' : `on: len=${TOKEN.length}`
  log.info('server.start', `webterm listening on http://${o.host}:${o.port} (${o.dev ? 'dev+HMR' : 'prod'}, token ${token}, source ${source})`, {
    host: o.host, port: o.port, mode: o.dev ? 'dev' : 'prod', dataDir: basename(dataDir()), authRequired: TOKEN !== undefined,
  })
  o.autoOpen()
}
