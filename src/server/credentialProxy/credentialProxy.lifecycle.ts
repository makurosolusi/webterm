// Start/stop of the credential proxy with a persisted token and port, so live tmux panes keep a valid
// ANTHROPIC_BASE_URL across server restarts (docs/decisions/credential-proxy.md section 3).
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createFileSecretStore } from '../envSecrets.store'
import { createLogger } from '../logs'
import { createProxyHandler, serveProxy, type ProxyDeps, type ProxyServer } from './credentialProxy.server'
import type { ProxyEndpoint, Upstream } from './credentialProxy.types'

const log = createLogger('credential-proxy')
const SUBDIR = 'credential-proxy'
const TOKEN_KEY = 'TOKEN'
const PORT_KEY = 'PORT'
const TOKEN_BYTES = 32
const LOOPBACK = '127.0.0.1'

export interface StartOptions {
  dataDir: string
  resolveUpstream: () => Upstream | null
  /** Called once the proxy is listening (wave 2 connects the child-env endpoint source here). */
  onStarted?: (endpoint: ProxyEndpoint) => void
  /** Called when the stored port was taken and a new one was chosen; running sessions hold the old address. */
  onPortChanged?: (change: { oldPort: number; newPort: number }) => void
  /** Test knobs forwarded to the handler (limits, fake fetch). */
  handler?: Partial<Omit<ProxyDeps, 'token' | 'resolveUpstream'>>
}

let server: ProxyServer | null = null
let endpoint: ProxyEndpoint | null = null

/** The running proxy's address and placeholder token, or null when not started. */
export const activeEndpoint = (): ProxyEndpoint | null => endpoint

function isAddrInUse(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  return e?.code === 'EADDRINUSE' || /EADDRINUSE|address already in use|port .* in use/i.test(e?.message ?? '')
}

/** Start (or return) the proxy: reuse the stored token and port; if the port is taken pick a new one and say so. */
export function startCredentialProxy(opts: StartOptions): ProxyEndpoint {
  if (endpoint) return endpoint
  const store = createFileSecretStore(join(opts.dataDir, SUBDIR))
  let token = store.read(TOKEN_KEY)
  if (!token) { token = randomBytes(TOKEN_BYTES).toString('base64url'); store.write(TOKEN_KEY, token) }
  const storedPort = Number(store.read(PORT_KEY))
  const handler = createProxyHandler({ ...opts.handler, token, resolveUpstream: opts.resolveUpstream })
  const maxBody = opts.handler?.maxBodyBytes
  let srv: ProxyServer
  let changed: { oldPort: number; newPort: number } | null = null
  const hasStored = Number.isInteger(storedPort) && storedPort > 0
  try {
    srv = serveProxy(handler, hasStored ? storedPort : 0, maxBody)
  } catch (err) {
    if (!hasStored || !isAddrInUse(err)) throw new Error(`credential proxy: cannot listen on ${LOOPBACK}:${hasStored ? storedPort : 0} (${(err as { code?: string }).code ?? 'error'})`)
    srv = serveProxy(handler, 0, maxBody)
    changed = { oldPort: storedPort, newPort: srv.port }
  }
  const port = srv.port
  if (!hasStored || changed) store.write(PORT_KEY, String(port))
  server = srv
  endpoint = { url: `http://${LOOPBACK}:${port}`, token }
  if (changed) {
    log.warn('credential_proxy.port_changed', 'Credential proxy port was taken; running agent sessions point at the old address and need a restart', { oldPort: changed.oldPort, newPort: changed.newPort })
    opts.onPortChanged?.(changed)
  }
  opts.onStarted?.(endpoint)
  return endpoint
}

/** Stop listening and forget the endpoint; the stored token and port stay for the next start. */
export async function stopCredentialProxy(): Promise<void> {
  const s = server
  server = null
  endpoint = null
  await s?.stop(true)
}
