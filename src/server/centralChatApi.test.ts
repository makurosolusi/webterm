import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { centralChatRoute, CENTRAL_CHAT_BODY_MAX_BYTES, type CentralChatDeps } from './centralChatApi'
import { openFixture, seedPortfolio, type Fixture } from './central/centralTestFixture.testutil'
import { appendConversationEvent, getOrCreateConversation, listConversationEvents } from './central/conversationStore'
import { MockRuntime } from './central/runtime/mockRuntime'
import { StreamHub } from './central/chat/streamHub'
import { TurnService } from './central/chat/turnService'
import { createPortfolioReadExecutor } from './central/chat/toolExecutors'
import type { LedgerRuntime } from './ledger/ledgerRuntime'

const NOW = 1_700_000_000_000

interface FakeRes {
  statusCode: number
  payload: string
  headers: Record<string, string>
  writableEnded: boolean
  setHeader(name: string, value: string): void
  write(chunk: string): void
  end(data?: string): void
  on(): FakeRes
  flushHeaders(): void
}

function fakeRes(): FakeRes {
  return {
    statusCode: 200,
    payload: '',
    headers: {},
    writableEnded: false,
    setHeader(name, value) { this.headers[name] = value },
    write(chunk) { this.payload += chunk },
    end(data = '') { this.payload += data; this.writableEnded = true },
    on() { return this },
    flushHeaders() {},
  }
}

interface Init { method?: string; body?: string; headers?: Record<string, string> }

async function call(
  deps: CentralChatDeps, path: string, init: Init = {}
): Promise<{ handled: boolean; status: number; json: Record<string, unknown>; raw: string }> {
  const chunks = init.body === undefined ? [] : [Buffer.from(init.body)]
  const req = Readable.from(chunks) as unknown as IncomingMessage
  req.method = init.method ?? (init.body === undefined ? 'GET' : 'POST')
  req.headers = init.headers ?? {}
  const res = fakeRes()
  const handled = await centralChatRoute(req, res as unknown as ServerResponse, new URL(path, 'http://x'), deps)
  let json: Record<string, unknown> = {}
  if (res.payload !== '') {
    try {
      json = JSON.parse(res.payload) as Record<string, unknown>
    } catch {
      json = {}
    }
  }
  return {
    handled,
    status: res.statusCode,
    raw: res.payload,
    json,
  }
}

let fixture: Fixture
let ledger: LedgerRuntime
let hub: StreamHub

beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  ledger = { db: fixture.db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
  hub = new StreamHub({
    replay: (id, after) => listConversationEvents(fixture.db, id, after, 500),
    heartbeatMs: 0,
  })
  getOrCreateConversation(fixture.db, 'global', NOW)
})
afterEach(() => {
  hub.close()
  fixture.close()
})

function deps(overrides: Partial<CentralChatDeps> = {}): CentralChatDeps {
  return { ledger, chatEnabled: true, centralEnabled: true, runtimeKind: 'mock', ...overrides }
}

describe('mount and flags', () => {
  it('is not mounted when either flag is off', async () => {
    expect((await call(deps({ chatEnabled: false }), '/api/central/conversations')).handled).toBe(false)
    expect((await call(deps({ centralEnabled: false }), '/api/central/health')).handled).toBe(false)
  })

  it('ignores portfolio and unrelated paths', async () => {
    expect((await call(deps(), '/api/central/portfolio')).handled).toBe(false)
    expect((await call(deps(), '/api/central/conversations/x/unknown')).handled).toBe(false)
  })

  it('reports runtime kind and chat flag from health', async () => {
    const result = await call(deps(), '/api/central/health')
    expect(result.status).toBe(200)
    expect(result.json).toEqual({ runtime: 'mock', chat: true, ledger: true })
  })
})

describe('conversation reads', () => {
  it('lists the global conversation', async () => {
    const result = await call(deps(), '/api/central/conversations')
    expect(result.status).toBe(200)
    const items = result.json['items'] as { id: string }[]
    expect(items[0]?.id).toBe('central:global')
  })

  it('returns history with paging params and rejects bad ones', async () => {
    const empty = await call(deps(), '/api/central/conversations/central%3Aglobal/messages?limit=10')
    expect(empty.status).toBe(200)
    expect(empty.json['items']).toEqual([])
    expect((await call(deps(), '/api/central/conversations/central%3Aglobal/messages?limit=0')).status).toBe(400)
    expect((await call(deps(), '/api/central/conversations/central%3Aglobal/messages?before=x')).status).toBe(400)
    expect((await call(deps(), '/api/central/conversations/central%3Aproject%3Amissing/messages')).status).toBe(404)
  })
})

describe('message submit', () => {
  it('accepts a message with 202 and replays the same ids for the same clientMessageId', async () => {
    const body = JSON.stringify({ clientMessageId: 'c1', text: 'hello' })
    const first = await call(deps(), '/api/central/conversations/central%3Aglobal/messages', { body })
    expect(first.status).toBe(202)
    expect(first.json).toMatchObject({ seq: 1, status: 'running' })
    const second = await call(deps(), '/api/central/conversations/central%3Aglobal/messages', { body })
    expect(second.status).toBe(202)
    expect(second.json).toMatchObject({ messageId: first.json['messageId'], seq: 1, turnId: first.json['turnId'] })
  })

  it('rejects a malformed body and an oversized body', async () => {
    const path = '/api/central/conversations/central%3Aglobal/messages'
    expect((await call(deps(), path, { body: 'not json' })).status).toBe(400)
    expect((await call(deps(), path, { body: JSON.stringify({ text: 'no id' }) })).status).toBe(400)
    const tooBig = await call(deps(), path, { body: 'x'.repeat(CENTRAL_CHAT_BODY_MAX_BYTES + 1) })
    expect(tooBig.status).toBe(413)
    expect((tooBig.json as { error: { code: string } }).error.code).toBe('payload_too_large')
  })

  it('answers 503 central_runtime_off when the runtime is off', async () => {
    const service = new TurnService({ db: fixture.db, runtime: null, stream: hub, now: () => NOW })
    const result = await call(deps({ runtimeKind: 'off', service, stream: hub }),
      '/api/central/conversations/central%3Aglobal/messages',
      { body: JSON.stringify({ clientMessageId: 'c1', text: 'hi' }) })
    expect(result.status).toBe(503)
    expect((result.json as { error: { code: string } }).error.code).toBe('central_runtime_off')
  })

  it('answers 409 conversation_busy with the active turn id', async () => {
    const runtime = new MockRuntime({
      chunks: ['a', 'b', 'c'], stepDelayMs: 100,
      toolExecutor: createPortfolioReadExecutor(fixture.db, { now: () => NOW }),
    })
    const service = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW })
    const path = '/api/central/conversations/central%3Aglobal/messages'
    const first = await call(deps({ service, stream: hub }), path,
      { body: JSON.stringify({ clientMessageId: 'first', text: 'go' }) })
    expect(first.status).toBe(202)
    const second = await call(deps({ service, stream: hub }), path,
      { body: JSON.stringify({ clientMessageId: 'second', text: 'again' }) })
    expect(second.status).toBe(409)
    const error = (second.json as { error: { code: string; activeTurnId: string } }).error
    expect(error.code).toBe('conversation_busy')
    expect(error.activeTurnId).toBe(first.json['turnId'])
    await service.cancel(String(first.json['turnId']))
  })
})

describe('SSE stream', () => {
  it('replays from Last-Event-ID without resending older events', async () => {
    appendConversationEvent(fixture.db, { conversationId: 'central:global', type: 'message.created', payload: { n: 1 } })
    appendConversationEvent(fixture.db, { conversationId: 'central:global', type: 'part.delta', payload: { n: 2 } })
    const result = await call(deps({ stream: hub }), '/api/central/conversations/central%3Aglobal/stream', {
      headers: { 'last-event-id': '1' },
    })
    expect(result.handled).toBe(true)
    expect(result.status).toBe(200)
    expect(result.raw).toContain('id: 2')
    expect(result.raw).not.toContain('id: 1\n')
    expect(result.raw).toContain('event: part.delta')
    const fromZero = await call(deps({ stream: hub }), '/api/central/conversations/central%3Aglobal/stream?after=0')
    expect(fromZero.raw).toContain('id: 1')
    expect(fromZero.raw).toContain('id: 2')
  })

  it('rejects a non-numeric cursor and an unknown conversation', async () => {
    expect((await call(deps({ stream: hub }), '/api/central/conversations/central%3Aglobal/stream', {
      headers: { 'last-event-id': 'abc' },
    })).status).toBe(400)
    expect((await call(deps({ stream: hub }), '/api/central/conversations/central%3Aproject%3Amissing/stream')).status)
      .toBe(404)
  })
})

describe('cancel route', () => {
  it('cancels an active turn and 404s an unknown one', async () => {
    const runtime = new MockRuntime({ chunks: ['a', 'b'], stepDelayMs: 100 })
    const service = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW })
    const submitted = service.submit({ conversationId: 'central:global', clientMessageId: 'x', text: 'go' })
    const result = await call(deps({ service, stream: hub }), `/api/central/turns/${submitted.response.turnId}/cancel`, {
      method: 'POST',
    })
    expect(result.status).toBe(200)
    expect(result.json['status']).toBe('cancelled')
    expect((await call(deps({ service, stream: hub }), '/api/central/turns/missing/cancel', { method: 'POST' })).status)
      .toBe(404)
  })
})
