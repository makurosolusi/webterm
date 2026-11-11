// Locks the `Idempotency-Key` replay of agent chat send: a retried send creates one message.
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Workspace, WsNode } from '../../shared/workspace'
import { json, routeCtx } from '../routes/route.core'
import { FakeQuery } from './agentChat.fakeQuery'
import { AgentChatPool } from './agentChat.pool'
import { agentChatRoute } from './agentChat.route'
import { createIdempotency, type Idempotency } from './agentChat.idempotency'

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))
const ws: Workspace = { // test-only
  id: 'w1', name: 'w1', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: [{ id: 'chat', kind: 'agentChat', x: 0, y: 0 } as WsNode],
}
const opens: FakeQuery[] = []
let pool: AgentChatPool
let clock = 0
let idem: Idempotency

const server: Server = createServer((req, res) => {
  const c = routeCtx(req, res, async () => {})
  void agentChatRoute(c, { pool, idempotency: idem, load: async () => [] }).then((handled) => { if (!handled) json(res, 404, {}) })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-chat`
afterAll(() => { server.close() })
afterEach(() => { pool.closeAll(); opens.length = 0 })
beforeEach(() => {
  clock = 0
  idem = createIdempotency({ ttlMs: 1000, max: 2, now: () => clock })
  pool = new AgentChatPool({
    lookup: (nodeId) => { const node = ws.nodes.find((n) => n.id === nodeId); return node ? { ws, node } : undefined },
    opener: () => (_resume, _canUseTool, _abort, input) => { const fq = new FakeQuery(input.prompt); opens.push(fq); return fq.asQuery() },
  })
})

const send = (text: string, key?: string) => fetch(`${base}/chat/send`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify({ text }),
})
const prompts = (): unknown[] => opens.flatMap((fq) => fq.prompts.map((p) => p.message.content))

describe('agent chat send idempotency', () => {
  test('a retried send with the same key creates one message and replays the first answer', async () => {
    const [a, b] = await Promise.all([send('hello', 'key-00000001'), send('hello', 'key-00000001')]) // concurrent retry too
    const c = await send('hello', 'key-00000001')
    for (const r of [a, b, c]) {
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ ok: true })
    }
    await tick(10)
    expect(prompts()).toEqual(['hello'])
  })

  test('different keys, no key, and a key after its TTL each send', async () => {
    await send('one', 'key-00000001')
    await send('two', 'key-00000002')
    await send('three')
    clock = 5000 // past the TTL: the key is forgotten
    await send('again', 'key-00000001')
    await tick(10)
    expect(prompts()).toEqual(['one', 'two', 'three', 'again'])
  })

  test('a refused send is not remembered: its retry runs again', async () => {
    const bad = await fetch(`${base}/chat/send`, { method: 'POST', headers: { 'idempotency-key': 'key-00000009' }, body: '{"text":5}' })
    expect(bad.status).toBe(400)
    expect((await send('fixed', 'key-00000009')).status).toBe(200)
    await tick(10)
    expect(prompts()).toEqual(['fixed'])
  })

  test('a malformed key is ignored (no dedupe, no 400)', async () => {
    await send('a', 'short')
    await send('b', 'short')
    await tick(10)
    expect(prompts()).toEqual(['a', 'b'])
  })
})
