// Credential proxy end to end: real proxy on loopback, fake upstream Bun.serve, no network beyond 127.0.0.1.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// Importing the logger must not touch the user's real data dir.
const DIR = mkdtempSync(join(tmpdir(), 'webterm-credproxy-'))
process.env.WEBTERM_DATA_DIR = DIR

const { createProxyHandler, serveProxy } = await import('./credentialProxy.server')
const { logBus, setLogLevel, getLogLevel } = await import('../logs')
type Upstream = import('./credentialProxy.types').Upstream
type Served = import('./credentialProxy.server').ProxyServer
declare const Bun: { serve(opts: Record<string, unknown>): Served }

const TOKEN = 'placeholder-token-AAAA' // test-only
const REAL = 'sk-ant-REAL-secret-ZZZZ' // test-only
const enc = new TextEncoder()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Seen { path: string; headers: Headers; body: string; aborted: boolean }
let seen: Seen[] = []
let hold: Promise<void> = Promise.resolve()
let release: () => void = () => undefined
const gate = (): void => { hold = new Promise((r) => { release = r }) }

const fake = Bun.serve({
  hostname: '127.0.0.1', port: 0, idleTimeout: 0,
  async fetch(req: Request) {
    const url = new URL(req.url)
    const s: Seen = { path: url.pathname + url.search, headers: req.headers, body: await req.text(), aborted: false }
    req.signal.addEventListener('abort', () => { s.aborted = true })
    seen.push(s)
    const mode = url.searchParams.get('mode')
    if (mode === 'sse') {
      return new Response(new ReadableStream({
        async start(c) { c.enqueue(enc.encode('data: one\n\n')); await hold; c.enqueue(enc.encode('data: two\n\n')); c.close() },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }
    if (mode === 'silent') {
      return new Response(new ReadableStream({
        async start(c) { c.enqueue(enc.encode('a')); await sleep(5200); c.enqueue(enc.encode('b')); c.close() },
      }))
    }
    if (mode === 'stall') return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('a')) } }))
    if (mode === 'hang') { await hold; return new Response('late') }
    if (mode === 'gzip') return new Response(gzipSync('hello gzip'), { headers: { 'content-encoding': 'gzip', 'content-type': 'text/plain' } })
    if (mode === '529') return new Response('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}', { status: 529 })
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } })
  },
})
const upstreamBase = `http://127.0.0.1:${fake.port}`

let upstream: Upstream | null = { baseUrl: upstreamBase, kind: 'xApiKey', secret: REAL, headers: {} }
const servers: Served[] = []
function start(extra: Partial<Parameters<typeof createProxyHandler>[0]> = {}): string {
  const handler = createProxyHandler({ token: TOKEN, resolveUpstream: () => upstream, ...extra })
  const s = serveProxy(handler, 0)
  servers.push(s)
  return `http://127.0.0.1:${s.port}`
}
const auth = { 'x-api-key': TOKEN }
const prevLevel = getLogLevel()

beforeAll(() => setLogLevel('debug'))
afterEach(() => { release(); seen = []; upstream = { baseUrl: upstreamBase, kind: 'xApiKey', secret: REAL, headers: {} } })
afterAll(() => {
  setLogLevel(prevLevel)
  for (const s of servers) void s.stop(true)
  void fake.stop(true)
  rmSync(DIR, { recursive: true, force: true })
})

async function code(res: Response): Promise<string> { return ((await res.json()) as { error: { message: string } }).error.message }

describe('auth and credential swap', () => {
  test('401 without or with a wrong token, and the upstream is never called', async () => {
    const base = start()
    for (const headers of [{}, { 'x-api-key': 'nope' }, { authorization: 'Bearer nope' }] as Array<Record<string, string>>) {
      const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body: '{}' })
      expect(res.status).toBe(401)
      expect(await code(res)).toBe('webterm credential proxy: bad_proxy_token')
    }
    expect(seen.length).toBe(0)
  })

  test('x-api-key upstream receives the real key, never the placeholder; set-cookie is dropped', async () => {
    const base = start()
    const res = await fetch(`${base}/v1/messages?beta=true`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', cookie: 'c=1' }, body: '{"hi":1}' })
    expect(res.status).toBe(200)
    expect(res.headers.has('set-cookie')).toBe(false)
    expect(await res.json()).toEqual({ ok: true })
    const s = seen[0]!
    expect(s.path).toBe('/v1/messages?beta=true')
    expect(s.body).toBe('{"hi":1}')
    expect(s.headers.get('x-api-key')).toBe(REAL)
    expect(s.headers.get('authorization')).toBeNull()
    expect(s.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(s.headers.get('cookie')).toBeNull()
    expect([...s.headers.values()].some((v) => v.includes(TOKEN))).toBe(false)
  })

  test('bearer upstream with custom headers; client may authenticate with Bearer', async () => {
    upstream = { baseUrl: upstreamBase, kind: 'bearer', secret: REAL, headers: { 'x-gateway-team': 'blue' } }
    const base = start()
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}' })
    expect(res.status).toBe(200)
    const s = seen[0]!
    expect(s.headers.get('authorization')).toBe(`Bearer ${REAL}`)
    expect(s.headers.get('x-api-key')).toBeNull()
    expect(s.headers.get('x-gateway-team')).toBe('blue')
  })

  test('bad path, bad method and missing upstream are refused before anything is sent', async () => {
    const base = start()
    expect((await fetch(`${base}/admin`, { headers: auth })).status).toBe(400)
    expect((await fetch(`${base}/v1/messages`, { method: 'PUT', headers: auth, body: '{}' })).status).toBe(405)
    upstream = null
    const res = await fetch(`${base}/v1/messages`, { headers: auth })
    expect(res.status).toBe(503)
    expect(await code(res)).toBe('webterm credential proxy: no_upstream')
    expect(seen.length).toBe(0)
  })
})

describe('streaming', () => {
  test('SSE is relayed chunk by chunk, not buffered', async () => {
    gate()
    const base = start()
    const res = await fetch(`${base}/v1/messages?mode=sse`, { headers: auth })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('data: one\n\n') // arrives while upstream is still open
    release()
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toBe('data: two\n\n')
    expect((await reader.read()).done).toBe(true)
  })

  test('a gzip upstream body reaches the client decoded with honest headers', async () => {
    const base = start()
    const res = await fetch(`${base}/v1/messages?mode=gzip`, { headers: { ...auth, 'accept-encoding': 'gzip' } })
    expect(await res.text()).toBe('hello gzip')
    expect(res.headers.get('content-encoding')).toBeNull()
  })

  test('client abort cancels the upstream request', async () => {
    gate()
    const base = start()
    const ctl = new AbortController()
    const res = await fetch(`${base}/v1/messages?mode=sse`, { headers: auth, signal: ctl.signal })
    await res.body!.getReader().read()
    ctl.abort()
    for (let i = 0; i < 40 && !seen[0]?.aborted; i++) await sleep(50)
    expect(seen[0]!.aborted).toBe(true)
  })

  test('a stream silent for 5 s is not cut (Bun idleTimeout 0)', async () => {
    const base = start()
    const res = await fetch(`${base}/v1/messages?mode=silent`, { headers: auth })
    expect(await res.text()).toBe('ab')
  }, 15_000)

  test('a stream idle longer than the chunk timeout errors out and aborts upstream', async () => {
    const base = start({ idleChunkTimeoutMs: 200 })
    const res = await fetch(`${base}/v1/messages?mode=stall`, { headers: auth })
    let failed = false
    try { await res.text() } catch { failed = true }
    expect(failed).toBe(true)
    for (let i = 0; i < 40 && !seen[0]?.aborted; i++) await sleep(50)
    expect(seen[0]!.aborted).toBe(true)
  })
})

describe('error mapping and limits', () => {
  test('upstream 5xx passes through with its own body', async () => {
    const base = start()
    const res = await fetch(`${base}/v1/messages?mode=529`, { headers: auth })
    expect(res.status).toBe(529)
    expect(await res.text()).toContain('overloaded_error')
  })

  test('unreachable upstream maps to 502 and a hung one to 504', async () => {
    const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const deadUrl = `http://127.0.0.1:${dead.port}`
    await dead.stop(true)
    upstream = { baseUrl: deadUrl, kind: 'xApiKey', secret: REAL, headers: {} }
    const base = start({ ttfbTimeoutMs: 200 })
    const r1 = await fetch(`${base}/v1/messages`, { headers: auth })
    expect(r1.status).toBe(502)
    expect(await code(r1)).toBe('webterm credential proxy: upstream_unreachable')
    upstream = { baseUrl: upstreamBase, kind: 'xApiKey', secret: REAL, headers: {} }
    gate()
    const r2 = await fetch(`${base}/v1/messages?mode=hang`, { headers: auth })
    expect(r2.status).toBe(504)
    expect(await code(r2)).toBe('webterm credential proxy: upstream_timeout')
  })

  test('body over the cap is 413 and never reaches upstream', async () => {
    const base = start({ maxBodyBytes: 1000 })
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: auth, body: 'x'.repeat(2000) })
    expect(res.status).toBe(413)
    expect(await code(res)).toBe('webterm credential proxy: body_too_large')
    expect(seen.length).toBe(0)
  })

  test('requests over the in-flight cap get 429 and the slot frees afterwards', async () => {
    gate()
    const base = start({ maxInFlight: 1 })
    const first = fetch(`${base}/v1/messages?mode=hang`, { headers: auth })
    for (let i = 0; i < 40 && seen.length === 0; i++) await sleep(25)
    const second = await fetch(`${base}/v1/messages`, { headers: auth })
    expect(second.status).toBe(429)
    expect(await code(second)).toBe('webterm credential proxy: proxy_busy')
    release()
    expect((await first).status).toBe(200)
    expect((await fetch(`${base}/v1/messages`, { headers: auth })).status).toBe(200)
  })
})

describe('logging', () => {
  test('no credential, token, query or body ends up in the captured logs', async () => {
    const base = start()
    await fetch(`${base}/v1/messages?secret_query=QQQ-sentinel`, { method: 'POST', headers: { ...auth, 'x-custom-leak': 'HHH-sentinel' }, body: 'BBB-sentinel' })
    upstream = null
    await fetch(`${base}/v1/messages`, { headers: auth })
    await fetch(`${base}/v1/messages`, { headers: { 'x-api-key': 'wrong-WWW-sentinel' } })
    const dump = JSON.stringify(logBus.snapshot())
    expect(dump).toContain('credential_proxy.request')
    for (const needle of [REAL, TOKEN, 'QQQ-sentinel', 'HHH-sentinel', 'BBB-sentinel', 'WWW-sentinel']) expect(dump).not.toContain(needle)
  })
})
