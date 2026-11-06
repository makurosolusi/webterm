// Dev-server proxy wiring. The proxy itself runs on its own listener (proxy/proxy.listener.ts, its own
// origin); the main server only (1) answers 404 on /proxy + /absproxy and (2) tells the UI where the
// proxy lives via `GET /api/proxy-info` (UI-only: `uiOnlyDenial`, path not in `isNodeTokenPath`).
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AllowedHostsArg } from '../auth'
import { startPortScanner } from '../ports/ports.runtime'
import { parseProxyUrl } from '../proxy/proxy.service'
import { preferredProxyPort, startProxyListener } from '../proxy/proxy.listener'
import { getTokenState } from '../tokenBootstrap'
import { uiSessions } from '../uiSession'
import { json, type ApiRoute } from './route.core'

let proxyPort: number | undefined

/** Boot: start the proxy listener next to the main server (same host). */
export async function startDevProxy(o: { host: string; mainPort: number; allowedHosts: AllowedHostsArg; env: NodeJS.ProcessEnv }): Promise<void> {
  const l = await startProxyListener({
    host: o.host, port: preferredProxyPort(o.env, o.mainPort),
    deps: {
      allowedHosts: o.allowedHosts, mainPort: o.mainPort,
      token: () => getTokenState().token,
      isUiSession: (raw) => uiSessions().verify(raw),
      listening: async () => (await startPortScanner()).list(),
      selfPorts: () => (proxyPort === undefined ? [o.mainPort] : [o.mainPort, proxyPort]),
    },
  })
  proxyPort = l.port
}

/**
 * Main server: /proxy + /absproxy are 404 here (true = answered). Not a 308 to the proxy origin: the
 * main server cannot know the proxy's externally visible scheme/host (TLS tunnel, port not exposed),
 * and a guessed redirect fails worse than a clear 404; the UI builds links from /api/proxy-info.
 */
export function refuseProxyOnMain(req: IncomingMessage, res: ServerResponse): boolean {
  if (parseProxyUrl(req.url ?? '/') === null) return false
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found: the dev-server proxy has its own origin, see /api/proxy-info')
  return true
}

/** `{ port, url }` of the proxy listener; url uses the hostname the UI reached webterm by. */
export function proxyInfo(hostHeader: string | undefined, port: number | undefined): { status: number; body: unknown } {
  if (port === undefined) return { status: 503, body: { error: 'proxy_unavailable' } }
  let hostname = '127.0.0.1'
  try { hostname = new URL(`http://${hostHeader ?? ''}`).hostname || hostname } catch { /* malformed Host: keep the loopback default */ }
  return { status: 200, body: { port, url: `http://${hostname}:${port}` } }
}

export const proxyInfoRoutes: ApiRoute[] = [
  {
    name: 'proxy-info',
    match: (c) => c.path === '/api/proxy-info',
    handle: async (c) => {
      if (c.method !== 'GET') { json(c.res, 405, { error: 'method_not_allowed' }); return true }
      const [{ uiOnlyDenial }, { isValidNodeToken }] = await Promise.all([import('../approvalAuth'), import('../hooksTokens')])
      const denied = uiOnlyDenial(c.req, c.url, isValidNodeToken)
      if (denied) { json(c.res, 403, { error: denied }); return true }
      const r = proxyInfo(c.req.headers.host, proxyPort)
      json(c.res, r.status, r.body)
      return true
    },
  },
]
