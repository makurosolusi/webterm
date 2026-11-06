// Kabel boot yang dipisah dari index.ts (yang mulai server saat diimpor): urutan efek samping
// mengikuti PLAN ENV-MINIMAL (b) §2.4 dan DILARANG diubah — tiap langkah bergantung pada yang
// sebelumnya. index.ts hanya memanggil fungsi di sini.
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { writeTokenToEnv } from './auth'
import { dataDir } from './config'
import { recordDotenvBoot } from './dotenvFiles'
import { describeListenError, isKnownListenError } from './listenError'
import { createLogger } from './logs'
import { resolveHostPort } from './serverConfig'
import { bootstrapToken, setTokenState, tokenFilePath, type TokenState } from './tokenBootstrap'

const SECRETS_SUBDIR = 'secrets'
const TOKEN_FILE_MODE_LABEL = '0600'
const LISTEN_FAILED_EXIT_CODE = 1

const log = createLogger('server')

/** Where the access token lives: a new one is logged (path + length); a terminal gets one line naming
 *  its source on every boot (headless sign-in pastes it). The value itself is never printed or logged. */
function announceToken(state: TokenState, secretsDir: string): void {
  if (state.token === undefined) return
  const path = tokenFilePath(secretsDir)
  if (state.created) log.info('auth.token_created', 'Access token created', { path, len: state.token.length })
  if (!process.stderr.isTTY) return
  const where = state.source === 'env' ? 'the WEBTERM_TOKEN environment variable' : `${path} (${TOKEN_FILE_MODE_LABEL})`
  process.stderr.write(`webterm: sign in through the window webterm opens, or paste the access token from ${where}\n`)
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
