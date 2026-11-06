import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CanUseTool, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import type { Workspace, WsNode } from '../../shared/workspace'
import { buildLinkDoc } from '../contextLinkRoute'
import { json, routeCtx } from '../routes/route.core'
import { FakeQuery, fx } from './agentChat.fakeQuery'
import { AgentChatPool } from './agentChat.pool'
import { AGENT_CHAT_BODY_MAX_BYTES, AGENT_CHAT_TEXT_MAX, agentChatRoute, type AgentChatRouteDeps } from './agentChat.route'
import { AGENT_CHAT_EVENT_LOG_MAX, type AgentChatSession } from './agentChat.session'
import { AGENT_CHAT_SEND_BODY_MAX_BYTES } from './agentChat.route.attach'
import { AGENT_CHAT_IMAGES_MAX, AGENT_CHAT_IMAGE_MAX_B64 } from '../../shared/agentChat.wire'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' // test-only 1x1
const uploads = mkdtempSync(join(tmpdir(), 'agent-chat-up-'))

const HEARTBEAT_MS = 20
const CYCLES = 8
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

const ws: Workspace = {
  id: 'w1', name: 'w1', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: ([{ id: 'chat' }, { id: 'old', chatSessionId: 's-old' }, { id: 'term', kind: 'terminal' }] as Array<Partial<WsNode> & { id: string }>)
    .map((n) => ({ kind: 'agentChat', x: 0, y: 0, ...n })),
}
const opens: Array<{ fq: FakeQuery; canUseTool: CanUseTool }> = []
let transcript: SessionMessage[] | Error = []
let pool: AgentChatPool
const deps = (): AgentChatRouteDeps => ({
  pool, heartbeatMs: HEARTBEAT_MS, uploadsDir: uploads,
  load: async () => { if (transcript instanceof Error) throw transcript; return transcript },
})

// The bun:test shim has no beforeAll: the server listens at module load (top-level await).
const server: Server = createServer((req, res) => {
  const c = routeCtx(req, res, async () => {})
  void agentChatRoute(c, deps()).then((handled) => { if (!handled) json(res, 404, { error: 'unknown route' }) })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-chat`
afterAll(() => { server.close(); rmSync(uploads, { recursive: true, force: true }) })
afterEach(() => { pool.closeAll(); opens.length = 0; transcript = [] })
// A fresh pool per test; deps() reads `pool` per request so it always sees the current one.
beforeEach(() => {
  pool = new AgentChatPool({
    lookup: (nodeId) => { const node = ws.nodes.find((n) => n.id === nodeId); return node ? { ws, node } : undefined },
    opener: () => (_resume, canUseTool, _abort, input) => { const fq = new FakeQuery(input.prompt); opens.push({ fq, canUseTool }); return fq.asQuery() },
  })
})

const post = (path: string, body: unknown) =>
  fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })

const frames = (text: string): AgentChatEvent[] =>
  text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter((l): l is string => !!l).map((l) => JSON.parse(l.slice(6)))

/** Open an SSE stream and read until `until(text)`; close() drops the connection. */
async function stream(query: string, until: (text: string) => boolean) {
  const ctl = new AbortController()
  const r = await fetch(`${base}/chat/stream${query}`, { signal: ctl.signal })
  const reader = (r.body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let text = ''
  while (!until(text)) {
    const { value, done } = await reader.read()
    if (done) break
    text += dec.decode(value)
  }
  return { r, text, events: frames(text), close: () => ctl.abort() }
}

/** Live subscriber count of a session, by wrapping its subscribe. */
function countSubs(s: AgentChatSession): () => number {
  let live = 0
  const orig = s.subscribe.bind(s)
  s.subscribe = (fn) => { live++; const off = orig(fn); return () => { live--; off() } }
  return () => live
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await tick(10)
}

describe('agent chat route', () => {
  test('unknown node, non-chat node, unknown verb and wrong method', async () => {
    expect((await fetch(`${base}/nope/stream`)).status).toBe(404)
    expect((await fetch(`${base}/term/stream`)).status).toBe(404)
    expect((await fetch(`${base}/%E0%A4%A/stream`)).status).toBe(404)
    expect((await fetch(`${base}/chat/explode`)).status).toBe(404)
    expect((await fetch(`${base}/chat`)).status).toBe(404)
    const r = await fetch(`${base}/chat/send`)
    expect(r.status).toBe(405)
    expect(await r.json()).toMatchObject({ error: 'method_not_allowed' })
  })

  test('send validates at the boundary, caps the body and reaches the Query', async () => {
    expect((await post('chat/send', {})).status).toBe(400)
    expect((await post('chat/send', { text: '   ' })).status).toBe(400)
    expect((await post('chat/send', { text: 'x'.repeat(AGENT_CHAT_TEXT_MAX + 1) })).status).toBe(400)
    expect((await post('chat/send', { text: 'hi', priority: 'later' })).status).toBe(400)
    expect((await post('chat/send', 'not json')).status).toBe(400)
    expect((await post('chat/send', [1])).status).toBe(400)
    expect((await post('chat/send', { text: 'y'.repeat(AGENT_CHAT_SEND_BODY_MAX_BYTES) })).status).toBe(413)
    expect((await post('chat/mode', { mode: 'y'.repeat(AGENT_CHAT_BODY_MAX_BYTES) })).status).toBe(413)
    expect(opens).toHaveLength(0)
    const r = await post('chat/send', { text: 'hello' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
    await tick()
    expect(opens[0]?.fq.prompts.map((p) => p.message.content)).toEqual(['hello'])
  })

  test('mode accepts the permission mode set only; interrupt answers ok', async () => {
    expect((await post('chat/mode', { mode: 'yolo' })).status).toBe(400)
    expect((await post('chat/mode', { mode: 'plan' })).status).toBe(200)
    expect(pool.session('chat')?.events(0).at(-1)).toMatchObject({ t: 'mode', mode: 'plan' })
    expect((await post('chat/interrupt', {})).status).toBe(200)
  })

  test('stream replays after the seq, goes live and heartbeats', async () => {
    await post('chat/send', { text: 'one' })
    const s = pool.session('chat') as AgentChatSession
    const last = s.events(0).at(-1)?.seq ?? 0
    s.notify('info', 'after cursor')
    const st = stream(`?after=${last}`, (t) => t.includes('live one') && t.includes(': heartbeat'))
    await tick(5)
    s.notify('info', 'live one')
    const { r, events, close } = await st
    expect(r.headers.get('content-type')).toBe('text/event-stream')
    expect(events.map((e) => e.t === 'notice' && e.text)).toEqual(['after cursor', 'live one'])
    expect(events.every((e) => e.seq > last)).toBe(true)
    close()
    expect((await fetch(`${base}/chat/stream?after=-1`)).status).toBe(400)
  })

  test(`no subscriber leak after ${CYCLES} connect/disconnect cycles`, async () => {
    const s = pool.session('chat') as AgentChatSession
    const live = countSubs(s)
    for (let i = 0; i < CYCLES; i++) {
      s.notify('info', `n${i}`)
      const { close } = await stream('?after=0', (t) => t.includes(`n${i}`))
      expect(live()).toBe(1)
      close()
      await until(() => live() === 0)
      expect(live()).toBe(0)
    }
  })

  test('a reconnect past an unanswered permission event still gets it; once answered it is gone', async () => {
    await post('chat/send', { text: 'go' })
    const x = opens[0] as { canUseTool: CanUseTool }
    const asked = x.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' })
    await tick()
    const s = pool.session('chat') as AgentChatSession
    s.notify('info', 'later')
    const after = s.events(0).at(-1)?.seq ?? 0
    const first = await stream(`?after=${after}`, (t) => t.includes('"permission"'))
    first.close()
    expect(first.events[0]).toMatchObject({ t: 'permission', requestId: 'r1', toolName: 'Bash' })
    expect((await post('chat/permission', { requestId: 'r1', behavior: 'maybe' })).status).toBe(400)
    expect((await post('chat/permission', { requestId: 'r1', behavior: 'allow' })).status).toBe(200)
    expect(await asked).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    const again = await post('chat/permission', { requestId: 'r1', behavior: 'allow' })
    expect(again.status).toBe(409)
    const againBody = await again.json() as { error: string; reason: string }
    expect(againBody.error).toBe('not_pending')
    expect(againBody.reason).toContain('r1')
    s.notify('info', 'mark')
    const second = await stream(`?after=${after}`, (t) => t.includes('mark'))
    second.close()
    expect(second.events.some((e) => e.t === 'permission')).toBe(false)
  })

  test('the init event survives the log cap: re-sent first so the client keeps the session id', async () => {
    await post('chat/send', { text: 'go' })
    const fq = opens[0]?.fq as FakeQuery
    fq.emit(fx.init('s-77'), fx.messageStart('m1'), ...Array.from({ length: AGENT_CHAT_EVENT_LOG_MAX }, (_, i) => fx.textDelta(`t${i}`)))
    await tick(20)
    const s = pool.session('chat') as AgentChatSession
    expect(s.events(0).some((e) => e.t === 'init')).toBe(false)
    const lastSeq = s.events(0).at(-1)?.seq ?? 0
    const { events, close } = await stream('?after=0', (t) => t.includes(`id: ${lastSeq}\n`))
    close()
    expect(events[0]).toMatchObject({ t: 'init', sessionId: 's-77' })
    expect(events).toHaveLength(AGENT_CHAT_EVENT_LOG_MAX + 1)
  })

  test('history: no session id is an empty list; otherwise a mapped page, full tool results and the restart notice', async () => {
    expect(await (await fetch(`${base}/chat/history`)).json()).toEqual({ items: [], next: null })
    expect((await fetch(`${base}/chat/history?tool=tu1`)).status).toBe(404)
    const big = 'r'.repeat(20_000)
    transcript = [
      { type: 'user', uuid: 'u1', session_id: 's-old', message: { role: 'user', content: 'run it' }, parent_tool_use_id: null, parent_agent_id: null },
      { type: 'assistant', uuid: 'a1', session_id: 's-old', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] }, parent_tool_use_id: null, parent_agent_id: null },
      { type: 'user', uuid: 'u2', session_id: 's-old', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: big }] }, parent_tool_use_id: null, parent_agent_id: null },
    ]
    const page = await (await fetch(`${base}/old/history?limit=10`)).json() as { items: Array<{ t: string; text?: string; truncated?: boolean }>; next: number | null }
    expect(page.items.map((i) => i.t)).toEqual(['message', 'message', 'tool', 'notice'])
    expect(page.items.at(-1)?.text).toBe('Interrupted by server restart')
    expect(page.items[2]?.truncated).toBe(true)
    expect(await (await fetch(`${base}/old/history?tool=tu1`)).json()).toEqual({ id: 'tu1', result: big })
    expect((await fetch(`${base}/old/history?limit=-2`)).status).toBe(400)
    transcript = new Error('EACCES /secret/path')
    const failed = await fetch(`${base}/old/history`)
    expect(failed.status).toBe(502)
    expect(JSON.stringify(await failed.json())).not.toContain('/secret/path')
  })

  test('a context link to a chat node carries its chatSessionId; a terminal agent keeps sessionId', () => {
    const linked: Workspace = {
      ...ws,
      nodes: [...ws.nodes, { id: 'req', kind: 'agent', x: 0, y: 0 }, { id: 'ag', kind: 'agent', agentId: 'claude', sessionId: 's-term', x: 0, y: 0 }],
      bridges: [{ id: 'b1', source: 'req', target: 'old', kind: 'context' }, { id: 'b2', source: 'ag', target: 'req', kind: 'context' }],
    }
    expect(buildLinkDoc(linked, 'req').links).toEqual([
      { id: 'old', title: 'old', agent: undefined, sessionId: 's-old' },
      { id: 'ag', title: 'ag', agent: 'claude', sessionId: 's-term' },
    ])
  })

  test('a locked session refuses send with 409 and a reason', async () => {
    pool.lock.acquire('s-old', 'someone-else')
    const r = await post('old/send', { text: 'hi' })
    expect(r.status).toBe(409)
    const body = await r.json() as { error: string; reason: string }
    expect(body.error).toBe('session_locked')
    expect(body.reason).toContain('already open')
  })

  test('send with images: validated at the boundary, then image blocks + text reach the Query', async () => {
    const img = (o: Record<string, unknown> = {}) => ({ mediaType: 'image/png', data: PNG, ...o })
    const refused = async (body: unknown): Promise<string> => {
      const r = await post('chat/send', body)
      expect(r.status).toBe(400)
      return ((await r.json()) as { reason: string }).reason
    }
    expect(await refused({ text: '' })).toContain('text or at least one image')
    expect(await refused({ text: '', images: [] })).toContain('text or at least one image')
    expect(await refused({ text: 'x', images: 'no' })).toContain('array')
    expect(await refused({ text: 'x', images: [img({ mediaType: 'image/svg+xml' })] })).toContain('PNG, JPEG, GIF or WebP')
    expect(await refused({ text: 'x', images: [img({ data: 'not base64!' })] })).toContain('base64')
    expect(await refused({ text: 'x', images: [img({ data: 'QUJDRA==' })] })).toContain('is not a PNG')
    expect(await refused({ text: 'x', images: [img({ data: 'A'.repeat(AGENT_CHAT_IMAGE_MAX_B64 + 4) })] })).toContain('is over')
    expect(await refused({ text: 'x', images: Array.from({ length: AGENT_CHAT_IMAGES_MAX + 1 }, () => img()) })).toContain(`At most ${AGENT_CHAT_IMAGES_MAX}`)
    expect(opens).toHaveLength(0)
    // A declared type that lies is corrected to the sniffed one (the API refuses a mismatch).
    expect((await post('chat/send', { text: '', images: [img({ mediaType: 'image/jpeg' })] })).status).toBe(200)
    expect((await post('chat/send', { text: 'what is this?', images: [img()] })).status).toBe(200)
    await tick()
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }
    expect(opens[0]?.fq.prompts.map((p) => p.message.content)).toEqual([[block], [block, { type: 'text', text: 'what is this?' }]])
  })

  test('upload stages a non-image file under the node folder with a safe unique name', async () => {
    const up = (name: string, body: string) => fetch(`${base}/chat/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body })
    const r = await up('../../etc/my notes.txt', 'hello file')
    expect(r.status).toBe(200)
    const { path } = await r.json() as { path: string }
    expect(path.startsWith(join(uploads, 'chat') + '/')).toBe(true)
    expect(path.slice(join(uploads, 'chat').length + 1)).toMatch(/^[a-z0-9]+-[0-9a-f]{8}-__\.\._etc_my_notes\.txt$/)
    expect(readFileSync(path, 'utf8')).toBe('hello file')
    const again = await (await up('../../etc/my notes.txt', 'second')).json() as { path: string }
    expect(again.path).not.toBe(path)
    expect((await up('', 'x')).status).toBe(400)
    expect((await fetch(`${base}/chat/upload?name=a.txt`)).status).toBe(405)
  })

  test('history maps transcript images to references and serves their bytes', async () => {
    expect((await fetch(`${base}/chat/history?image=u1:0`)).status).toBe(404)
    transcript = [{
      type: 'user', uuid: 'u1', session_id: 's-old', parent_tool_use_id: null, parent_agent_id: null,
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'text', text: 'see' }] },
    }]
    const page = await (await fetch(`${base}/old/history`)).json() as { items: Array<{ parts?: unknown[] }> }
    expect(page.items[0]?.parts).toEqual([{ k: 'image', mediaType: 'image/png', ref: 'u1:0' }, { k: 'text', text: 'see' }])
    const img = await fetch(`${base}/old/history?image=u1:0`)
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await img.arrayBuffer()).equals(Buffer.from(PNG, 'base64'))).toBe(true)
    expect((await fetch(`${base}/old/history?image=u1:1`)).status).toBe(404)
    expect((await fetch(`${base}/old/history?image=nope`)).status).toBe(404)
  })
})
