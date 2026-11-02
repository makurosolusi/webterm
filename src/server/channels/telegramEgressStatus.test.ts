import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_STATUS_MAX_ERROR_CHARS,
  getChannelStatus,
  recordEgress,
  recordIngress,
  resetChannelStatus,
} from './channelStatus'
import type { StoredReply } from './channelStoreSchema'
import { TelegramChannelSender, sendTelegramMessage, type SenderStorePort } from './telegramSender'

const TOKEN = '123456:SECRET-TOKEN-VALUE'
const ENV = () => ({ WEBTERM_TELEGRAM_BOT_TOKEN: TOKEN }) as NodeJS.ProcessEnv
const SECRET_TEXT = 'private user message body'

const reply = (key: string): StoredReply => ({
  key,
  channel: 'telegram',
  chatId: '987654321',
  text: SECRET_TEXT,
  createdAt: 1,
  attempts: 0,
  nextAt: 1,
  state: 'pending',
})

function store(rows: StoredReply[], overrides: Partial<SenderStorePort> = {}): SenderStorePort {
  return {
    pendingReplies: () => rows,
    markReplySent: () => true,
    markReplyFailed: () => true,
    ...overrides,
  }
}

const apiError = (status: number, payload: unknown) => async () => ({
  ok: false,
  status,
  json: async () => payload,
})

let logs: string[]
beforeEach(() => {
  resetChannelStatus()
  logs = []
  const sink = (...args: unknown[]) => void logs.push(args.join(' '))
  vi.spyOn(console, 'info').mockImplementation(sink)
  vi.spyOn(console, 'warn').mockImplementation(sink)
  vi.spyOn(console, 'error').mockImplementation(sink)
})
afterEach(() => vi.restoreAllMocks())

describe('channelStatus', () => {
  it('counts ok/error per direction and keeps the last of each', () => {
    recordEgress({ ok: true, at: 1 })
    recordEgress({ ok: true, at: 2 })
    recordEgress({ ok: false, at: 3, error: 'boom' })
    recordIngress({ ok: false, at: 4, error: 'bad' })
    const s = getChannelStatus()
    expect(s.egress).toEqual({ okCount: 2, errorCount: 1, lastOk: 2, lastError: { at: 3, message: 'boom' } })
    expect(s.ingress).toEqual({ okCount: 0, errorCount: 1, lastError: { at: 4, message: 'bad' } })
    s.egress.okCount = 99
    expect(getChannelStatus().egress.okCount).toBe(2)
  })

  it('redacts and truncates recorded errors', () => {
    recordEgress({ ok: false, at: 1, error: 'GET /bot123456:ABCDEFGHIJKLMNOP/sendMessage failed' })
    expect(getChannelStatus().egress.lastError?.message).not.toContain('ABCDEFGHIJKLMNOP')
    recordEgress({ ok: false, at: 2, error: 'x'.repeat(CHANNEL_STATUS_MAX_ERROR_CHARS * 3) })
    expect(getChannelStatus().egress.lastError?.message).toHaveLength(CHANNEL_STATUS_MAX_ERROR_CHARS)
  })

  it('resets to zero', () => {
    recordIngress({ ok: true, at: 1 })
    resetChannelStatus()
    expect(getChannelStatus().ingress).toEqual({ okCount: 0, errorCount: 0 })
  })
})

describe('telegram egress visibility', () => {
  it('surfaces Bot API description and error_code from a non-2xx response', async () => {
    const result = await sendTelegramMessage(
      { chatId: '42', text: 'hi' },
      { env: ENV, fetch: apiError(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }) }
    )
    expect(result).toMatchObject({ ok: false, errorCode: 400, retryable: false })
    expect(result.ok === false && result.error).toContain('chat not found')
  })

  it('reads retry_after from a 429 body', async () => {
    const result = await sendTelegramMessage(
      { chatId: '42', text: 'hi' },
      { env: ENV, fetch: apiError(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }) }
    )
    expect(result).toMatchObject({ ok: false, retryable: true, retryAfterMs: 7000, errorCode: 429 })
  })

  it('falls back to http_<status> when the error body is not JSON', async () => {
    const result = await sendTelegramMessage(
      { chatId: '42', text: 'hi' },
      { env: ENV, fetch: async () => ({ ok: false, status: 502, json: async () => { throw new Error('html') } }) }
    )
    expect(result).toMatchObject({ ok: false, error: 'http_502', retryable: true })
  })

  it('shows a dead send in status and redacted logs without leaking token or message text', async () => {
    const sender = new TelegramChannelSender({
      store: store([reply('r1')]),
      env: ENV,
      now: () => 1000,
      fetch: apiError(401, { ok: false, error_code: 401, description: `Unauthorized for ${TOKEN}` }),
    })
    const out = await sender.flushOnce()
    expect(out.dead).toBe(1)
    const status = getChannelStatus().egress
    expect(status).toMatchObject({ errorCount: 1, okCount: 0 })
    expect(status.lastError?.message).toContain('Unauthorized')
    const everything = JSON.stringify(status) + logs.join('\n')
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain(SECRET_TEXT)
    expect(everything).not.toContain('987654321')
    expect(logs.join('\n')).toContain('telegram egress dead key=r1 chat=***4321')
  })

  it('records a successful send as ok with an info log', async () => {
    const sender = new TelegramChannelSender({
      store: store([reply('r2')]),
      env: ENV,
      now: () => 5,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
    })
    await sender.flushOnce()
    expect(getChannelStatus().egress).toMatchObject({ okCount: 1, errorCount: 0, lastOk: 5 })
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('telegram egress sent key=r2'))
  })

  it('logs and records a throwing store instead of swallowing it', async () => {
    const sender = new TelegramChannelSender({
      store: store([reply('r3')], {
        markReplySent: () => {
          throw new Error('disk full')
        },
      }),
      env: ENV,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
    })
    const out = await sender.flushOnce()
    expect(out.outcomes[0]?.status).toBe('store_error')
    expect(logs.join('\n')).toContain('mark_sent failed: Error: disk full')
    expect(getChannelStatus().egress.lastError?.message).toContain('disk full')
  })

  it('logs a failing flush (pendingReplies throws) at error level', async () => {
    const sender = new TelegramChannelSender({
      store: store([], {
        pendingReplies: () => {
          throw new Error('read failed')
        },
      }),
      env: ENV,
    })
    await sender.flushOnce()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('flush failed: Error: read failed'))
  })
})
