import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { authorizeRequest, denyReason, isNodeTokenPath, logAuthReject } from '../auth'
import { logBus } from './logBus'
import { logsRoute } from './logApi'
import { CLIENT_MAX_ENTRIES, CLIENT_RATE_MAX_ENTRIES, createWindowLimiter } from './logClientApi'
import { configureLogging, createLogger, getLogLevel, setLogLevel } from './logger'
import { pathTemplate, startRequestLog } from './httpLog'

// test-only: synthetic credential, never a real one.
const SECRET = 'sk-SYNTHETICsecret0123456789abcdef'

let server: http.Server
let base = ''
beforeAll(async () => {
  server = http.createServer((req, res) => {
    logsRoute(req, res, new URL(req.url || '/', 'http://x'), req.method || 'GET').then((hit) => {
      if (!hit) { res.statusCode = 404; res.end() }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.closeAllConnections(); server.close() })
beforeEach(() => {
  configureLogging({ env: { WEBTERM_LOG_FILE: 'off' }, console: false })
  setLogLevel('trace')
  logBus.clear()
})

const send = (path: string, method = 'GET', body?: unknown) =>
  fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

describe('GET /api/logs', () => {
  it('returns entries, lastSeq, channels, level, capacity, dropped and filters', async () => {
    const a = createLogger('pty'); const b = createLogger('fs')
    a.info('pty.spawn', 'Spawned shell'); b.warn('fs.error', 'EACCES'); a.debug('pty.resize', 'resize')
    const all = await (await send('/api/logs')).json()
    expect(all.entries).toHaveLength(3)
    expect(all).toMatchObject({ lastSeq: logBus.lastSeq, level: 'trace', capacity: logBus.capacity, dropped: 0 })
    expect(all.channels).toEqual([{ channel: 'fs', count: 1 }, { channel: 'pty', count: 2 }])
    expect((await (await send('/api/logs?level=warn')).json()).entries).toHaveLength(1)
    expect((await (await send('/api/logs?channel=pty&q=SPAWN')).json()).entries).toHaveLength(1)
    expect((await (await send(`/api/logs?afterSeq=${all.entries[0].seq}`)).json()).entries).toHaveLength(2)
    expect((await (await send('/api/logs?limit=1')).json()).entries).toHaveLength(1)
  })
  it('rejects malformed query and wrong method', async () => {
    for (const q of ['afterSeq=-1', 'limit=abc', 'level=loud']) expect((await send(`/api/logs?${q}`)).status, q).toBe(400)
    expect((await send('/api/logs', 'POST', {})).status).toBe(405)
    expect((await send('/api/logs/nope')).status).toBe(404)
  })
})

describe('PUT /api/logs/level and DELETE /api/logs', () => {
  it('changes the runtime level and validates input', async () => {
    expect((await send('/api/logs/level', 'PUT', { level: 'error' })).status).toBe(200)
    expect(getLogLevel()).toBe('error')
    for (const body of [{ level: 'off' }, {}, 'nope']) expect((await send('/api/logs/level', 'PUT', body)).status).toBe(400)
  })
  it('clears the buffer and records logs.clear', async () => {
    createLogger('x').info('a.b', 'one')
    expect((await send('/api/logs', 'DELETE')).status).toBe(204)
    expect(logBus.query().map((e) => e.event)).toEqual(['logs.clear'])
  })
})

describe('POST /api/logs/client', () => {
  it('stores entries as client/client, redacted, never trusting channel or source', async () => {
    const res = await send('/api/logs/client', 'POST', {
      entries: [{ level: 'error', event: 'client.error', message: `boom ${SECRET}`, data: { token: 'abc123456', channel: 'server', source: 'server' }, channel: 'auth', source: 'server' }],
    })
    expect(res.status).toBe(202)
    const [e] = logBus.query()
    expect(e).toMatchObject({ source: 'client', channel: 'client', event: 'client.error', level: 'error' })
    expect(JSON.stringify(e)).not.toContain(SECRET)
    expect(e.data?.token).toBe('[redacted]')
  })
  it('caps entries per request, body size, and validates shape', async () => {
    const entry = { level: 'info', event: 'c.e', message: 'm' }
    expect((await send('/api/logs/client', 'POST', { entries: Array(CLIENT_MAX_ENTRIES + 1).fill(entry) })).status).toBe(400)
    expect((await send('/api/logs/client', 'POST', { entries: [{ ...entry, message: 'x'.repeat(64 * 1024) }] })).status).toBe(413)
    expect((await send('/api/logs/client', 'POST', { entries: [{ level: 'loud', message: 'm' }] })).status).toBe(400)
    expect((await send('/api/logs/client', 'POST', { entries: [] })).status).toBe(400)
    expect(logBus.query()).toHaveLength(0)
  })
  it('truncates long messages', async () => {
    await send('/api/logs/client', 'POST', { entries: [{ level: 'info', event: 'c.e', message: 'y'.repeat(5000) }] })
    expect(logBus.query()[0].message.length).toBeLessThanOrEqual(1001)
  })
  it('window limiter blocks past the cap and recovers after the window', () => {
    let t = 0
    const lim = createWindowLimiter(CLIENT_RATE_MAX_ENTRIES, 1000, () => t)
    expect(lim.take(CLIENT_RATE_MAX_ENTRIES)).toBe(true)
    expect(lim.take(1)).toBe(false)
    t = 1000
    expect(lim.take(1)).toBe(true)
  })
})

describe('GET /api/logs/stream (SSE)', () => {
  function open(path: string, headers: Record<string, string> = {}) {
    return new Promise<{ req: http.ClientRequest; res: http.IncomingMessage; text: () => string }>((resolve) => {
      const req = http.get(base + path, { headers }, (res) => {
        let buf = ''
        res.on('data', (c) => { buf += c })
        resolve({ req, res, text: () => buf })
      })
    })
  }
  const waitFor = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)) }

  it('streams live entries, resumes from Last-Event-ID, and releases the subscriber on disconnect', async () => {
    const log = createLogger('x')
    log.info('a.one', 'one'); log.info('a.two', 'two'); log.info('a.three', 'three')
    const first = logBus.lastSeq - 2
    const s = await open('/api/logs/stream', { 'Last-Event-ID': String(first) })
    expect(s.res.headers['content-type']).toBe('text/event-stream')
    await waitFor(() => s.text().includes('a.three'))
    expect(s.text()).not.toContain('a.one')
    expect(s.text()).toContain(`id: ${first + 1}\nevent: log\n`)
    expect(logBus.subscriberCount).toBe(1)
    log.info('a.live', 'live')
    await waitFor(() => s.text().includes('a.live'))
    expect(s.text()).toContain(`id: ${first + 3}\n`)
    s.req.destroy()
    await waitFor(() => logBus.subscriberCount === 0)
    expect(logBus.subscriberCount).toBe(0)
  })
  it('without a cursor starts live only; bad cursor is 400', async () => {
    createLogger('x').info('a.old', 'old')
    const s = await open('/api/logs/stream')
    createLogger('x').info('a.new', 'new')
    await waitFor(() => s.text().includes('a.new'))
    expect(s.text()).not.toContain('a.old')
    s.req.destroy()
    expect((await send('/api/logs/stream?afterSeq=x')).status).toBe(400)
  })
})

describe('auth tier', () => {
  const headers = {}
  const gate = (over: Partial<Parameters<typeof authorizeRequest>[0]>) =>
    authorizeRequest({ headers, expectedToken: 'root-token-synthetic', pathname: '/api/logs', isNodeToken: (t) => t === 'node-token', ...over })
  it('log endpoints are root-token only, like settings/env', () => {
    for (const p of ['/api/logs', '/api/logs/stream', '/api/logs/level', '/api/logs/client']) expect(isNodeTokenPath(p), p).toBe(false)
    expect(gate({})).toBe(false)
    expect(gate({ queryToken: 'node-token' })).toBe(false)
    expect(gate({ queryToken: 'wrong' })).toBe(false)
    expect(gate({ queryToken: 'root-token-synthetic' })).toBe(true)
    expect(gate({ headers: { origin: 'http://evil.example', host: '127.0.0.1:8700' }, queryToken: 'root-token-synthetic' })).toBe(false)
  })
})

describe('pathTemplate', () => {
  it('hides opaque ids, keeps route words', () => {
    expect(pathTemplate('/api/workspaces/3f2a9c1e-77aa-4b1c')).toBe('/api/workspaces/:id')
    expect(pathTemplate('/api/settings/env')).toBe('/api/settings/env')
  })
})

describe('auth.reject logging', () => {
  it('records path and reason only, with origin vs token told apart', () => {
    expect(denyReason({}, 'root-token-synthetic', 'wrong')).toBe('token')
    expect(denyReason({ origin: 'http://evil.example', host: '127.0.0.1:8700' }, undefined)).toBe('origin')
    logAuthReject('/api/logs', 'token')
    const [e] = logBus.query()
    expect(e).toMatchObject({ level: 'warn', channel: 'auth', event: 'auth.reject', data: { path: '/api/logs', reason: 'token' } })
  })
})

describe('http request logging', () => {
  const fake = (url: string, status: number) => {
    const res = Object.assign(new EventEmitter(), { statusCode: status, writableFinished: true })
    const req = { method: 'GET', url }
    return { res, req, log: startRequestLog(req as never, res as never) }
  }
  it('logs method, templated path, status and duration but never the query string', () => {
    const { res } = fake('/api/workspaces/3f2a9c1e-77aa-4b1c?token=abcdef123456', 200)
    res.emit('close')
    const [e] = logBus.query()
    expect(e).toMatchObject({ level: 'debug', event: 'http.request', data: { method: 'GET', path: '/api/workspaces/:id', status: 200 } })
    expect(e.ids?.requestId).toBeTruthy()
    expect(JSON.stringify(e)).not.toContain('abcdef123456')
  })
  it('5xx -> warn http.error; a thrown route -> error http.error; /api/logs is skipped', () => {
    fake('/api/x', 503).res.emit('close')
    const thrown = fake('/api/y', 500)
    thrown.log.fail(new Error('db down'))
    thrown.res.emit('close')
    fake('/api/logs?level=info', 200).res.emit('close')
    expect(logBus.query().map((e) => `${e.level}:${e.event}`)).toEqual(['warn:http.error', 'error:http.error', 'debug:http.request'])
  })
})
