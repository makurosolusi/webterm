// Test connection against a real local HTTP server standing in for a gateway (no network, no real model).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ANTHROPIC_VERSION, probeProvider } from './claudeProvider.probe'

const KEY = 'sk-test-only-0123456789abcdef' // test-only
let server: Server
let base = ''
let seen: { url?: string; headers: IncomingHttpHeaders; body: string }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body })
      const ok = req.headers['authorization'] === `Bearer ${KEY}` || req.headers['x-api-key'] === KEY
      res.setHeader('content-type', 'application/json')
      if (!ok) { res.statusCode = 401; res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `bad ${KEY}` } })); return }
      if (JSON.parse(body).model === 'missing-model') { res.statusCode = 404; res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error' } })); return }
      res.end(JSON.stringify({ id: 'msg_1', content: [] }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('probeProvider', () => {
  it('ok: POST /v1/messages with max_tokens 1, Bearer header for an auth token', async () => {
    seen = []
    const r = await probeProvider({ mode: 'custom', baseUrl: base, credential: 'authToken' }, KEY)
    expect(r).toMatchObject({ outcome: 'ok', ok: true, status: 200 })
    expect(seen[0]!.url).toBe('/v1/messages')
    expect(seen[0]!.headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(seen[0]!.headers['x-api-key']).toBeUndefined()
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ max_tokens: 1 })
  })

  it('401: credential in the wrong header is reported as rejected; nothing of the body is echoed', async () => {
    const r = await probeProvider({ mode: 'custom', baseUrl: base, credential: 'apiKey' }, 'sk-wrong-test-only-000')
    expect(r).toMatchObject({ outcome: 'auth_rejected', ok: false, status: 401, errorType: 'authentication_error' })
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('x-api-key header for an API key credential', async () => {
    seen = []
    expect((await probeProvider({ mode: 'custom', baseUrl: base, credential: 'apiKey' }, KEY)).outcome).toBe('ok')
    expect(seen[0]!.headers['x-api-key']).toBe(KEY)
    expect(seen[0]!.headers['authorization']).toBeUndefined()
  })

  it('unknown model still proves the credential (docs: verify the connection)', async () => {
    const r = await probeProvider({ mode: 'custom', baseUrl: base, credential: 'authToken', model: 'missing-model' }, KEY)
    expect(r).toMatchObject({ outcome: 'model_rejected', ok: true, status: 404 })
  })

  it('unreachable: nothing listening', async () => {
    const closed = createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((r) => closed.close(() => r()))
    const r = await probeProvider({ mode: 'custom', baseUrl: `http://127.0.0.1:${port}`, credential: 'authToken' }, KEY)
    expect(r).toMatchObject({ outcome: 'unreachable', ok: false })
  })

  it('apiKey mode targets the Anthropic API; login or a missing key is not_configured', async () => {
    const urls: string[] = []
    const fake = (async (u: string) => { urls.push(u); return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    await probeProvider({ mode: 'apiKey' }, KEY, fake)
    expect(urls).toEqual(['https://api.anthropic.com/v1/messages'])
    expect((await probeProvider({ mode: 'login' }, KEY, fake)).outcome).toBe('not_configured')
    expect((await probeProvider({ mode: 'apiKey' }, null, fake)).outcome).toBe('not_configured')
  })
})
