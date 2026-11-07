/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_PATH, ChatApiError, cancelTurn, chatErrorMessage, createConversation, listConversations, listMessages,
  openChatStream, sendMessage,
} from './chatApi'
import type { ChatEvent } from './chat/chatTypes'

const TOKEN_KEY = 'webterm.token'
const TOKEN = 'tkn-chat-test'

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

function initOf(call: number): RequestInit {
  return fetchMock.mock.calls[call][1] as RequestInit
}

function headersOf(call: number): Record<string, string> {
  return initOf(call).headers as Record<string, string>
}

const conversation = {
  id: 'central:global', scope: 'global', projectId: null, activeTurnId: null,
  lastEventSeq: 4, lastMessageSeq: 3, updatedAt: 100, title: 'First question',
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, seq: number, payload: Record<string, unknown> = {}): void {
    const frame = { seq, type, conversationId: 'central:global', createdAt: 1, ...payload }
    const event = { data: JSON.stringify(frame), lastEventId: String(seq) } as MessageEvent
    // As in a browser: `onerror` is the handler for every `error` event, a server `event: error` frame included.
    if (type === 'error') this.onerror?.(event)
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  open(): void {
    this.onopen?.(new Event('open'))
  }

  fail(): void {
    this.onerror?.(new Event('error'))
  }
}

beforeEach(() => {
  sessionStorage.clear()
  FakeEventSource.instances = []
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  sessionStorage.clear()
})

describe('chat fetch client', () => {
  it('lists conversations without a token header and normalizes rows', async () => {
    sessionStorage.setItem(TOKEN_KEY, TOKEN)
    fetchMock.mockResolvedValue(response({ items: [conversation, { bogus: true }] }))

    const { items: rows } = await listConversations()

    expect(fetchMock.mock.calls[0][0]).toBe(`${CHAT_PATH}/conversations?limit=50`)
    expect(headersOf(0) ?? {}).not.toHaveProperty(TOKEN_HEADER) // the session cookie is the credential
    expect(rows).toEqual([conversation])
  })

  it('creates a conversation with POST and rejects a malformed answer', async () => {
    fetchMock.mockResolvedValue(response({ ...conversation, id: 'central:chat:x', title: null }))
    const row = await createConversation()
    expect(fetchMock.mock.calls[0][0]).toBe(`${CHAT_PATH}/conversations`)
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST')
    expect(row).toMatchObject({ id: 'central:chat:x', title: null })
    fetchMock.mockResolvedValue(response({ nope: true }))
    await expect(createConversation()).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('loads history sorted by seq and drops unsequenced rows', async () => {
    fetchMock.mockResolvedValue(response({
      items: [
        { id: 'm2', seq: 2, role: 'assistant', state: 'complete', parts: [{ type: 'text', text: 'two' }] },
        { id: 'bad', role: 'assistant', parts: [] },
        { id: 'm1', seq: 1, role: 'human', state: 'complete', parts: [{ type: 'text', text: 'one' }] },
      ],
    }))

    const rows = await listMessages('central:global')

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${CHAT_PATH}/conversations/${encodeURIComponent('central:global')}/messages?limit=50`
    )
    expect(rows.map((row) => row.id)).toEqual(['m1', 'm2'])
  })

  it('sends clientMessageId as body + Idempotency-Key', async () => {
    fetchMock.mockResolvedValue(response({ messageId: 'm9', seq: 9, turnId: 't1', status: 'queued' }))

    const result = await sendMessage('central:global', { clientMessageId: 'cm-9', text: ' hello ' })

    const init = initOf(0)
    expect(init.method).toBe('POST')
    expect(headersOf(0)['Idempotency-Key']).toBe('cm-9')
    expect(JSON.parse(String(init.body))).toEqual({ clientMessageId: 'cm-9', text: 'hello' })
    expect(result).toEqual({ messageId: 'm9', seq: 9, turnId: 't1', status: 'queued' })
  })

  it('keeps the newlines of a multi-line message in the POST body', async () => {
    fetchMock.mockResolvedValue(response({ messageId: 'm9', seq: 9, turnId: 't1', status: 'queued' }))
    await sendMessage('central:global', { clientMessageId: 'cm-ml', text: 'one\ntwo\n' })
    expect(JSON.parse(String(initOf(0).body)).text).toBe('one\ntwo')
  })

  it('surfaces 409 conversation_busy with the active turn', async () => {
    fetchMock.mockResolvedValue(response(
      { error: { code: 'conversation_busy', message: 'busy', activeTurnId: 't-live' } }, 409
    ))

    const error = await sendMessage('central:global', { clientMessageId: 'cm-1', text: 'hi' })
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ChatApiError)
    const typed = error as ChatApiError
    expect(typed.status).toBe(409)
    expect(typed.code).toBe('conversation_busy')
    expect(typed.activeTurnId).toBe('t-live')
    expect(chatErrorMessage(typed)).toContain('Another turn is running')
  })

  it('cancels a turn idempotently', async () => {
    fetchMock.mockResolvedValue(response({ status: 'cancelled' }))

    await expect(cancelTurn('turn 1')).resolves.toEqual({ status: 'cancelled' })
    expect(fetchMock.mock.calls[0][0]).toBe(`${CHAT_PATH}/turns/turn%201/cancel`)
    expect(initOf(0).method).toBe('POST')
  })
})

describe('chat SSE client', () => {
  function open(after = 4) {
    const events: ChatEvent[] = []
    const statuses: string[] = []
    const stream = openChatStream('central:global', {
      after,
      createSource: (url) => new FakeEventSource(url) as never,
      onEvent: (event) => events.push(event),
      onStatus: (status) => statuses.push(status),
    })
    return { stream, events, statuses }
  }

  it('starts from the supplied cursor and reconnects from the last applied seq', () => {
    vi.useFakeTimers()
    const { events, statuses } = open(4)

    const first = FakeEventSource.instances[0]
    expect(first.url).toBe(`${CHAT_PATH}/conversations/central%3Aglobal/stream?after=4`)
    first.open()
    expect(statuses).toEqual(['connecting', 'open'])

    first.emit('part.delta', 5, { text: 'Hel' })
    first.emit('part.delta', 5, { text: 'lo' }) // duplicate replay frame: ignored by the stream
    first.emit('part.delta', 6, { text: '!' })
    expect(events.map((event) => event.seq)).toEqual([5, 6])
    expect(statuses[statuses.length - 1]).toBe('open')

    first.fail()
    expect(first.closed).toBe(true)
    expect(statuses[statuses.length - 1]).toBe('reconnecting')

    vi.advanceTimersByTime(1_000)
    const second = FakeEventSource.instances[1]
    expect(second.url).toBe(`${CHAT_PATH}/conversations/central%3Aglobal/stream?after=6`)
  })

  it('a server error frame is applied as an event, not taken for a dead socket', () => {
    vi.useFakeTimers()
    const { events, statuses } = open(4)
    const first = FakeEventSource.instances[0]
    first.open()
    first.emit('error', 5, { payload: { code: 'timeout', message: 'claude timed out' } })
    first.emit('done', 6)
    expect(events.map((event) => event.type)).toEqual(['error', 'done'])
    expect(statuses).not.toContain('reconnecting')
    expect(first.closed).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('applies done without closing the subscription and stops reconnecting after close()', () => {
    vi.useFakeTimers()
    const { events, statuses, stream } = open(1)
    const first = FakeEventSource.instances[0]
    first.open()
    first.emit('message.created', 2, { payload: { id: 'm', seq: 1 } })
    first.emit('done', 3)

    expect(events.map((event) => event.type)).toEqual(['message.created', 'done'])
    expect(first.closed).toBe(false)
    expect(statuses[statuses.length - 1]).toBe('open')

    stream.close()
    expect(first.closed).toBe(true)
    expect(statuses[statuses.length - 1]).toBe('closed')
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

// Keep the token-header literal in one place without importing the server constant.
const TOKEN_HEADER = 'x-webterm-token'
