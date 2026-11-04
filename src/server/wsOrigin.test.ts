import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { BROWSER_WS_PATH } from '../shared/browser.contract'
import { WS_PATH } from '../shared/protocol'
import { TOKEN_HEADER, authorizeRequest } from './auth'
import { upgradeRoute } from './upgradeRouting'
import { WS_ORIGIN_REQUIRED, humanUpgradeOriginOk } from './wsOrigin'

const SELF = 'webterm.test:8700'
const ROOT = 'root-s3cret' // test-only
const NODE = 'node-token-aaaa' // test-only

describe('humanUpgradeOriginOk', () => {
  it('accepts a browser-shaped handshake (Origin == Host) without a token', () => {
    expect(humanUpgradeOriginOk({ host: SELF, origin: `http://${SELF}` }, false)).toBe(true)
  })
  it('denies a handshake with no Origin when no root token is in force (curl, agent shell)', () => {
    expect(humanUpgradeOriginOk({ host: SELF }, false)).toBe(false)
    expect(humanUpgradeOriginOk({ host: SELF, origin: '' }, false)).toBe(false)
    expect(humanUpgradeOriginOk({ host: SELF, 'sec-fetch-site': 'same-origin' }, false)).toBe(false)
  })
  it('denies a foreign, null or malformed Origin', () => {
    expect(humanUpgradeOriginOk({ host: SELF, origin: 'https://evil.example' }, false)).toBe(false)
    expect(humanUpgradeOriginOk({ host: SELF, origin: 'null' }, false)).toBe(false)
    expect(humanUpgradeOriginOk({ host: SELF, origin: 'not a url' }, false)).toBe(false)
  })
  it('leaves the root-token path unchanged: the verified token is the credential', () => {
    expect(humanUpgradeOriginOk({ host: SELF }, true)).toBe(true)
  })
})

// Real sockets: the same steps index.ts runs on every upgrade (route, allowed(), then the Origin check),
// driven by a real `ws` client so status codes and bodies are what a caller actually sees.
describe('human-channel upgrades over a real socket', () => {
  let server: http.Server
  let port = 0
  let token: string | undefined
  const wss = new WebSocketServer({ noServer: true })

  beforeAll(async () => {
    server = http.createServer()
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://x')
      if (upgradeRoute(url.pathname, WS_PATH, false, BROWSER_WS_PATH) === 'destroy') return socket.destroy()
      const ok = authorizeRequest({
        headers: req.headers,
        expectedToken: token,
        queryToken: url.searchParams.get('token'),
        pathname: url.pathname,
        isNodeToken: (t) => t === NODE,
      })
      if (!ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return socket.destroy()
      }
      if (!humanUpgradeOriginOk(req.headers, token !== undefined)) {
        socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: ${WS_ORIGIN_REQUIRED.length}\r\n\r\n${WS_ORIGIN_REQUIRED}`)
        return socket.destroy()
      }
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(1000, 'ok'))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  /** Resolves 'open' or the refused HTTP status + body. */
  function dial(opts: { origin?: string; query?: string; headers?: Record<string, string>; path?: string } = {}): Promise<string> {
    const self = `127.0.0.1:${port}`
    const ws = new WebSocket(`ws://${self}${opts.path ?? WS_PATH}${opts.query ?? ''}`, {
      ...(opts.origin !== undefined && { origin: opts.origin.replace('SELF', self) }),
      ...(opts.headers && { headers: opts.headers }),
    })
    return new Promise((resolve) => {
      ws.on('open', () => { ws.close(); resolve('open') })
      ws.on('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve(`${res.statusCode} ${body}`.trim()))
      })
      ws.on('error', () => {})
    })
  }

  it('token-free bind: browser-shaped upgrade opens', async () => {
    token = undefined
    expect(await dial({ origin: 'http://SELF' })).toBe('open')
  })
  it('token-free bind: no-Origin upgrade from loopback is denied with 403 origin_required', async () => {
    token = undefined
    expect(await dial()).toBe(`403 ${WS_ORIGIN_REQUIRED}`)
  })
  it('token-free bind: /ws/browser opens for a browser-shaped upgrade and refuses no-Origin / foreign Origin', async () => {
    token = undefined
    const path = BROWSER_WS_PATH
    expect(await dial({ path, origin: 'http://SELF', query: '?workspaceId=w1' })).toBe('open')
    expect(await dial({ path, query: '?workspaceId=w1' })).toBe(`403 ${WS_ORIGIN_REQUIRED}`)
    expect(await dial({ path, origin: 'https://evil.example', query: '?workspaceId=w1' })).toMatch(/^403/)
  })
  it('/ws/browser with the root token is unchanged (token opens, no token refused)', async () => {
    token = ROOT
    expect(await dial({ path: BROWSER_WS_PATH, query: `?workspaceId=w1&token=${ROOT}` })).toBe('open')
    expect(await dial({ path: BROWSER_WS_PATH, origin: 'http://SELF', query: '?workspaceId=w1' })).toMatch(/^403/)
  })
  it('foreign Origin is denied', async () => {
    token = undefined
    expect(await dial({ origin: 'https://evil.example' })).toMatch(/^403/)
  })
  it('a node token (agent session credential) still cannot open /ws', async () => {
    token = ROOT
    expect(await dial({ headers: { [TOKEN_HEADER]: NODE } })).toMatch(/^403/)
    expect(await dial({ origin: 'http://SELF', query: `?token=${NODE}` })).toMatch(/^403/)
  })
  it('root token path unchanged: token opens with or without Origin, missing token is refused', async () => {
    token = ROOT
    expect(await dial({ query: `?token=${ROOT}` })).toBe('open')
    expect(await dial({ origin: 'http://SELF', query: `?token=${ROOT}` })).toBe('open')
    expect(await dial({ headers: { [TOKEN_HEADER]: ROOT } })).toBe('open')
    expect(await dial({ origin: 'http://SELF' })).toMatch(/^403/)
  })
})

describe('index.ts wiring', () => {
  // index.ts binds a port on import, so assert the wiring from its source (pattern of auth.test.ts).
  it('applies the Origin check to every claimed upgrade (/ws and /ws/browser), after allowed(), keyed on the live root token', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8')
    expect(src).toMatch(/if \(!humanUpgradeOriginOk\(req\.headers, getTokenState\(\)\.token !== undefined\)\)/)
    // Before the browser branch, so /ws/browser cannot bypass it; after destroy/ignore, so Vite HMR is untouched.
    expect(src.indexOf("if (route === 'ignore') return")).toBeLessThan(src.indexOf('humanUpgradeOriginOk(req.headers'))
    expect(src.indexOf('humanUpgradeOriginOk(req.headers')).toBeLessThan(src.indexOf("if (route === 'browser')"))
    expect(src.indexOf('if (!allowed(req, url))')).toBeLessThan(src.indexOf('humanUpgradeOriginOk(req.headers'))
  })
})
