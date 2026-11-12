// SSE over the terminal WebSocket (sseBridge.ts): a real SSE route delivers frames, the HTTP gate
// refuses the same identity with the same status, non-stream urls never run, and unsub / socket
// close run the handler's own close cleanup.
import { afterAll, describe, expect, it } from 'bun:test'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMsg } from '../shared/protocol'

// test-only: never touch the real ~/.webterm-server or ~/.claude.
const tmp = mkdtempSync(join(tmpdir(), 'ssebridge-'))
process.env.WEBTERM_DATA_DIR = join(tmp, 'data')
process.env.HOME = tmp
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')

const { createStreamBridge, STREAM_NOT_ALLOWED, STREAM_NOT_SSE } = await import('./sseBridge')
const { handleLogStream } = await import('./logs/logSse')
const { createLogger } = await import('./logs')
const { authorizeRequest, TOKEN_HEADER } = await import('./auth')
const { refuseRequest } = await import('./bootWiring')

const TOKEN = 'test-only-token-0123456789' // test-only

/** The gate + dispatch shape of index.ts `routeApp`, over the real log SSE handler. */
function gated(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x')
  if (!authorizeRequest({ headers: req.headers, expectedToken: TOKEN, pathname: url.pathname, isNodeToken: () => false })) return refuseRequest(res)
  if (url.pathname === '/api/logs/stream') return handleLogStream(req, res, url, 60_000)
  res.statusCode = 404
  res.end()
}

function bridge(headers: Record<string, string>, dispatch = gated) {
  const frames: ServerMsg[] = []
  const b = createStreamBridge({ headers: { host: '127.0.0.1:1', ...headers }, socket: { remoteAddress: '127.0.0.1' } }, (m) => frames.push(m), dispatch, () => 0)
  return { b, frames }
}
const tick = () => new Promise((r) => setTimeout(r, 5))

const server = http.createServer(gated)
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
afterAll(() => { server.close(); rmSync(tmp, { recursive: true, force: true }) })

describe('sse bridge', () => {
  it('a subscription to the real log stream delivers named frames with their id', async () => {
    const { b, frames } = bridge({ [TOKEN_HEADER]: TOKEN })
    b.sub('s1', '/api/logs/stream')
    expect(frames[0]).toEqual({ t: 'sse.open', id: 's1' })
    createLogger('sse-test').warn('sse.test', 'hello over the socket')
    await tick()
    const ev = frames.find((f) => f.t === 'sse.ev')
    expect(ev?.t === 'sse.ev' && ev.event).toBe('log')
    const entry = JSON.parse(ev?.t === 'sse.ev' ? ev.data : '{}')
    expect(entry.message).toContain('hello over the socket')
    expect(ev?.t === 'sse.ev' && ev.lastId).toBe(String(entry.seq))
    b.closeAll()
  })

  it('refuses an unauthorized identity with the status HTTP gives it', async () => {
    const http403 = (await fetch(`${base}/api/logs/stream`)).status
    expect(http403).toBe(403)
    const { b, frames } = bridge({})
    b.sub('s1', '/api/logs/stream')
    expect(frames).toEqual([{ t: 'sse.end', id: 's1', status: http403 }])
    // A wrong token is refused too, and the stream never opened.
    const wrong = bridge({ [TOKEN_HEADER]: 'nope' })
    wrong.b.sub('s2', '/api/logs/stream')
    expect(wrong.frames).toEqual([{ t: 'sse.end', id: 's2', status: 403 }])
  })

  it('never runs a url that is not an allowed SSE route', () => {
    let ran = 0
    const { b, frames } = bridge({ [TOKEN_HEADER]: TOKEN }, (req, res) => { ran += 1; gated(req, res) })
    for (const url of ['/api/settings', '/ws', 'http://evil/api/logs/stream', '//evil/api/logs/stream', '/api/../api/settings', '/api/logs/stream/../../settings', 42]) b.sub('x', url)
    expect(ran).toBe(0)
    expect(frames.every((f) => f.t === 'sse.end' && f.status === STREAM_NOT_ALLOWED)).toBe(true)
    expect(frames).toHaveLength(7)
  })

  it('an allowed path answering anything but text/event-stream is ended, not streamed', () => {
    const { b, frames } = bridge({ [TOKEN_HEADER]: TOKEN }, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}') })
    b.sub('j', '/api/events/stream')
    expect(frames).toEqual([{ t: 'sse.end', id: 'j', status: STREAM_NOT_SSE }])
    const bad = bridge({ [TOKEN_HEADER]: TOKEN })
    bad.b.sub('c', '/api/logs/stream?afterSeq=nope')
    expect(bad.frames).toEqual([{ t: 'sse.end', id: 'c', status: 400 }])
  })

  it('unsub and socket close fire close on req and res so the handler cleans up', async () => {
    const closes: string[] = []
    const watch = (req: IncomingMessage, res: ServerResponse): void => {
      req.on('close', () => closes.push(`req:${req.url}`))
      res.on('close', () => closes.push(`res:${req.url}`))
      gated(req, res)
    }
    const { b, frames } = bridge({ [TOKEN_HEADER]: TOKEN }, watch)
    b.sub('a', '/api/logs/stream?afterSeq=0')
    b.sub('b', '/api/logs/stream')
    b.unsub('a')
    expect(closes.sort()).toEqual(['req:/api/logs/stream?afterSeq=0', 'res:/api/logs/stream?afterSeq=0'])
    // The handler's bus subscriber is gone: a new entry reaches only the live stream.
    const before = frames.length
    createLogger('sse-test').warn('sse.test', 'after unsub')
    await tick()
    expect(frames.slice(before).map((f) => ('id' in f ? f.id : ''))).toEqual(['b'])
    b.closeAll()
    expect(closes).toHaveLength(4)
    createLogger('sse-test').warn('sse.test', 'after close')
    await tick()
    expect(frames.length).toBe(before + 1)
  })
})
