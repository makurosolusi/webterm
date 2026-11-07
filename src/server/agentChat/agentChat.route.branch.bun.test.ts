import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ForkSessionOptions, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import type { Workspace, WsNode } from '../../shared/workspace'
import { json, routeCtx } from '../routes/route.core'
import { FakeQuery, fx } from './agentChat.fakeQuery'
import { AgentChatPool } from './agentChat.pool'
import { agentChatRoute } from './agentChat.route'
import { forkPoint } from './agentChat.route.branch'

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

const ws: Workspace = {
  id: 'w1', name: 'w1', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0, cwd: '/tmp',
  nodes: ([{ id: 'chat', chatSessionId: 's-1' }, { id: 'fresh' }] as Array<Partial<WsNode> & { id: string }>).map((n) => ({ kind: 'agentChat', x: 0, y: 0, ...n })),
}
const entry = (type: 'user' | 'assistant', uuid: string, content: unknown): SessionMessage =>
  ({ type, uuid, session_id: 's-1', parent_tool_use_id: null, parent_agent_id: null, message: { role: type, content } })
const transcript: SessionMessage[] = [
  entry('user', 'u-1', 'first'), entry('assistant', 'a-1', [{ type: 'text', text: 'one' }]),
  entry('user', 'u-2', 'second'), entry('assistant', 'a-2', [{ type: 'text', text: 'two' }]),
]

let opens: Array<{ fq: FakeQuery; resume?: string }> = []
let forks: Array<{ id: string; o?: ForkSessionOptions }> = []
let pool: AgentChatPool

const server: Server = createServer((req, res) => {
  const c = routeCtx(req, res, async () => {})
  void agentChatRoute(c, {
    pool,
    load: async () => transcript,
    forkSession: async (id, o) => { forks.push({ id, ...(o ? { o } : {}) }); return { sessionId: 's-fork' } },
  }).then((handled) => { if (!handled) json(res, 404, { error: 'unknown route' }) })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-chat`
afterAll(() => { server.close() })
afterEach(() => { pool.closeAll(); opens = []; forks = [] })
beforeEach(() => {
  pool = new AgentChatPool({
    controlTimeoutMs: 200,
    lookup: (nodeId) => { const node = ws.nodes.find((n) => n.id === nodeId); return node ? { ws, node } : undefined },
    opener: () => (resume, _c, _a, input) => { const fq = new FakeQuery(input.prompt); opens.push({ fq, resume }); return fq.asQuery() },
  })
})

const post = (path: string, body: unknown) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const record = (nodeId: string): AgentChatEvent[] => {
  const out: AgentChatEvent[] = []
  pool.session(nodeId)?.subscribe((e) => out.push(e))
  return out
}

describe('POST rewind', () => {
  test('a dry run previews the files and changes nothing; the real one rewinds and leaves a notice', async () => {
    const events = record('chat')
    const dry = await post('chat/rewind', { messageId: 'u-2', dryRun: true })
    expect(dry.status).toBe(200)
    expect(await dry.json()).toEqual({ canRewind: true, filesChanged: ['/work/a.ts'], insertions: 3, deletions: 1 })
    expect(opens[0]?.fq.controls).toEqual(['rewind:u-2:dry'])
    expect(opens[0]?.resume).toBe('s-1')
    expect(events.some((e) => e.t === 'notice')).toBe(false)

    const real = await post('chat/rewind', { messageId: 'u-2' })
    expect(real.status).toBe(200)
    expect(opens[0]?.fq.controls).toEqual(['rewind:u-2:dry', 'rewind:u-2'])
    const notice = events.find((e): e is Extract<AgentChatEvent, { t: 'notice' }> => e.t === 'notice')
    expect(notice?.level).toBe('info')
    expect(notice?.text).toContain('Rewound 1 file')
  })

  test('a checkpoint the CLI cannot restore answers canRewind false with its reason', async () => {
    pool.session('chat')?.warm()
    const fq = opens[0]?.fq as FakeQuery
    fq.rewind = { canRewind: false, error: 'No file checkpoint found for this message' }
    const r = await post('chat/rewind', { messageId: 'u-1', dryRun: true })
    expect(await r.json()).toEqual({ canRewind: false, error: 'No file checkpoint found for this message', filesChanged: [], insertions: 0, deletions: 0 })
  })

  test('refused while a turn runs, for a bad id and for a bad dryRun', async () => {
    expect((await post('chat/rewind', { messageId: '../x' })).status).toBe(400)
    expect((await post('chat/rewind', { messageId: 'u-1', dryRun: 'yes' })).status).toBe(400)
    pool.send('chat', 'working')
    const r = await post('chat/rewind', { messageId: 'u-1', dryRun: true })
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: string }).error).toBe('busy')
  })

  test('a failing control answers 503 with the cause', async () => {
    pool.session('chat')?.warm()
    ;(opens[0]?.fq as FakeQuery).controlError = new Error('ProcessTransport is not ready for writing')
    const r = await post('chat/rewind', { messageId: 'u-1', dryRun: true })
    expect(r.status).toBe(503)
    expect(((await r.json()) as { reason: string }).reason).toContain('ProcessTransport')
  })
})

describe('POST fork', () => {
  test('forkPoint: the entry before the message, none for the first, undefined when unknown', () => {
    expect(forkPoint(transcript, 'u-2')).toEqual({ upTo: 'a-1' })
    expect(forkPoint(transcript, 'u-1')).toEqual({})
    expect(forkPoint(transcript, 'nope')).toBe(undefined)
  })

  test('editing a later message forks up to the reply before it, switches the node and sends the new text there', async () => {
    const events = record('chat')
    const r = await post('chat/fork', { messageId: 'u-2', text: 'second, edited' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, sessionId: 's-fork' })
    expect(forks).toEqual([{ id: 's-1', o: { upToMessageId: 'a-1' } }])
    expect(pool.sessionId('chat')).toBe('s-fork')
    expect(events.find((e) => e.t === 'reset')).toMatchObject({ sessionId: 's-fork' })
    await tick()
    expect(opens.at(-1)?.resume).toBe('s-fork')
    expect(opens.at(-1)?.fq.prompts.map((p) => p.message.content)).toEqual(['second, edited'])
  })

  test('editing the first message starts a fresh conversation (nothing to keep)', async () => {
    const r = await post('chat/fork', { messageId: 'u-1', text: 'first, edited' })
    expect(r.status).toBe(200)
    expect(forks).toEqual([])
    expect(pool.sessionId('chat')).toBe(undefined)
    await tick()
    expect(opens.at(-1)?.resume).toBe(undefined)
  })

  test('unknown message 404, no transcript 404, busy 409, empty text 400', async () => {
    expect((await post('chat/fork', { messageId: 'nope', text: 'x' })).status).toBe(404)
    expect((await post('fresh/fork', { messageId: 'u-1', text: 'x' })).status).toBe(404)
    expect((await post('chat/fork', { messageId: 'u-1', text: '  ' })).status).toBe(400)
    pool.send('chat', 'working')
    expect((await post('chat/fork', { messageId: 'u-1', text: 'x' })).status).toBe(409)
    expect(forks).toEqual([])
  })
})

describe('POST stoptask', () => {
  test('stops a task on the live Query; 409 when no Query is open; 400 for a bad id', async () => {
    expect((await post('chat/stoptask', { taskId: 't1' })).status).toBe(409)
    pool.send('chat', 'go')
    const fq = opens[0]?.fq as FakeQuery
    fq.emit(fx.init(), fx.task('task_started', 't1', { description: 'Explore' }))
    await tick()
    expect((await post('chat/stoptask', { taskId: 't1' })).status).toBe(200)
    expect(fq.controls).toEqual(['stopTask:t1'])
    expect((await post('chat/stoptask', { taskId: 'a b' })).status).toBe(400)
    fq.controlError = new Error('no such task')
    expect((await post('chat/stoptask', { taskId: 't1' })).status).toBe(502)
  })
})
