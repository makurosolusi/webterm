// Real sockets end to end: a fake upstream dev server (HTTP echo + WS echo) on a random port, the real
// proxy listener (its own port = own origin), and a stand-in main server routed like index.ts.
// Asserts stripping, passthrough, the allowlist, every gate and the origin split.
import { afterAll, describe, expect, test } from 'bun:test'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { UI_SESSION_COOKIE, authorizeRequest } from '../auth'
import { parseProxyUrl, PROXY_COOKIE, type ProxyDeps } from './proxy.service'
import { preferredProxyPort, startProxyListener, type ProxyListener } from './proxy.listener'

process.env.WEBTERM_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'wt-proxy-')) // before proxy.routes -> db
const { proxyInfo, refuseProxyOnMain } = await import('../routes/proxy.routes')

const listen = (s: http.Server): Promise<number> => new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

const token = 'root-secret-token' // test-only
const SESSION = 's'.repeat(43) // test-only: the one live `wt_ui` value
const UI = `${UI_SESSION_COOKIE}=${SESSION}`
const LAN_PORT = 45_999 // test-only: "listening" on a LAN address per the fake sensor

const upstream = http.createServer((req, res) => {
  if (req.url === '/go') { res.writeHead(302, { Location: '/there' }); res.end(); return }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Keep-Alive': 'timeout=77', 'X-Hop': 'x', Connection: 'X-Hop' })
  res.end(JSON.stringify({ url: req.url, headers: req.headers }))
})
new WebSocketServer({ server: upstream }).on('connection', (ws, req) => ws.on('message', (m) => ws.send(`echo:${req.url}:${m}`)))
const up = await listen(upstream)
// Stand-in for webterm's main server: index.ts calls refuseProxyOnMain before /api and the UI.
const main = http.createServer((req, res) => { if (!refuseProxyOnMain(req, res)) { res.writeHead(200); res.end('webterm ui') } })
const mainPort = await listen(main)
let proxyPort = 0
const deps: ProxyDeps = {
  token: () => token,
  isUiSession: (raw) => raw === SESSION,
  mainPort,
  listening: async () => [{ port: up, host: '127.0.0.1' }, { port: LAN_PORT, host: '192.168.1.5' }, { port: mainPort, host: '127.0.0.1' }, { port: proxyPort, host: '127.0.0.1' }],
  selfPorts: () => [mainPort, proxyPort],
}
const listener: ProxyListener = await startProxyListener({ host: '127.0.0.1', port: 0, deps })
proxyPort = listener.port
const fr = proxyPort
afterAll(async () => { await listener.close(); main.close(); upstream.close() })

const origin = () => `http://127.0.0.1:${fr}`
/** Signed-in UI by default (its browser sends `wt_ui` to this port too); pass `{}` explicitly for no credential. */
const get = (path: string, headers: Record<string, string> = { Cookie: UI }) => fetch(`${origin()}${path}`, { headers, redirect: 'manual' })
const echo = async (path: string, headers: Record<string, string> = { Cookie: UI }) => {
  const r = await get(path, headers)
  expect(r.status).toBe(200)
  return { res: r, body: (await r.json()) as { url: string; headers: Record<string, string> } }
}

function wsTry(path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${fr}${path}`, { headers })
    ws.on('open', () => ws.send('hi'))
    ws.on('message', (m) => { resolve(String(m)); ws.close() })
    ws.on('unexpected-response', (_req, res) => resolve(`status:${res.statusCode}`))
    ws.on('error', (e) => resolve(`error:${e.message}`))
  })
}

describe('parseProxyUrl', () => {
  test('strip vs passthrough, token dropped, bad ports', () => {
    expect(parseProxyUrl('/proxy/5173/a/b?x=1&token=s&y=2')).toMatchObject({ kind: 'proxy', port: 5173, path: '/a/b', search: '?x=1&y=2', bare: false })
    expect(parseProxyUrl('/absproxy/5173/a')).toMatchObject({ path: '/absproxy/5173/a', search: '' })
    expect(parseProxyUrl('/proxy/5173')).toMatchObject({ bare: true })
    expect(parseProxyUrl('/proxy/0/')).toBe('bad_port')
    expect(parseProxyUrl('/proxy/70000/')).toBe('bad_port')
    expect(parseProxyUrl('/proxy/10.0.0.1:80/')).toBe('bad_port')
    expect(parseProxyUrl('/api/proxy/1/')).toBeNull()
  })
})

describe('HTTP', () => {
  test('/proxy strips the prefix and the token param', async () => {
    const { body } = await echo(`/proxy/${up}/a/b?x=1&token=zzz`)
    expect(body.url).toBe('/a/b?x=1')
    expect(body.headers.host).toBe(`localhost:${up}`)
  })

  test('/absproxy passes the path as is', async () => {
    expect((await echo(`/absproxy/${up}/src/main.ts`)).body.url).toBe(`/absproxy/${up}/src/main.ts`)
  })

  test('bare prefix redirects to the trailing slash on our own path only', async () => {
    const r = await get(`/proxy/${up}?q=1`)
    expect(r.status).toBe(308)
    expect(r.headers.get('location')).toBe(`/proxy/${up}/?q=1`)
  })

  test('upstream absolute Location is kept under the prefix', async () => {
    const r = await get(`/proxy/${up}/go`)
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe(`/proxy/${up}/there`)
  })

  test('hop-by-hop and webterm credentials never reach upstream; upstream hop-by-hop never reaches the client', async () => {
    const { res, body } = await echo(`/proxy/${up}/h`, {
      Cookie: `${PROXY_COOKIE}=abc; app=1; ${UI}`, 'x-webterm-token': 't', 'x-webterm-capability': 'wcap_x',
      'Proxy-Authorization': 'Basic x', 'X-Drop': '1', Connection: 'X-Drop', 'X-Keep': 'k',
    })
    expect(body.headers.cookie).toBe('app=1')
    for (const h of ['x-webterm-token', 'x-webterm-capability', 'proxy-authorization', 'x-drop']) expect(body.headers[h]).not.toBeDefined()
    expect(body.headers['x-keep']).toBe('k')
    expect(res.headers.get('keep-alive')).not.toBe('timeout=77') // the front server may add its own
    expect(res.headers.get('x-hop')).toBeNull()
  })

  test('the UI session cookie never reaches upstream (cookies ignore ports)', async () => {
    const { body } = await echo(`/proxy/${up}/h`, { Cookie: `${UI}; app=1; ${PROXY_COOKIE}=abc` })
    expect(body.headers.cookie).toBe('app=1')
    expect((await echo(`/proxy/${up}/h`, { Cookie: UI })).body.headers.cookie).not.toBeDefined()
  })

  test('port the sensor has not seen is refused', async () => {
    const r = await get('/proxy/1/')
    expect(r.status).toBe(403)
    expect(await r.text()).toBe('port_not_allowed')
  })

  test("webterm's main port and the proxy's own port are refused even when listed", async () => {
    expect((await get(`/proxy/${mainPort}/`)).status).toBe(403)
    expect((await get(`/proxy/${fr}/`)).status).toBe(403)
  })

  test('listener on a non-loopback address is refused', async () => {
    const r = await get(`/proxy/${LAN_PORT}/`)
    expect(r.status).toBe(403)
    expect(await r.text()).toBe('non_loopback_target')
  })

  test('foreign Origin is refused', async () => {
    expect((await get(`/proxy/${up}/`, { Cookie: UI, Origin: 'http://evil.example' })).status).toBe(403)
    expect((await get(`/proxy/${up}/`, { Cookie: UI, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
  })

  test('no credential 403; ?token= is never one; a dead session is not one; the root header sets a cookie that is not the token', async () => {
    expect((await get(`/proxy/${up}/`, {})).status).toBe(403)
    expect((await get(`/proxy/${up}/?token=${token}`, {})).status).toBe(403)
    expect((await get(`/proxy/${up}/`, { Cookie: `${UI_SESSION_COOKIE}=${'d'.repeat(43)}` })).status).toBe(403)
    const { res } = await echo(`/proxy/${up}/`, { 'x-webterm-token': token })
    const set = res.headers.get('set-cookie') ?? ''
    expect(set).toContain(`${PROXY_COOKIE}=`)
    expect(set).toContain(`Path=/proxy/${up}`)
    expect(set).toContain('HttpOnly')
    expect(set).not.toContain(token)
    const cookie = set.split(';')[0]!
    const { body } = await echo(`/proxy/${up}/asset.js`, { Cookie: cookie })
    expect(body.headers.cookie).not.toBeDefined() // webterm's cookie stripped
    expect((await get(`/proxy/${up}/`, { Cookie: `${PROXY_COOKIE}=forged` })).status).toBe(403)
  })
})

describe('WebSocket', () => {
  test('HMR socket passes through with a same-origin Origin', async () => {
    expect(await wsTry(`/absproxy/${up}/hmr?token=x`, { Origin: origin(), Cookie: UI })).toBe(`echo:/absproxy/${up}/hmr:hi`)
    expect(await wsTry(`/proxy/${up}/sock`, { Origin: origin(), Cookie: UI })).toBe('echo:/sock:hi')
  })

  test('cookie caller: missing Origin is refused (same rule as /ws); the root header needs none', async () => {
    expect(await wsTry(`/proxy/${up}/sock`, { Cookie: UI })).toBe('status:403')
    expect(await wsTry(`/proxy/${up}/sock`, { 'x-webterm-token': token })).toBe('echo:/sock:hi')
  })

  test('bad Origin and non-allowlisted / non-loopback ports are refused', async () => {
    expect(await wsTry(`/proxy/${up}/sock`, { Origin: 'http://evil.example', Cookie: UI })).toBe('status:403')
    expect(await wsTry('/proxy/1/sock', { Origin: origin(), Cookie: UI })).toBe('status:403')
    expect(await wsTry(`/proxy/${LAN_PORT}/sock`, { Origin: origin(), Cookie: UI })).toBe('status:403')
  })

  test('proxy cookie opens the socket, no credential and ?token= do not', async () => {
    expect(await wsTry(`/proxy/${up}/sock`, { Origin: origin() })).toBe('status:403')
    expect(await wsTry(`/proxy/${up}/sock?token=${token}`, { Origin: origin() })).toBe('status:403')
    const set = (await get(`/proxy/${up}/`, { 'x-webterm-token': token })).headers.get('set-cookie') ?? ''
    expect(await wsTry(`/proxy/${up}/sock`, { Origin: origin(), Cookie: set.split(';')[0]! })).toBe('echo:/sock:hi')
  })
})

describe('separate origin', () => {
  const mainOrigin = () => `http://127.0.0.1:${mainPort}`

  test('the main port no longer proxies (404, nothing reaches upstream)', async () => {
    for (const p of [`/proxy/${up}/a`, `/absproxy/${up}/a`, `/proxy/${up}`]) {
      const r = await fetch(`${mainOrigin()}${p}`, { redirect: 'manual' })
      expect(r.status).toBe(404)
      expect(await r.text()).toContain('/api/proxy-info')
    }
    expect(await (await fetch(`${mainOrigin()}/`)).text()).toBe('webterm ui') // other paths untouched
  })

  test('the proxy port serves no UI, /api or /ws', async () => {
    for (const p of ['/', '/index.html', '/api/settings', '/api/proxy-info', '/m', '/ws']) expect((await get(p)).status).toBe(404)
    expect((await wsTry('/ws', { Origin: origin() })).startsWith('error:')).toBe(true)
  })

  test('navigation from the webterm UI origin is accepted (HTTP + WS)', async () => {
    expect((await echo(`/proxy/${up}/`, { Origin: mainOrigin(), 'Sec-Fetch-Site': 'same-site', Cookie: UI })).body.url).toBe('/')
    expect(await wsTry(`/proxy/${up}/sock`, { Origin: mainOrigin(), Cookie: UI })).toBe('echo:/sock:hi')
    // Another port on the same host is not the UI: refused.
    expect((await get(`/proxy/${up}/`, { Origin: `http://127.0.0.1:${up}`, Cookie: UI })).status).toBe(403)
  })

  test('/api refuses a request whose Origin is the proxy origin', () => {
    const ask = (o: string) => authorizeRequest({
      headers: { host: `127.0.0.1:${mainPort}`, origin: o, cookie: UI }, expectedToken: token, pathname: '/api/settings', isNodeToken: () => false,
      isUiSession: (v) => v === SESSION,
    })
    expect(ask(mainOrigin())).toBe(true)
    expect(ask(origin())).toBe(false)
  })

  test('proxy-info reports the real port on the hostname the UI used; unavailable before boot', () => {
    expect(proxyInfo(`192.168.1.9:${mainPort}`, fr)).toEqual({ status: 200, body: { port: fr, url: `http://192.168.1.9:${fr}` } })
    expect(proxyInfo('[::1]:8700', 8701).body).toEqual({ port: 8701, url: 'http://[::1]:8701' })
    expect(proxyInfo('x', undefined).status).toBe(503)
  })

  test('port: PORT+1 by default, env override, busy -> OS-assigned', async () => {
    expect(preferredProxyPort({}, 8700)).toBe(8701)
    expect(preferredProxyPort({ WEBTERM_PROXY_PORT: '9000' }, 8700)).toBe(9000)
    expect(preferredProxyPort({}, 65_535)).toBe(0)
    const busy = await startProxyListener({ host: '127.0.0.1', port: fr, deps })
    try {
      expect(busy.port).not.toBe(fr)
      expect(busy.port).toBeGreaterThan(0)
    } finally { await busy.close() }
  })
})
