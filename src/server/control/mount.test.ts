// Test jembatan HTTP control plane. Deps disuntik penuh supaya tidak ada impor `bun:sqlite`/PTY;
// capability memakai store NYATA dari mount.ts agar jalur mint -> verify ikut teruji.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '../../shared/settings'
import type { OpenMsg } from '../../shared/protocol'
import { allows, clampTtl, type CapabilityVerb } from './capabilities'
import type { ControlDeps, ControlExit, ControlSessionInfo } from './controlTypes'
import { capabilityStore, handleControlHttp } from './mount'
import { authorizeRequest } from '../auth'

// Deps PRODUKSI (tanpa overrides) diuji lewat mock dua modul berat itu: `bun:sqlite`/PTY tidak
// bisa dimuat di node-env, tetapi jalur "deps modul stabil" tetap harus teruji (B2).
const prod = vi.hoisted(() => ({
  opened: [] as OpenMsg[],
  live: new Set<string>(),
}))

vi.mock('../sessions', () => ({
  sessions: {
    open(msg: OpenMsg) {
      prod.opened.push(msg)
      prod.live.add(msg.id)
    },
    input() {},
    close(id: string) {
      prod.live.delete(id)
    },
    list: () => [...prod.live].map((id) => ({ id })),
    statusOf: () => undefined,
    getExit: () => undefined,
    getTerminal: () => '',
    isLive: (id: string) => prod.live.has(id),
  },
}))

vi.mock('../db', () => ({ db: { getSettings: () => mergeSettings({}) } }))

interface FakeRes {
  statusCode: number
  headers: Record<string, string>
  ended: boolean
  body: string
  setHeader(name: string, value: string): void
  end(data?: string): void
}

function fakeRes(): FakeRes {
  return {
    statusCode: 200,
    headers: {},
    ended: false,
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(data = '') {
      this.ended = true
      this.body = data
    },
  }
}

/**
 * Request yang benar-benar streaming: mount membaca body lewat `readCappedBody`, jadi 'data'/'end'
 * harus datang dari req sendiri (reader yang disuntik hanya dipakai fake request non-stream).
 */
const streamReq = (
  method: string,
  headers: Record<string, string> = {},
  chunks: string[] = []
): IncomingMessage => {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, { method, headers, resume() {} })
  process.nextTick(() => {
    for (const chunk of chunks) req.emit('data', Buffer.from(chunk))
    req.emit('end')
  })
  return req
}

const fakeReq = (method: string, headers: Record<string, string> = {}, body = '') =>
  streamReq(method, headers, body ? [body] : [])

function harness(overrides: Partial<ControlDeps> = {}) {
  const nodes = new Map<string, { status?: 'done'; exit?: ControlExit; output: string }>()
  nodes.set('node-a', { output: 'hello' })

  const deps: ControlDeps = {
    sessions: {
      open(_msg: OpenMsg) {},
      input() {},
      close(id) {
        nodes.delete(id)
      },
      list(): ControlSessionInfo[] {
        return [...nodes.keys()].map((id, i) => ({ id, pid: i + 1 }))
      },
      statusOf: (id) => nodes.get(id)?.status,
      getExit: (id) => nodes.get(id)?.exit,
      getTerminal: (id) => nodes.get(id)?.output ?? '',
      screenSource: () => undefined,
      agentIdOf: () => undefined,
      isLive: (id) => nodes.has(id),
    },
    capabilities: {
      verify: (token, now = Date.now()) => capabilityStore.verify(token, now),
      allows,
      mint: (options) => ({
        token: capabilityStore.mint(options),
        expiresAt: Date.now() + clampTtl(options.ttlMs),
      }),
    },
    settings: () => mergeSettings({}),
    ...overrides,
  }

  const token = (verb: CapabilityVerb, resource: string) => capabilityStore.mint({ verb, resource })

  const call = async (
    method: string,
    path: string,
    opts: { body?: string; headers?: Record<string, string>; res?: FakeRes } = {}
  ) => {
    const res = opts.res ?? fakeRes()
    const handled = await handleControlHttp(
      fakeReq(method, opts.headers, opts.body),
      res as unknown as ServerResponse,
      new URL(path, 'http://x'),
      async () => opts.body ?? '',
      deps
    )
    return { handled, res }
  }

  return { deps, nodes, token, call }
}

describe('control HTTP mount', () => {
  it('rejects /nodes without a capability with 401', async () => {
    const h = harness()
    const { handled, res } = await h.call('GET', '/api/control/nodes')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' })
  })

  it('does not expose the token route unless minting is enabled', async () => {
    const h = harness()
    const { handled, res } = await h.call('POST', '/api/control/token', {
      body: JSON.stringify({ verb: 'node.read', resource: '*' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' })
  })

  it('falls through for paths outside /api/control without writing a response', async () => {
    const h = harness()
    const { handled, res } = await h.call('GET', '/api/settings')
    expect(handled).toBe(false)
    expect(res.ended).toBe(false)
    expect(res.statusCode).toBe(200)
  })

  it('lets a valid capability list visible nodes', async () => {
    const h = harness()
    const { handled, res } = await h.call('GET', '/api/control/nodes', {
      headers: { 'x-webterm-capability': h.token('node.read', '*') },
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([{ id: 'node-a', pid: 1 }])
  })

  it('rejects malformed JSON with 400 invalid_json', async () => {
    const h = harness()
    const { res } = await h.call('POST', '/api/control/spawn', { body: '{not json' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_json' })
  })

  it('rejects an oversized Content-Length before reading the body', async () => {
    const h = harness()
    // Non-empty on purpose: a mutant that fell back to `readBody` would otherwise hide behind
    // the 413 and the `not.toHaveBeenCalled()` line below would be unreachable.
    const readBody = vi.fn(async () => 'x'.repeat(65 * 1024))
    const res = fakeRes()
    const handled = await handleControlHttp(
      fakeReq('POST', { 'content-length': String(64 * 1024 + 1) }),
      res as unknown as ServerResponse,
      new URL('/api/control/spawn', 'http://x'),
      readBody,
      h.deps
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(413)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'payload_too_large' })
    expect(readBody).not.toHaveBeenCalled()
  })

  it('rejects an accumulated body over 64 KiB even without Content-Length', async () => {
    const h = harness()
    const body = JSON.stringify({ requestId: 'req-big-1', nodeId: 'node-a', pad: 'x'.repeat(65 * 1024) })
    const { res } = await h.call('POST', '/api/control/spawn', { body })
    expect(res.statusCode).toBe(413)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'payload_too_large' })
  })

  it('rejects a chunked body over the cap while streaming, without the unbounded reader', async () => {
    const h = harness()
    const readBody = vi.fn(async () => 'x'.repeat(65 * 1024))
    const res = fakeRes()
    const handled = await handleControlHttp(
      // Dua potongan yang masing-masing < 64 KiB: hanya akumulasi byte yang menembus batas.
      streamReq('POST', {}, ['x'.repeat(40 * 1024), 'x'.repeat(40 * 1024)]),
      res as unknown as ServerResponse,
      new URL('/api/control/spawn', 'http://x'),
      readBody,
      h.deps
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(413)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'payload_too_large' })
    expect(readBody).not.toHaveBeenCalled()
  })

  // Outcome-only assertions cannot tell "reject while streaming" from "buffer everything, then
  // reject". The reader that detaches at overflow has ZERO 'data' listeners left; a buffering
  // reader keeps exactly one until 'end', so this pins the streaming behaviour itself.
  it('detaches from the request stream as soon as the cap is exceeded', async () => {
    const h = harness()
    const readBody = vi.fn(async () => 'x'.repeat(65 * 1024))
    const res = fakeRes()
    const req = new EventEmitter() as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', headers: {}, resume() {} })
    const listenersAtOverflow: number[] = []
    process.nextTick(() => {
      req.emit('data', Buffer.alloc(70 * 1024)) // one chunk already past the cap
      listenersAtOverflow.push(req.listenerCount('data'))
      req.emit('data', Buffer.alloc(1024)) // must never be consumed
      req.emit('end')
    })
    const handled = await handleControlHttp(
      req, res as unknown as ServerResponse,
      new URL('/api/control/spawn', 'http://x'), readBody, h.deps
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(413)
    expect(listenersAtOverflow).toEqual([0])
    expect(readBody).not.toHaveBeenCalled()
  })

  it('replays a spawn on a second call with production deps (stable identity)', async () => {
    const cap = capabilityStore.mint({ verb: 'node.spawn', resource: 'node:node-b' })
    const requestId = 'req-prod-01'
    const body = JSON.stringify({ requestId, nodeId: 'node-b', agentId: 'claude' })
    const headers = { 'x-webterm-capability': cap }
    const first = fakeRes()
    await handleControlHttp(
      fakeReq('POST', headers, body),
      first as unknown as ServerResponse,
      new URL('/api/control/spawn', 'http://x'),
      async () => body
    )
    const second = fakeRes()
    await handleControlHttp(
      fakeReq('POST', headers, body),
      second as unknown as ServerResponse,
      new URL('/api/control/spawn', 'http://x'),
      async () => body
    )
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(second.body).toBe(first.body)
    expect(prod.opened).toHaveLength(1)
  })

  it('replays with a partial overrides object (merged deps memoised per identity)', async () => {
    // No `sessions`/`settings` override, so this takes the merge path (not the full-deps fast
    // path). Both calls receive the SAME overrides object, which must yield the SAME merged deps
    // object; otherwise the ack store is recreated and the second spawn hits 409 node_exists.
    const cap = capabilityStore.mint({ verb: 'node.spawn', resource: 'node:node-merge' })
    const requestId = 'req-merge-01'
    const body = JSON.stringify({ requestId, nodeId: 'node-merge', agentId: 'claude' })
    const overrides: Partial<ControlDeps> = {
      capabilities: {
        verify: (token, now = Date.now()) => capabilityStore.verify(token, now),
        allows,
        mint: (options) => ({
          token: capabilityStore.mint(options),
          expiresAt: Date.now() + clampTtl(options.ttlMs),
        }),
      },
    }
    const headers = { 'x-webterm-capability': cap }
    const first = fakeRes()
    await handleControlHttp(
      fakeReq('POST', headers, body),
      first as unknown as ServerResponse,
      new URL('/api/control/spawn', 'http://x'),
      async () => body,
      overrides
    )
    const second = fakeRes()
    await handleControlHttp(
      fakeReq('POST', headers, body),
      second as unknown as ServerResponse,
      new URL('/api/control/spawn', 'http://x'),
      async () => body,
      overrides
    )

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(second.body).toBe(first.body)
    expect(prod.opened.filter((msg) => msg.id === 'node-merge')).toHaveLength(1)
  })

  it('mints a token via the root token and accepts it afterwards', async () => {
    const h = harness({ rootToken: 'root-secret', allowTokenMint: true })
    const minted = await h.call('POST', '/api/control/token', {
      body: JSON.stringify({ verb: 'node.read', resource: '*' }),
      headers: { 'x-webterm-token': 'root-secret' },
    })
    expect(minted.res.statusCode).toBe(201)
    const body = JSON.parse(minted.res.body) as { token: string; expiresAt: number }
    expect(body.token.startsWith('wcap_')).toBe(true)
    expect(body.expiresAt).toBeGreaterThan(Date.now())

    const listed = await h.call('GET', '/api/control/nodes', {
      headers: { 'x-webterm-capability': body.token },
    })
    expect(listed.res.statusCode).toBe(200)

    // Gerbang transport (index.ts) harus meloloskan capability HANYA di keluarga control API.
    // Tanpa ini, route di atas 403 sebelum mount sempat dipanggil.
    const gate = (pathname: string): boolean =>
      authorizeRequest({
        headers: { 'x-webterm-capability': body.token },
        expectedToken: 'root-secret',
        pathname,
        isNodeToken: () => false,
        isCapabilityToken: (t) => capabilityStore.verify(t) !== undefined,
      })
    expect(gate('/api/control/nodes')).toBe(true)
    expect(gate('/api/settings')).toBe(false)
    expect(gate('/ws')).toBe(false)
  })
})
