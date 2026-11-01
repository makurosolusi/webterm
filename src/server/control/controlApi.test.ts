// Test control API dengan sesi & capability palsu. Capability memakai implementasi NYATA
// (`CapabilityStore` + `allows`) supaya matriks scope/expiry menguji modul yang dipakai produksi;
// hanya PTY dan waktu yang dipalsukan.

import { describe, expect, it } from 'vitest'
import type { OpenMsg } from '../../shared/protocol'
import { mergeSettings } from '../../shared/settings'
import type { AgentStatus } from '../../shared/workspace'
import { CapabilityStore, allows, clampTtl, type CapabilityVerb } from './capabilities'
import { handleControl } from './controlApi'
import type { ControlDeps, ControlExit, ControlSessionInfo } from './controlTypes'

interface FakeNode {
  status?: AgentStatus
  exit?: ControlExit
  output: string
}

function harness(overrides: Partial<ControlDeps> = {}) {
  const clock = { t: 1_000_000 }
  const live = new Map<string, FakeNode>()
  const opened: OpenMsg[] = []
  const inputs: { id: string; data: string }[] = []
  const closed: string[] = []
  const store = new CapabilityStore()

  const deps: ControlDeps = {
    sessions: {
      open(msg) {
        opened.push(msg)
        live.set(msg.id, { output: '' })
      },
      input(id, data) {
        inputs.push({ id, data })
      },
      close(id) {
        closed.push(id)
        live.delete(id)
      },
      list(): ControlSessionInfo[] {
        return [...live.entries()].map(([id, node], i) => ({ id, pid: i + 1, status: node.status }))
      },
      statusOf(id) {
        return live.get(id)?.status
      },
      getExit(id) {
        return live.get(id)?.exit
      },
      getTerminal(id) {
        return live.get(id)?.output ?? ''
      },
      isLive(id) {
        return live.has(id)
      },
    },
    capabilities: {
      verify: (token, now = clock.t) => store.verify(token, now),
      allows,
      mint: (opts) => ({
        token: store.mint(opts, clock.t),
        expiresAt: clock.t + clampTtl(opts.ttlMs),
      }),
    },
    settings: () => mergeSettings({ agentLaunchCommands: { claude: 'claude-work' } }),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms
    },
    ...overrides,
  }

  const token = (verb: CapabilityVerb, resource: string, ttlMs?: number) =>
    store.mint({ verb, resource, ...(ttlMs === undefined ? {} : { ttlMs }) }, clock.t)
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handleControl(
      { method, path: `/api/control/${path}`, headers, ...(body === undefined ? {} : { body }) },
      deps
    )

  return { deps, live, opened, inputs, closed, clock, token, call }
}

const spawnBody = (requestId = 'req-0001', nodeId = 'node-a') => ({
  requestId,
  nodeId,
  agentId: 'claude',
})

describe('control auth', () => {
  it('rejects missing, unknown, and expired capabilities with 401', async () => {
    const h = harness()
    expect(await h.call('POST', 'spawn', spawnBody())).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    })
    const bot = await h.call('POST', 'spawn', spawnBody(), { 'x-webterm-capability': 'wcap_nope' })
    expect(bot?.status).toBe(401)
    const expired = h.token('node.spawn', 'node:node-a', 1)
    h.clock.t += 10
    const res = await h.call('POST', 'spawn', spawnBody(), { 'x-webterm-capability': expired })
    expect(res?.status).toBe(401)
  })

  it('never accepts a capability in x-webterm-token', async () => {
    const h = harness()
    const good = h.token('node.spawn', 'node:node-a')
    const res = await h.call('POST', 'spawn', spawnBody(), { 'x-webterm-token': good })
    expect(res?.status).toBe(401)
  })

  it('rejects wrong verb and wrong node resource with 403', async () => {
    const h = harness()
    const promptOnly = h.token('node.prompt', 'node:node-a')
    expect((await h.call('POST', 'spawn', spawnBody(), { 'x-webterm-capability': promptOnly }))?.status)
      .toBe(403)
    const otherNode = h.token('node.spawn', 'node:node-b')
    expect((await h.call('POST', 'spawn', spawnBody(), { 'x-webterm-capability': otherNode }))?.status)
      .toBe(403)
    expect(h.opened).toHaveLength(0)
  })

  it('returns null for paths outside the control family', async () => {
    const h = harness()
    expect(await handleControl({ method: 'GET', path: '/api/settings' }, h.deps)).toBeNull()
    expect(await h.call('DELETE', 'nodes')).toBeNull()
  })
})
describe('spawn', () => {
  it('opens a node through sessions.open with the configured launch command', async () => {
    const h = harness()
    const res = await h.call('POST', 'spawn', spawnBody(), {
      'x-webterm-capability': h.token('node.spawn', 'node:node-a'),
    })
    expect(res).toEqual({ status: 201, body: { ok: true, requestId: 'req-0001', nodeId: 'node-a' } })
    expect(h.opened).toHaveLength(1)
    expect(h.opened[0]).toMatchObject({
      t: 'open',
      id: 'node-a',
      cols: 80,
      rows: 24,
      cmd: 'claude-work',
      agentId: 'claude',
    })
  })

  it('honours explicit size + cwd and ignores a raw cmd in the body', async () => {
    const h = harness()
    const cap = h.token('node.spawn', 'node:node-a')
    const res = await h.call(
      'POST',
      'spawn',
      { ...spawnBody(), cols: 100, rows: 40, cwd: '/tmp/work', cmd: 'rm -rf /' },
      { 'x-webterm-capability': cap }
    )
    expect(res?.status).toBe(201)
    expect(h.opened[0]).toMatchObject({ cols: 100, rows: 40, cwd: '/tmp/work', cmd: 'claude-work' })
  })

  it('replays a duplicate requestId without a second PTY (10 minute window)', async () => {
    const h = harness()
    const cap = h.token('node.spawn', 'node:node-a')
    const body = spawnBody()
    const first = await h.call('POST', 'spawn', body, { 'x-webterm-capability': cap })
    const second = await h.call('POST', 'spawn', body, { 'x-webterm-capability': cap })
    expect(second).toEqual(first)
    expect(h.opened).toHaveLength(1)
    // Lewat jendela: ack kedaluwarsa, node masih hidup -> 409, bukan spawn kedua.
    h.clock.t += 10 * 60 * 1000
    const late = await h.call('POST', 'spawn', body, { 'x-webterm-capability': cap })
    expect(late?.status).toBe(409)
    expect(h.opened).toHaveLength(1)
  })

  it('validates requestId, nodeId, agent, size, cwd, and liveness', async () => {
    const h = harness()
    const cap = h.token('node.spawn', 'node:node-a')
    const headers = { 'x-webterm-capability': cap }
    expect((await h.call('POST', 'spawn', { ...spawnBody('short') }, headers))?.status).toBe(400)
    expect((await h.call('POST', 'spawn', { ...spawnBody(), nodeId: '../evil' }, headers))?.status).toBe(400)
    expect((await h.call('POST', 'spawn', { ...spawnBody(), agentId: 'custom:x' }, headers))?.status).toBe(400)
    expect((await h.call('POST', 'spawn', { ...spawnBody(), cols: 0 }, headers))?.status).toBe(400)
    expect((await h.call('POST', 'spawn', { ...spawnBody(), cwd: 'relative/dir' }, headers))?.status).toBe(400)
    h.live.set('node-a', { output: '' })
    expect((await h.call('POST', 'spawn', spawnBody(), headers))?.status).toBe(409)
    expect(h.opened).toHaveLength(0)
  })

  it('enforces deps.cwdAllowed', async () => {
    const h = harness({ cwdAllowed: (cwd) => cwd.startsWith('/srv/project') })
    const cap = h.token('node.spawn', 'node:node-a')
    const res = await h.call('POST', 'spawn', { ...spawnBody(), cwd: '/etc' }, {
      'x-webterm-capability': cap,
    })
    expect(res).toEqual({ status: 403, body: { error: 'cwd_not_allowed' } })
    expect(h.opened).toHaveLength(0)
  })
})
describe('prompt', () => {
  const prompt = (requestId = 'req-0002', extra: Record<string, unknown> = {}) => ({
    requestId,
    nodeId: 'node-a',
    text: 'hello',
    ...extra,
  })

  it('writes text plus CR, or without submit:false', async () => {
    const h = harness()
    h.live.set('node-a', { output: '' })
    const cap = h.token('node.prompt', 'node:node-a')
    const headers = { 'x-webterm-capability': cap }
    expect((await h.call('POST', 'prompt', prompt(), headers))?.status).toBe(200)
    expect((await h.call('POST', 'prompt', prompt('req-0003', { submit: false }), headers))?.status)
      .toBe(200)
    expect(h.inputs).toEqual([
      { id: 'node-a', data: 'hello\r' },
      { id: 'node-a', data: 'hello' },
    ])
  })

  it('replays duplicate requestId without writing twice', async () => {
    const h = harness()
    h.live.set('node-a', { output: '' })
    const cap = h.token('node.prompt', 'node:node-a')
    const headers = { 'x-webterm-capability': cap }
    await h.call('POST', 'prompt', prompt(), headers)
    await h.call('POST', 'prompt', prompt(), headers)
    expect(h.inputs).toHaveLength(1)
  })

  it('returns 404 for a dead node, 413 for oversized text, 400 for bad text', async () => {
    const h = harness()
    const cap = h.token('node.prompt', 'node:node-a')
    const headers = { 'x-webterm-capability': cap }
    expect((await h.call('POST', 'prompt', prompt(), headers))?.status).toBe(404)
    h.live.set('node-a', { output: '' })
    const big = await h.call('POST', 'prompt', prompt('req-0004', { text: 'x'.repeat(32_769) }), headers)
    expect(big?.status).toBe(413)
    expect((await h.call('POST', 'prompt', prompt('req-0005', { text: 5 }), headers))?.status).toBe(400)
    expect(h.inputs).toHaveLength(0)
  })
})
describe('close', () => {
  it('closes once and is idempotent per requestId', async () => {
    const h = harness()
    h.live.set('node-a', { output: '' })
    const cap = h.token('node.close', 'node:node-a')
    const headers = { 'x-webterm-capability': cap }
    const first = await h.call('POST', 'close', { requestId: 'req-0006', nodeId: 'node-a' }, headers)
    expect(first).toEqual({ status: 200, body: { ok: true, requestId: 'req-0006', nodeId: 'node-a', closed: true } })
    const replay = await h.call('POST', 'close', { requestId: 'req-0006', nodeId: 'node-a' }, headers)
    expect(replay).toEqual(first)
    const second = await h.call('POST', 'close', { requestId: 'req-0007', nodeId: 'node-a' }, headers)
    expect((second?.body as { closed: boolean }).closed).toBe(false)
    expect(h.closed).toEqual(['node-a', 'node-a'])
  })
})

describe('wait', () => {
  it('returns immediately for an existing exit tombstone', async () => {
    const h = harness()
    h.live.set('node-a', { output: 'bye', exit: { code: 0, reason: 'self' } })
    const cap = h.token('node.wait', 'node:node-a')
    const start = h.clock.t
    const res = await h.call('POST', 'wait', { nodeId: 'node-a' }, { 'x-webterm-capability': cap })
    expect(res).toEqual({ status: 200, body: { state: 'exited', exited: { code: 0, reason: 'self' }, output: 'bye' } })
    expect(h.clock.t).toBe(start)
  })

  it('times out after the requested budget', async () => {
    const h = harness()
    h.live.set('node-a', { output: 'working' })
    const cap = h.token('node.wait', 'node:node-a')
    const res = await h.call(
      'POST',
      'wait',
      { nodeId: 'node-a', until: 'exit', timeoutMs: 300 },
      { 'x-webterm-capability': cap }
    )
    expect(res).toEqual({ status: 200, body: { state: 'timeout', timeout: true, output: 'working' } })
    expect(h.clock.t).toBe(1_000_300)
  })

  it('waits for status:done', async () => {
    let polls = 0
    const h = harness({
      sleep: async (ms) => {
        h.clock.t += ms
        polls += 1
        if (polls === 2) h.live.get('node-a')!.status = 'done'
      },
    })
    h.live.set('node-a', { output: '' })
    const cap = h.token('node.wait', 'node:node-a')
    const res = await h.call(
      'POST',
      'wait',
      { nodeId: 'node-a', until: 'status:done', timeoutMs: 1000 },
      { 'x-webterm-capability': cap }
    )
    expect(res?.body).toEqual({ state: 'done', output: '' })
  })

  it('detects idle when the terminal buffer stops changing', async () => {
    const h = harness()
    h.live.set('node-a', { output: 'prompt $ ' })
    const cap = h.token('node.wait', 'node:node-a')
    const res = await h.call(
      'POST',
      'wait',
      { nodeId: 'node-a', until: 'idle', timeoutMs: 1000 },
      { 'x-webterm-capability': cap }
    )
    expect(res?.body).toEqual({ state: 'idle', output: 'prompt $ ' })
  })

  it('validates until/timeout and rejects unknown nodes', async () => {
    const h = harness()
    h.live.set('node-a', { output: '' })
    const cap = h.token('node.wait', 'node:node-a')
    const headers = { 'x-webterm-capability': cap }
    expect((await h.call('POST', 'wait', { nodeId: 'node-a', until: 'nope' }, headers))?.status).toBe(400)
    expect((await h.call('POST', 'wait', { nodeId: 'node-a', timeoutMs: 25_001 }, headers))?.status).toBe(400)
    const other = h.token('node.wait', 'node:node-b')
    expect((await h.call('POST', 'wait', { nodeId: 'node-b' }, { 'x-webterm-capability': other }))?.status).toBe(404)
  })
})
describe('nodes', () => {
  it('lists all live nodes for a * grant and filters for node:<id>', async () => {
    const h = harness()
    h.live.set('node-a', { output: '' })
    h.live.set('node-b', { output: '' })
    const all = await h.call('GET', 'nodes', undefined, {
      'x-webterm-capability': h.token('node.read', '*'),
    })
    expect((all?.body as { id: string }[]).map((n) => n.id)).toEqual(['node-a', 'node-b'])
    const one = await h.call('GET', 'nodes', undefined, {
      'x-webterm-capability': h.token('node.read', 'node:node-b'),
    })
    expect((one?.body as { id: string }[]).map((n) => n.id)).toEqual(['node-b'])
  })

  it('requires a node.read capability', async () => {
    const h = harness()
    expect((await h.call('GET', 'nodes'))?.status).toBe(401)
    const res = await h.call('GET', 'nodes', undefined, {
      'x-webterm-capability': h.token('node.spawn', 'node:node-a'),
    })
    expect(res?.status).toBe(403)
  })
})

describe('plan', () => {
  it('answers 501 with plan.read and 403 with a node.read grant', async () => {
    const h = harness()
    const plan = await h.call('GET', 'plan', undefined, {
      'x-webterm-capability': h.token('plan.read', 'project:p1'),
    })
    expect(plan).toEqual({ status: 501, body: { error: 'plan_not_available' } })
    const wrong = await h.call('GET', 'plan', undefined, {
      'x-webterm-capability': h.token('node.read', '*'),
    })
    expect(wrong?.status).toBe(403)
  })
})

describe('token mint gate', () => {
  const body = { verb: 'node.spawn', resource: 'node:node-a' }

  it('is 404 unless the feature flag and root token are configured', async () => {
    const off = harness()
    expect((await off.call('POST', 'token', body, { 'x-webterm-token': 'root' }))?.status).toBe(404)
    const noRoot = harness({ allowTokenMint: true })
    expect((await noRoot.call('POST', 'token', body, { 'x-webterm-token': 'root' }))?.status).toBe(404)
  })

  it('rejects a wrong root token with 403', async () => {
    const h = harness({ allowTokenMint: true, rootToken: 'root-secret' })
    expect((await h.call('POST', 'token', body, { 'x-webterm-token': 'nope' }))?.status).toBe(403)
  })

  it('mints a token for a valid grant', async () => {
    const h = harness({ allowTokenMint: true, rootToken: 'root-secret' })
    const res = await h.call('POST', 'token', { ...body, ttlMs: 60_000 }, {
      'x-webterm-token': 'root-secret',
    })
    expect(res?.status).toBe(201)
    const minted = res?.body as { token: string; expiresAt: number }
    expect(minted.token.startsWith('wcap_')).toBe(true)
    expect(minted.expiresAt).toBe(h.clock.t + 60_000)
  })

  it('rejects invalid verb/resource/ttl', async () => {
    const h = harness({ allowTokenMint: true, rootToken: 'root-secret' })
    const headers = { 'x-webterm-token': 'root-secret' }
    expect((await h.call('POST', 'token', { ...body, verb: 'nope' }, headers))?.status).toBe(400)
    expect((await h.call('POST', 'token', { ...body, resource: 'wat' }, headers))?.status).toBe(400)
    expect((await h.call('POST', 'token', { ...body, resource: '*' }, headers))?.status).toBe(400)
    expect((await h.call('POST', 'token', { ...body, ttlMs: 0 }, headers))?.status).toBe(400)
  })
})
