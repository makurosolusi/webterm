// Real sockets: index.ts's upgrade steps (route, allowed(), Origin gate) then lspUpgrade, with the
// fake stdio language server behind it.
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { WS_PATH } from '../../shared/protocol'
import { authorizeRequest } from '../auth'
import { upgradeRoute } from '../upgradeRouting'
import { WS_ORIGIN_REQUIRED, humanUpgradeOriginOk } from '../wsOrigin'
import { LSP_CLOSE, LSP_UNAVAILABLE, LSP_WS_PATH } from './lsp.contract'
import { LspManager } from './lsp.manager'
import { LSP_HINTS } from './lsp.resolve'
import { lspUpgrade } from './lsp.route'

const FAKE = path.join(__dirname, '__fixtures__', 'fakeLsp.mjs')

describe('/ws/lsp over a real socket', () => {
  let server: http.Server
  let port = 0
  const mgr = new LspManager({ resolve: (root) => (root === '/none' ? LSP_HINTS.typescript : { cmd: process.execPath, args: [FAKE] }), env: () => process.env })
  const workspaces: Record<string, string> = { w1: __dirname, nolsp: '/none' }

  beforeAll(async () => {
    server = http.createServer()
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://x')
      const route = upgradeRoute(url.pathname, WS_PATH, false)
      if (route === 'destroy') return socket.destroy()
      if (!authorizeRequest({ headers: req.headers, expectedToken: undefined, queryToken: null, pathname: url.pathname, isNodeToken: () => false })) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return socket.destroy()
      }
      if (!humanUpgradeOriginOk(req.headers, false)) {
        socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: ${WS_ORIGIN_REQUIRED.length}\r\n\r\n${WS_ORIGIN_REQUIRED}`)
        return socket.destroy()
      }
      if (route === 'lsp') lspUpgrade(req, socket, head, url, { workspace: (id) => (workspaces[id] ? ({ id, cwd: workspaces[id] } as never) : null), manager: mgr })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => { mgr.killAll(); return new Promise<void>((r) => server.close(() => r())) })

  const dial = (query: string, withOrigin = true) =>
    new WebSocket(`ws://127.0.0.1:${port}${LSP_WS_PATH}${query}`, withOrigin ? { origin: `http://127.0.0.1:${port}` } : {})

  const refused = (ws: WebSocket) => new Promise<string>((resolve) => {
    ws.on('unexpected-response', (_q, res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(`${res.statusCode} ${b}`.trim())) })
    ws.on('open', () => resolve('open'))
    ws.on('error', () => {})
  })

  it('routes /ws/lsp as lsp', () => {
    expect(upgradeRoute(LSP_WS_PATH, WS_PATH, true)).toBe('lsp')
    expect(upgradeRoute(LSP_WS_PATH, WS_PATH, false)).toBe('lsp')
  })

  it('refuses a no-Origin upgrade (curl / agent shell) with 403 origin_required', async () => {
    expect(await refused(dial('?workspace=w1', false))).toBe(`403 ${WS_ORIGIN_REQUIRED}`)
    expect(mgr.size).toBe(0)
  })

  it('refuses an unknown workspace or language with 400', async () => {
    expect(await refused(dial('?workspace=missing'))).toBe('400')
    expect(await refused(dial('?workspace=w1&language=cobol'))).toBe('400')
  })

  it('forwards JSON-RPC both ways between the socket and the language server', async () => {
    const ws = dial('?workspace=w1&language=typescript')
    const msgs: { id?: string; result?: unknown }[] = []
    await new Promise<void>((r) => ws.on('open', () => r()))
    const got = new Promise<void>((resolve) => ws.on('message', (raw) => { msgs.push(JSON.parse(String(raw))); if (msgs.some((m) => m.id === 'e')) resolve() }))
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'e', method: 'test/echo', params: { ok: true } }))
    await got
    expect(msgs.find((m) => m.id === 'e')!.result).toEqual({ ok: true })
    ws.close()
  })

  it('sends the install hint and closes with the unavailable code when no server exists', async () => {
    const ws = dial('?workspace=nolsp')
    const [frame, code] = await Promise.all([
      new Promise<unknown>((r) => ws.on('message', (raw) => r(JSON.parse(String(raw))))),
      new Promise<number>((r) => ws.on('close', (c) => r(c))),
    ])
    expect(frame).toEqual({ webterm: LSP_UNAVAILABLE, ...LSP_HINTS.typescript })
    expect(code).toBe(LSP_CLOSE.unavailable)
  })
})

describe('index.ts wiring', () => {
  it('routes /ws/lsp only after allowed() and the Origin gate', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8')
    const lsp = src.indexOf("if (route === 'lsp') return lspUpgrade(")
    expect(lsp).toBeGreaterThan(0)
    expect(src.indexOf('if (!allowed(req, url))')).toBeLessThan(lsp)
    expect(src.indexOf('humanUpgradeOriginOk(req.headers')).toBeLessThan(lsp)
  })
})
