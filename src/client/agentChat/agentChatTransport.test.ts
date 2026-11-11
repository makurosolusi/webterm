import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import type { ChatEventSource } from '../chat/chatTypes'
import { AGENT_CHAT_PATH, AGENT_CHAT_SSE_EVENT, AgentChatApiError, createAgentChatTransport, parseAgentChatFrame } from './agentChatTransport'

class FakeSource implements ChatEventSource {
  static all: FakeSource[] = []
  readonly listeners = new Map<string, (e: MessageEvent) => void>()
  onopen: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  closed = false
  constructor(readonly url: string) { FakeSource.all.push(this) }
  addEventListener(type: string, l: (e: MessageEvent) => void): void { this.listeners.set(type, l) }
  removeEventListener(type: string): void { this.listeners.delete(type) }
  close(): void { this.closed = true }
  emit(e: AgentChatEvent): void { this.listeners.get(AGENT_CHAT_SSE_EVENT)?.({ data: JSON.stringify(e), lastEventId: String(e.seq) } as MessageEvent) }
}

const reply = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  FakeSource.all = []
  fetchMock = vi.fn(async () => reply({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const call = (i: number) => ({ url: fetchMock.mock.calls[i]?.[0] as string, init: fetchMock.mock.calls[i]?.[1] as RequestInit })

describe('createAgentChatTransport', () => {
  it('posts send / interrupt / permission / mode to the node routes', async () => {
    const t = createAgentChatTransport('node 1')
    await t.send('hi', 'next')
    await t.interrupt()
    await t.answer({ requestId: 'r1', behavior: 'deny', message: 'no' })
    await t.setMode('plan')
    const base = `${AGENT_CHAT_PATH}/node%201`
    expect([0, 1, 2, 3].map((i) => call(i).url)).toEqual([`${base}/send`, `${base}/interrupt`, `${base}/permission`, `${base}/mode`])
    expect(JSON.parse(call(0).init.body as string)).toEqual({ text: 'hi', priority: 'next' })
    expect(JSON.parse(call(2).init.body as string)).toEqual({ requestId: 'r1', behavior: 'deny', message: 'no' })
    expect(JSON.parse(call(3).init.body as string)).toEqual({ mode: 'plan' })
    expect(call(0).init.method).toBe('POST')
  })

  it('sends images in the send body, stages a file raw, and builds transcript image URLs', async () => {
    const t = createAgentChatTransport('n1')
    await t.send('', undefined, [{ mediaType: 'image/png', data: 'AAAA' }])
    expect(JSON.parse(call(0).init.body as string)).toEqual({ text: '', images: [{ mediaType: 'image/png', data: 'AAAA' }] })
    fetchMock.mockResolvedValueOnce(reply({ path: '/data/up/x-a b.txt' }))
    const file = new File(['hello'], 'a b.txt')
    expect(await t.upload(file, 'a b.txt')).toBe('/data/up/x-a b.txt')
    expect(call(1).url).toBe(`${AGENT_CHAT_PATH}/n1/upload?name=a%20b.txt`)
    expect(call(1).init.body).toBe(file)
    fetchMock.mockResolvedValueOnce(reply({ error: 'too_large' }, 413))
    expect(await t.upload(file, 'a b.txt').catch((e: unknown) => e)).toMatchObject({ operation: 'upload', status: 413, message: 'The file is over the upload limit.' })
    expect(t.imageUrl('u-1:0')).toBe(`${AGENT_CHAT_PATH}/n1/history?image=u-1%3A0`)
  })

  it('reads history pages and a full tool result', async () => {
    fetchMock.mockResolvedValueOnce(reply({ items: [{ cursor: 3, t: 'notice', level: 'info', text: 'x' }, { bogus: 1 }], next: 2 }))
    fetchMock.mockResolvedValueOnce(reply({ id: 'tu1', result: 'full text' }))
    const t = createAgentChatTransport('n1')
    const page = await t.history({ before: 5 })
    expect(call(0).url).toBe(`${AGENT_CHAT_PATH}/n1/history?before=5&limit=50`)
    expect(page).toEqual({ items: [{ cursor: 3, t: 'notice', level: 'info', text: 'x' }], next: 2 })
    expect(await t.toolResult('tu1')).toBe('full text')
    expect(call(1).url).toBe(`${AGENT_CHAT_PATH}/n1/history?tool=tu1`)
  })

  it('fails with operation, node id and status and a user-facing message', async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 'not_pending', reason: 'gone' }, 409))
    const err = await createAgentChatTransport('n1').answer({ requestId: 'r', behavior: 'allow' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentChatApiError)
    expect(err).toMatchObject({ operation: 'permission', nodeId: 'n1', status: 409, message: 'This request was already answered or has expired.' })
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    const net = await createAgentChatTransport('n1').send('x').catch((e: unknown) => e)
    expect(net).toMatchObject({ operation: 'send', status: 0, code: 'network' })
  })

  it('streams with the cursor, re-applies old init / permission, and stops reconnecting once closed', () => {
    vi.useFakeTimers()
    const events: number[] = []
    const t = createAgentChatTransport('n1', (url) => new FakeSource(url))
    const s = t.stream({ after: 0, onEvent: (e) => events.push(e.seq), onStatus: () => {} })
    const first = FakeSource.all[0] as FakeSource
    expect(first.url).toBe(`${AGENT_CHAT_PATH}/n1/stream`)
    first.emit({ seq: 5, t: 'status', status: 'idle' })
    first.emit({ seq: 5, t: 'status', status: 'idle' }) // duplicate: dropped
    first.emit({ seq: 2, t: 'init', sessionId: 's', model: 'm', mode: 'default', commands: [], capabilities: [], cliVersion: '1', cwd: '/w' })
    first.emit({ seq: 3, t: 'permission', requestId: 'r', kind: 'tool', toolName: 'Bash', toolUseId: 'u', input: {} })
    expect(events).toEqual([5, 2, 3])
    first.onerror?.(new Event('error'))
    vi.advanceTimersByTime(1_000)
    expect((FakeSource.all[1] as FakeSource).url).toBe(`${AGENT_CHAT_PATH}/n1/stream?after=5`)
    s.close()
    expect((FakeSource.all[1] as FakeSource).closed).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(FakeSource.all).toHaveLength(2)
  })
})

describe('parseAgentChatFrame', () => {
  it('accepts known events and rejects malformed or unknown ones', () => {
    expect(parseAgentChatFrame('{"seq":1,"t":"mode","mode":"plan"}')).toEqual({ seq: 1, t: 'mode', mode: 'plan' })
    expect(parseAgentChatFrame('not json')).toBeNull()
    expect(parseAgentChatFrame('{"seq":"1","t":"mode"}')).toBeNull()
    expect(parseAgentChatFrame('{"seq":1,"t":"future"}')).toBeNull()
  })
})

describe('agent chat transport: control verbs', () => {
  const base = `${AGENT_CHAT_PATH}/n1`

  it('GETs catalog / models / sessions and keeps only well-formed rows', async () => {
    const t = createAgentChatTransport('n1')
    fetchMock.mockResolvedValueOnce(reply({ commands: [{ name: 'clear', description: 'Clear', builtin: true }, { nope: 1 }] }))
    expect(await t.catalog()).toEqual([{ name: 'clear', description: 'Clear', builtin: true }])
    fetchMock.mockResolvedValueOnce(reply({ models: [{ value: 'opus', displayName: 'Opus', efforts: ['low'] }, 'bad'] }))
    expect(await t.models()).toEqual([{ value: 'opus', displayName: 'Opus', efforts: ['low'] }])
    fetchMock.mockResolvedValueOnce(reply({ sessions: [{ sessionId: 's1', title: 'T', updatedAt: 1, current: true }] }))
    expect(await t.sessions()).toEqual([{ sessionId: 's1', title: 'T', updatedAt: 1, current: true }])
    fetchMock.mockResolvedValueOnce(reply({}))
    expect(await t.sessions()).toEqual([])
    expect([0, 1, 2].map((i) => call(i).url)).toEqual([`${base}/catalog`, `${base}/models`, `${base}/sessions`])
  })

  it('POSTs config / resume / new with their bodies', async () => {
    const t = createAgentChatTransport('n1')
    await t.setConfig({ model: 'opus', thinking: false })
    await t.resume('s-7')
    await t.newConversation()
    expect([0, 1, 2].map((i) => call(i).url)).toEqual([`${base}/config`, `${base}/resume`, `${base}/new`])
    expect([0, 1, 2].map((i) => JSON.parse(call(i).init.body as string))).toEqual([{ model: 'opus', thinking: false }, { sessionId: 's-7' }, {}])
    expect(call(2).init.method).toBe('POST')
  })

  it('maps control failures to operation-specific messages', async () => {
    const t = createAgentChatTransport('n1')
    fetchMock.mockResolvedValueOnce(reply({ error: 'unavailable' }, 409))
    expect(await t.catalog().catch((e: unknown) => e)).toMatchObject({ operation: 'catalog', status: 409, message: expect.stringContaining('Too many Claude sessions') })
    fetchMock.mockResolvedValueOnce(reply({ error: 'claude_unavailable' }, 503))
    expect(await t.models().catch((e: unknown) => e)).toMatchObject({ operation: 'models', status: 503, message: expect.stringContaining('could not start') })
    fetchMock.mockResolvedValueOnce(reply({ error: 'session_locked' }, 409))
    const err = await t.resume('s').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentChatApiError)
    expect(err).toMatchObject({ operation: 'resume', message: expect.stringContaining('open in another chat node') })
    fetchMock.mockResolvedValueOnce(reply({ error: 'bad_request' }, 400))
    expect(await t.setConfig({ effort: 'x' }).catch((e: unknown) => e)).toMatchObject({ operation: 'config', message: 'That model or effort level is not available.' })
    fetchMock.mockResolvedValueOnce(reply({ error: 'x' }, 409))
    expect(await t.newConversation().catch((e: unknown) => e)).toMatchObject({ operation: 'new conversation', message: 'The new conversation request failed. Try again.' })
    fetchMock.mockResolvedValueOnce(reply({ error: 'busy', reason: 'Claude is working' }, 409))
    expect(await t.newConversation().catch((e: unknown) => e)).toMatchObject({ code: 'busy', message: expect.stringContaining('Stop the turn or wait') })
  })

  it('accepts the new event kinds in SSE frames', () => {
    for (const e of [
      { seq: 1, t: 'config', config: { thinking: true } }, { seq: 2, t: 'context', context: { used: 1, window: 2 } },
      { seq: 3, t: 'commandOutput', id: 'o', text: 'x' }, { seq: 4, t: 'compact', id: 'k', trigger: 'auto' },
      { seq: 5, t: 'reset', sessionId: 's' }, { seq: 6, t: 'commandsChanged' }, { seq: 7, t: 'queued', messageId: 'm', queued: true },
      { seq: 8, t: 'rateLimit', status: 'rejected', resetsAt: 1 }, { seq: 9, t: 'task', task: { id: 't', status: 'running', description: 'd' } },
    ]) expect(parseAgentChatFrame(JSON.stringify(e))).toEqual(e)
  })

  it('rewind / fork / stoptask post to their verbs; a rewind answer is normalized', async () => {
    const t = createAgentChatTransport('n 1')
    fetchMock.mockResolvedValueOnce(reply({ canRewind: true, filesChanged: ['/a', 3], insertions: 2 }))
    expect(await t.rewind('u-1', true)).toEqual({ canRewind: true, filesChanged: ['/a'], insertions: 2, deletions: 0 })
    expect(call(0).url).toBe('/api/agent-chat/n%201/rewind')
    expect(JSON.parse(call(0).init.body as string)).toEqual({ messageId: 'u-1', dryRun: true })
    fetchMock.mockResolvedValueOnce(reply({ nope: 1 }))
    expect(await t.rewind('u-1', true).catch((e: unknown) => e)).toMatchObject({ operation: 'rewind', status: 502 })
    await t.fork('u-2', 'again', [{ mediaType: 'image/png', data: 'AA==' }])
    expect(call(2).url).toBe('/api/agent-chat/n%201/fork')
    expect(JSON.parse(call(2).init.body as string)).toEqual({ messageId: 'u-2', text: 'again', images: [{ mediaType: 'image/png', data: 'AA==' }] })
    await t.stopTask('t1')
    expect(JSON.parse(call(3).init.body as string)).toEqual({ taskId: 't1' })
    fetchMock.mockResolvedValueOnce(reply({ error: 'not_found' }, 404))
    expect(await t.fork('x', 'y').catch((e: unknown) => e)).toMatchObject({ message: expect.stringContaining('not in the saved transcript') })
  })
})

describe('agent chat transport: idempotent send', () => {
  const keyOf = (i: number): string | undefined => (call(i).init.headers as Record<string, string>)['Idempotency-Key']

  it('each send carries a fresh Idempotency-Key; a retry of a failed send reuses it until it lands', async () => {
    const t = createAgentChatTransport('n1')
    await t.send('one')
    await t.send('one') // a deliberate second "one" after a success is a new message
    expect(keyOf(0)).toMatch(/^[A-Za-z0-9_-]{8,128}$/)
    expect(keyOf(1)).not.toBe(keyOf(0))

    fetchMock.mockRejectedValueOnce(new TypeError('offline')) // answer lost: the server may have it
    await t.send('two').catch(() => undefined)
    await t.send('two') // the view's Retry
    expect(keyOf(3)).toBe(keyOf(2))
    await t.send('two')
    expect(keyOf(4)).not.toBe(keyOf(3)) // confirmed: the id is spent

    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await t.fork('m-1', 'edited').catch(() => undefined)
    await t.send('other') // a different message never inherits the failed one's id
    await t.fork('m-1', 'edited')
    expect(keyOf(6)).not.toBe(keyOf(5))
    expect(keyOf(7)).not.toBe(keyOf(5)) // 'other' replaced the pending one: Retry after that is a new send
  })
})
