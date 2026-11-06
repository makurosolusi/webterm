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
    first.emit({ seq: 2, t: 'init', sessionId: 's', model: 'm', mode: 'default', commands: [], capabilities: [], cliVersion: '1' })
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
