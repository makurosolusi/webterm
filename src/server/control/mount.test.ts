// Test jembatan HTTP control plane. Deps disuntik penuh supaya tidak ada impor `bun:sqlite`/PTY;
// capability memakai store NYATA dari mount.ts agar jalur mint -> verify ikut teruji.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { mergeSettings } from '../../shared/settings'
import type { OpenMsg } from '../../shared/protocol'
import { allows, clampTtl, type CapabilityVerb } from './capabilities'
import type { ControlDeps, ControlExit, ControlSessionInfo } from './controlTypes'
import { capabilityStore, handleControlHttp } from './mount'

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

const fakeReq = (method: string, headers: Record<string, string> = {}) =>
  ({ method, headers }) as unknown as IncomingMessage

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
      fakeReq(method, opts.headers),
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

  it('treats invalid JSON bodies as an empty object', async () => {
    const h = harness()
    const { res } = await h.call('POST', '/api/control/spawn', { body: '{not json' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_request_id' })
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
  })
})
