import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ListSessionsOptions, SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CHAT_FALLBACK_COMMANDS } from '../../shared/agentChat.wire'
import type { Workspace, WsNode } from '../../shared/workspace'
import { json, routeCtx } from '../routes/route.core'
import { FakeQuery, fx } from './agentChat.fakeQuery'
import { AgentChatPool } from './agentChat.pool'
import { agentChatRoute } from './agentChat.route'

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

const ws: Workspace = {
  id: 'w1', name: 'w1', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0, cwd: '/tmp',
  nodes: ([{ id: 'chat' }, { id: 'b' }, { id: 'old', chatSessionId: 's-old' }, { id: 'term', kind: 'agent', sessionId: 's-term' }] as Array<Partial<WsNode> & { id: string }>)
    .map((n) => ({ kind: 'agentChat', x: 0, y: 0, ...n })),
}
let opens: Array<{ fq: FakeQuery; resume?: string }> = []
let pool: AgentChatPool
let listed: ListSessionsOptions[] = []
let sessionsList: SDKSessionInfo[] | Error = []
let onOpen: (fq: FakeQuery) => void = () => {}

const server: Server = createServer((req, res) => {
  const c = routeCtx(req, res, async () => {})
  void agentChatRoute(c, {
    pool,
    listSessions: async (o) => { listed.push(o); if (sessionsList instanceof Error) throw sessionsList; return sessionsList },
  }).then((handled) => { if (!handled) json(res, 404, { error: 'unknown route' }) })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-chat`
afterAll(() => { server.close() })
afterEach(() => { pool.closeAll(); opens = []; listed = []; sessionsList = []; onOpen = () => {} })
beforeEach(() => {
  pool = new AgentChatPool({
    maxLive: 1, controlTimeoutMs: 50,
    lookup: (nodeId) => { const node = ws.nodes.find((n) => n.id === nodeId); return node ? { ws, node } : undefined },
    opener: () => (resume, _c, _a, input) => { const fq = new FakeQuery(input.prompt); onOpen(fq); opens.push({ fq, resume }); return fq.asQuery() },
  })
})

const get = (path: string) => fetch(`${base}/${path}`)
const post = (path: string, body: unknown) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('agent chat control verbs', () => {
  test('GET catalog opens the Query without a turn and lists commands with the builtin flag', async () => {
    const r = await get('chat/catalog')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ commands: [
      { name: 'compact', description: 'Compact', builtin: true },
      { name: 'deploy', description: 'Ship it', argumentHint: '<env>', builtin: false },
    ] })
    expect(opens).toHaveLength(1)
    expect(pool.session('chat')?.busy()).toBe(false)
    // A second call reuses the open Query.
    expect((await get('chat/catalog')).status).toBe(200)
    expect(opens).toHaveLength(1)
  })

  test('GET models lists models with their effort levels', async () => {
    const r = await get('chat/models')
    expect(await r.json()).toEqual({ models: [
      { value: 'opus', displayName: 'Opus', description: 'Best', efforts: ['low', 'high'] },
      { value: 'haiku', displayName: 'Haiku', description: 'Fast' },
    ] })
  })

  test('catalog answers 409 + fallback when the pool is full of busy chats, without opening over the cap', async () => {
    pool.send('b', 'working')
    const r = await get('chat/catalog')
    expect(r.status).toBe(409)
    const body = await r.json() as { commands: unknown[]; reason: string }
    expect(body.commands).toEqual([...AGENT_CHAT_FALLBACK_COMMANDS])
    expect(body.reason).toContain('busy')
    expect(opens).toHaveLength(1)
  })

  test('catalog suspends an idle chat to make room', async () => {
    await get('b/catalog')
    expect((await get('chat/catalog')).status).toBe(200)
    expect(opens[0]?.fq.closed).toBe(true)
  })

  test('catalog answers 503 + fallback when Claude does not answer or fails; models answers [] ', async () => {
    onOpen = (fq) => { fq.hang = true }
    const r = await get('chat/catalog')
    expect(r.status).toBe(503)
    expect((await r.json() as { commands: unknown[] }).commands).toHaveLength(AGENT_CHAT_FALLBACK_COMMANDS.length)
    onOpen = (fq) => { fq.controlError = new Error('boom') }
    const m = await get('b/models')
    expect(m.status).toBe(503)
    const mb = await m.json() as { models: unknown[]; reason: string }
    expect(mb.models).toEqual([])
    expect(mb.reason).toContain('boom')
  })

  test('catalog refuses (409) a node whose session is locked by a terminal agent', async () => {
    const n = ws.nodes.find((x) => x.id === 'old') as WsNode
    n.chatSessionId = 's-term'
    try {
      const r = await get('old/catalog')
      expect(r.status).toBe(409)
      expect(opens).toHaveLength(0)
    } finally { n.chatSessionId = 's-old' }
  })

  test('POST config validates, applies live and emits config', async () => {
    expect((await post('chat/config', { effort: 'extreme' })).status).toBe(400)
    pool.send('chat', 'hi')
    expect((await post('chat/config', { model: 'opus', effort: 'high' })).status).toBe(200)
    expect(opens[0]?.fq.controls).toEqual(['setModel:opus', 'effort:high'])
    const ev = pool.session('chat')?.events(0).filter((e) => e.t === 'config').at(-1)
    expect(ev).toMatchObject({ config: { model: 'opus', effort: 'high', thinking: true } })
    ;(opens[0]?.fq as FakeQuery).controlError = new Error('nope')
    const bad = await post('chat/config', { thinking: false })
    expect(bad.status).toBe(502)
    expect((await bad.json() as { reason: string }).reason).toContain('Turning thinking off failed')
  })

  test('GET sessions lists the node cwd, newest first, current marked; read errors are 502', async () => {
    sessionsList = [{ sessionId: 's-old', summary: 'Old one', lastModified: 1 }, { sessionId: 's-x', summary: 'Newer', lastModified: 5 }]
    const r = await get('old/sessions')
    expect(await r.json()).toEqual({ sessions: [
      { sessionId: 's-x', title: 'Newer', updatedAt: 5, current: false },
      { sessionId: 's-old', title: 'Old one', updatedAt: 1, current: true },
    ] })
    expect(listed[0]).toMatchObject({ dir: '/tmp' })
    sessionsList = new Error('EACCES')
    expect((await get('old/sessions')).status).toBe(502)
  })

  test('POST resume switches the conversation; a locked or invalid id is refused', async () => {
    expect((await post('chat/resume', { sessionId: '../x' })).status).toBe(400)
    const locked = await post('chat/resume', { sessionId: 's-term' })
    expect(locked.status).toBe(409)
    expect(((await locked.json()) as { error: string }).error).toBe('session_locked')
    pool.send('old', 'hi') // 'old' holds s-old
    expect((await post('chat/resume', { sessionId: 's-old' })).status).toBe(409)
    const r = await post('chat/resume', { sessionId: 's-7' })
    expect(r.status).toBe(200)
    expect(pool.sessionId('chat')).toBe('s-7')
    expect(pool.lock.owner('s-7')).toBe('chat')
    expect(pool.session('chat')?.events(0).find((e) => e.t === 'reset')).toMatchObject({ sessionId: 's-7' })
  })

  test('resume / new are refused while a turn runs; new starts a fresh session and frees the old id', async () => {
    pool.send('old', 'hi')
    const busy = await post('old/new', {})
    expect(busy.status).toBe(409)
    expect(((await busy.json()) as { error: string }).error).toBe('busy')
    opens[0]?.fq.emit(fx.result())
    await tick()
    expect((await post('old/new', {})).status).toBe(200)
    expect(pool.sessionId('old')).toBe(undefined)
    expect(pool.lock.owner('s-old')).toBe(undefined)
    pool.send('old', 'fresh')
    expect(opens.at(-1)?.resume).toBe(undefined)
  })

  test('control verbs check their method and the node', async () => {
    expect((await post('chat/catalog', {})).status).toBe(405)
    expect((await get('nope/catalog')).status).toBe(404)
  })
})
