// The proxy's own HTTP listener: a separate port = a separate browser origin from webterm's UI.
// Serves ONLY /proxy/<port>/ and /absproxy/<port>/; everything else (UI, /api, /ws) is 404 / closed.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { parsePort } from '../serverConfig'
import { createLogger } from '../logs'
import { handleProxyRequest, handleProxyUpgrade, type ProxyDeps } from './proxy.service'

const log = createLogger('proxy')

/** Env override for the proxy port; empty = webterm PORT + 1. */
export const PROXY_PORT_KEY = 'WEBTERM_PROXY_PORT'

/** Port to try first: `WEBTERM_PROXY_PORT` (validated like PORT), else main port + 1 (0 = OS pick past 65535). */
export function preferredProxyPort(env: NodeJS.ProcessEnv, mainPort: number): number {
  const raw = (env[PROXY_PORT_KEY] ?? '').trim()
  if (raw !== '') return parsePort(raw)
  return mainPort < 65_535 ? mainPort + 1 : 0
}

export interface ProxyListener { port: number; close(): Promise<void> }

function listenOn(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => { server.off('listening', onListening); reject(err) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError).once('listening', onListening)
    server.listen(port, host)
  })
}

/** Start the listener on `host` (same as the main server). Busy preferred port -> OS-assigned port. */
export async function startProxyListener(o: { host: string; port: number; deps: ProxyDeps }): Promise<ProxyListener> {
  const server = http.createServer((req, res) => {
    if (handleProxyRequest(req, res, o.deps)) return
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })
  server.on('upgrade', (req, socket, head) => { if (!handleProxyUpgrade(req, socket, head, o.deps)) socket.destroy() })
  try {
    await listenOn(server, o.host, o.port)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || o.port === 0) throw new Error(`proxy listen on ${o.host}:${o.port} failed`, { cause: err })
    log.warn('proxy.port_busy', `Proxy port ${o.port} is busy, using an OS-assigned port`, { port: o.port })
    await listenOn(server, o.host, 0)
  }
  const port = (server.address() as AddressInfo).port
  log.info('proxy.start', `Dev-server proxy listening on http://${o.host}:${port}`, { port })
  return { port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) }
}
