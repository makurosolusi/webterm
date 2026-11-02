import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChannelStore } from './channelStore'
import type { StoredReply } from './channelStoreSchema'
import { resolveTelegramBotToken } from './telegramSend'
import {
  TelegramChannelSender,
  sendTelegramMessage,
  startChannelSender,
  type SenderStorePort,
  type TelegramSenderFetch,
  type TelegramSenderResponse,
} from './telegramSender'

const TOKEN = '123456:SECRET-TOKEN-VALUE'
const PREFERRED_TOKEN = '654321:PREFERRED-TOKEN-VALUE'
const PREFERRED_ENV = 'WEBTERM_TELEGRAM_BOT_TOKEN'
const LEGACY_ENV = 'TELEGRAM_BOT_TOKEN'
const ENV = () => ({ [LEGACY_ENV]: TOKEN }) as NodeJS.ProcessEnv
const NO_ENV = () => ({}) as NodeJS.ProcessEnv

function okResponse(messageId = 11): TelegramSenderResponse {
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: messageId } }) }
}

function errorResponse(status: number, payload: unknown = { ok: false, description: 'nope' }): TelegramSenderResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

function reply(key: string, createdAt: number, overrides: Partial<StoredReply> = {}): StoredReply {
  return {
    key,
    channel: 'telegram',
    chatId: '42',
    text: `text-${key}`,
    createdAt,
    attempts: 0,
    nextAt: createdAt,
    state: 'pending',
    ...overrides,
  }
}

class FakeStore implements SenderStorePort {
  rows: StoredReply[]
  sent: string[] = []
  failed: Array<{ key: string; change: { nextAt: number; error?: string; dead?: boolean } }> = []

  constructor(rows: StoredReply[] = []) {
    this.rows = rows
  }

  pendingReplies(): StoredReply[] {
    return this.rows.filter((row) => row.state === 'pending').map((row) => ({ ...row }))
  }

  markReplySent(key: string): boolean {
    const row = this.rows.find((entry) => entry.key === key)
    if (!row || row.state === 'sent') return false
    row.state = 'sent'
    this.sent.push(key)
    return true
  }

  markReplyFailed(key: string, change: { nextAt: number; error?: string; dead?: boolean }): boolean {
    const row = this.rows.find((entry) => entry.key === key)
    if (!row || row.state === 'sent') return false
    row.attempts += 1
    row.nextAt = change.nextAt
    row.state = change.dead ? 'dead' : 'pending'
    row.lastError = change.error
    this.failed.push({ key, change })
    return true
  }
}

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempStorePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'webterm-sender-'))
  dirs.push(root)
  return join(root, 'channels', 'channels.json')
}

describe('sendTelegramMessage', () => {
  it('posts to the Bot API with the env token and validates the response', async () => {
    const calls: Array<{ url: string; init: { body: string; method: string } }> = []
    const fetch: TelegramSenderFetch = async (url, init) => {
      calls.push({ url, init })
      return okResponse(77)
    }
    const result = await sendTelegramMessage(
      { chatId: '42', text: 'hello', threadId: 5 },
      { fetch, env: ENV, apiBase: 'https://example.test' }
    )
    expect(result).toEqual({ ok: true, status: 200, messageId: 77 })
    expect(calls[0]?.url).toBe(`https://example.test/bot${TOKEN}/sendMessage`)
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({
      chat_id: '42',
      text: 'hello',
      message_thread_id: 5,
    })
  })

  it('resolves WEBTERM_TELEGRAM_BOT_TOKEN first, then legacy, at call time', async () => {
    const cases: Array<[NodeJS.ProcessEnv, string | undefined]> = [
      [{ [PREFERRED_ENV]: `  ${PREFERRED_TOKEN}\n`, [LEGACY_ENV]: TOKEN }, PREFERRED_TOKEN],
      [{ [LEGACY_ENV]: TOKEN }, TOKEN],
      [{ [PREFERRED_ENV]: '   ', [LEGACY_ENV]: TOKEN }, TOKEN],
      [{ [PREFERRED_ENV]: ' ', [LEGACY_ENV]: '\t' }, undefined],
      [{}, undefined],
    ]
    for (const [env, expected] of cases) {
      expect(resolveTelegramBotToken(env)).toBe(expected)
      const urls: string[] = []
      const fetch: TelegramSenderFetch = async (url) => {
        urls.push(url)
        return okResponse()
      }
      const result = await sendTelegramMessage({ chatId: '42', text: 'x' }, { fetch, env: () => env })
      if (expected === undefined) {
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason).toBe('not_configured')
        expect(urls).toEqual([])
      } else {
        expect(result.ok).toBe(true)
        expect(urls[0]).toContain(`/bot${expected}/sendMessage`)
      }
    }
  })

  it('lets an explicit option token win over both env names', async () => {
    const urls: string[] = []
    const fetch: TelegramSenderFetch = async (url) => {
      urls.push(url)
      return okResponse()
    }
    await sendTelegramMessage(
      { chatId: '42', text: 'x' },
      {
        fetch,
        env: () => ({ [PREFERRED_ENV]: PREFERRED_TOKEN, [LEGACY_ENV]: TOKEN }) as NodeJS.ProcessEnv,
        token: 'explicit-token',
      }
    )
    expect(urls[0]).toContain('/botexplicit-token/sendMessage')
  })

  it('redacts the token from thrown and provider errors', async () => {
    const thrown: TelegramSenderFetch = async (url) => {
      throw new Error(`request failed for ${url}`)
    }
    const network = await sendTelegramMessage({ chatId: '1', text: 'x' }, { fetch: thrown, env: ENV })
    expect(network.ok).toBe(false)
    if (!network.ok) {
      expect(network.error).not.toContain(TOKEN)
      expect(network.error).toContain('[redacted]')
      expect(network.reason).toBe('network')
    }

    const rejected: TelegramSenderFetch = async () =>
      errorResponse(400, { ok: false, description: `bad token ${TOKEN}` })
    const provider = await sendTelegramMessage({ chatId: '1', text: 'x' }, { fetch: rejected, env: ENV })
    expect(provider.ok).toBe(false)
    if (!provider.ok) {
      expect(provider.error).not.toContain(TOKEN)
      expect(provider.retryable).toBe(false)
    }
  })

  it('treats a 200 with ok:false or invalid JSON as failure', async () => {
    const notOk: TelegramSenderFetch = async () => errorResponse(200, { ok: false, description: 'no' })
    const invalid: TelegramSenderFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json')
      },
    })
    expect((await sendTelegramMessage({ chatId: '1', text: 'x' }, { fetch: notOk, env: ENV })).ok).toBe(false)
    expect((await sendTelegramMessage({ chatId: '1', text: 'x' }, { fetch: invalid, env: ENV })).ok).toBe(false)
  })

  it('times out a fetch that never settles', async () => {
    const hanging: TelegramSenderFetch = () => new Promise(() => undefined)
    const result = await sendTelegramMessage(
      { chatId: '1', text: 'x' },
      { fetch: hanging, env: ENV, timeoutMs: 10 }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('timeout')
      expect(result.retryable).toBe(true)
      expect(result.error).not.toContain(TOKEN)
    }
  })
})

describe('TelegramChannelSender.flushOnce', () => {
  it('sends pending replies oldest-first and marks each sent', async () => {
    const store = new FakeStore([reply('newer', 200), reply('older', 100)])
    const seen: string[] = []
    const fetch: TelegramSenderFetch = async (_url, init) => {
      seen.push(JSON.parse(init.body).chat_id)
      return okResponse()
    }
    const sender = new TelegramChannelSender({ store, fetch, env: ENV, now: () => 300 })
    const result = await sender.flushOnce()
    expect(seen).toEqual(['42', '42'])
    expect(result.sent).toBe(2)
    expect(store.sent).toEqual(['older', 'newer'])
    expect(store.pendingReplies()).toEqual([])
  })

  it('retries with exponential backoff, then succeeds after the delay', async () => {
    let now = 1_000
    let calls = 0
    const fetch: TelegramSenderFetch = async () => (++calls === 1 ? errorResponse(500) : okResponse())
    const store = new FakeStore([reply('k', 100)])
    const sender = new TelegramChannelSender({
      store,
      fetch,
      env: ENV,
      now: () => now,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      maxAttempts: 3,
    })

    const first = await sender.flushOnce()
    expect(first.retried).toBe(1)
    expect(store.failed[0]?.change.nextAt).toBe(1_100)
    expect(store.rows[0]?.attempts).toBe(1)

    const blocked = await sender.flushOnce()
    expect(blocked.attempted).toBe(0)
    expect(blocked.skipped).toBe(1)
    expect(calls).toBe(1)

    now = 1_100
    const second = await sender.flushOnce()
    expect(second.sent).toBe(1)
    expect(calls).toBe(2)
    expect(store.rows[0]?.state).toBe('sent')
  })

  it('dead-letters after max attempts and stops calling fetch', async () => {
    let now = 0
    let calls = 0
    const fetch: TelegramSenderFetch = async () => {
      calls += 1
      return errorResponse(500)
    }
    const store = new FakeStore([reply('k', 0)])
    const sender = new TelegramChannelSender({
      store,
      fetch,
      env: ENV,
      now: () => now,
      baseDelayMs: 10,
      maxDelayMs: 10,
      maxAttempts: 3,
    })
    for (let i = 0; i < 3; i += 1) {
      await sender.flushOnce()
      now += 100
    }
    expect(calls).toBe(3)
    expect(store.rows[0]?.state).toBe('dead')
    await sender.flushOnce()
    expect(calls).toBe(3)
  })

  it('dead-letters a non-retryable 400 immediately', async () => {
    const fetch = vi.fn(async () => errorResponse(400)) as unknown as TelegramSenderFetch
    const store = new FakeStore([reply('k', 0)])
    const sender = new TelegramChannelSender({ store, fetch, env: ENV, now: () => 0 })
    const result = await sender.flushOnce()
    expect(result.dead).toBe(1)
    expect(store.rows[0]?.state).toBe('dead')
  })

  it('is idempotent: a sent reply is not sent again', async () => {
    let calls = 0
    const fetch: TelegramSenderFetch = async () => {
      calls += 1
      return okResponse()
    }
    const store = new FakeStore([reply('k', 0)])
    const sender = new TelegramChannelSender({ store, fetch, env: ENV, now: () => 0 })
    await sender.flushOnce()
    await sender.flushOnce()
    expect(calls).toBe(1)
    expect(store.sent).toEqual(['k'])
  })

  it('keeps rows pending when the token is not configured', async () => {
    const fetch = vi.fn(async () => okResponse()) as unknown as TelegramSenderFetch
    const store = new FakeStore([reply('k', 0)])
    const sender = new TelegramChannelSender({ store, fetch, env: NO_ENV, now: () => 0 })
    const result = await sender.flushOnce()
    expect(fetch).not.toHaveBeenCalled()
    expect(result.skipped).toBe(1)
    expect(store.rows[0]?.state).toBe('pending')
    expect(store.rows[0]?.attempts).toBe(0)
  })

  it('does not throw when the store port throws', async () => {
    const store: SenderStorePort = {
      pendingReplies: () => {
        throw new Error('disk on fire')
      },
      markReplySent: () => true,
      markReplyFailed: () => true,
    }
    const sender = new TelegramChannelSender({ store, env: ENV })
    const result = await sender.flushOnce()
    expect(result.outcomes.at(-1)?.status).toBe('store_error')
  })

  it('reports busy instead of overlapping when called concurrently', async () => {
    let release: ((value: TelegramSenderResponse) => void) | undefined
    const fetch: TelegramSenderFetch = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const store = new FakeStore([reply('k', 0)])
    const sender = new TelegramChannelSender({ store, fetch, env: ENV, now: () => 0 })
    const first = sender.flushOnce()
    const second = await sender.flushOnce()
    expect(second.busy).toBe(true)
    release?.(okResponse())
    expect((await first).sent).toBe(1)
  })
})

describe('startChannelSender', () => {
  it('does not overlap ticks and stops cleanly', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    let calls = 0
    const sender = {
      flushOnce: () => {
        calls += 1
        return new Promise<never>(() => undefined)
      },
    }
    const handle = startChannelSender(sender, { intervalMs: 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toBe(1)
    handle.stop()
    expect(handle.running).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toBe(1)
    release?.()
  })
})

describe('backward-compatible v1 store', () => {
  it('loads a v1 outbox row without nextAt and sends it', async () => {
    const path = tempStorePath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        bindings: {},
        processed: {},
        cursor: 0,
        outbox: [
          { key: 'old', channel: 'telegram', chatId: '42', text: 'legacy', createdAt: 100, attempts: 0, state: 'pending' },
        ],
      })
    )
    const store = new ChannelStore(path)
    expect(store.pendingReplies()[0]?.nextAt).toBe(100)
    const fetch: TelegramSenderFetch = async () => okResponse()
    const sender = new TelegramChannelSender({ store, fetch, env: ENV, now: () => 500 })
    expect((await sender.flushOnce()).sent).toBe(1)
    expect(new ChannelStore(path).snapshot().outbox[0]?.state).toBe('sent')
  })
})
