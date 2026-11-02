/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientLogInput } from '../../shared/logEntry'
import {
  CLIENT_LOG_BACKOFF_MS, CLIENT_LOG_BATCH_MAX, CLIENT_LOG_DEDUPE_MS, CLIENT_LOG_FLUSH_MS,
  createClientLogger, installClientLogger, stripUrlQueries,
} from './clientLogger'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('createClientLogger', () => {
  it('batches a burst into one send of at most 20 entries', async () => {
    const send = vi.fn(async (_: ClientLogInput[]) => {})
    const logger = createClientLogger({ send })
    for (let i = 0; i < 25; i++) logger.log('error', 'client.error', `boom ${i}`)
    await vi.advanceTimersByTimeAsync(CLIENT_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toHaveLength(CLIENT_LOG_BATCH_MAX)
    await vi.advanceTimersByTimeAsync(CLIENT_LOG_FLUSH_MS) // the remaining 5 go out on the rescheduled flush
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0]).toHaveLength(5)
  })

  it('drops identical events inside the dedupe window only', async () => {
    const send = vi.fn(async (_: ClientLogInput[]) => {})
    const logger = createClientLogger({ send })
    logger.log('error', 'client.error', 'same')
    logger.log('error', 'client.error', 'same')
    await vi.advanceTimersByTimeAsync(CLIENT_LOG_DEDUPE_MS + 1)
    logger.log('error', 'client.error', 'same')
    await vi.advanceTimersByTimeAsync(CLIENT_LOG_FLUSH_MS)
    expect(send.mock.calls.flatMap((c) => c[0])).toHaveLength(2)
  })

  it('does not loop or retry when the send fails, and stays quiet during the backoff', async () => {
    const send = vi.fn(async (_: ClientLogInput[]) => { throw new Error('offline') })
    const logger = createClientLogger({ send })
    logger.log('error', 'client.error', 'first')
    await vi.advanceTimersByTimeAsync(CLIENT_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    logger.log('error', 'client.error', 'second')
    await vi.advanceTimersByTimeAsync(CLIENT_LOG_BACKOFF_MS - CLIENT_LOG_FLUSH_MS - 1)
    expect(send).toHaveBeenCalledTimes(1) // nothing logged about the failure, nothing resent
    await logger.flush()
    expect(send).toHaveBeenCalledTimes(1) // still muted
    await vi.advanceTimersByTimeAsync(CLIENT_LOG_BACKOFF_MS)
    await logger.flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0].map((e) => e.message)).toEqual(['second'])
  })

  it('strips query strings from messages', () => {
    expect(stripUrlQueries('GET http://x/api/a?token=abc failed')).toBe('GET http://x/api/a failed')
    expect(stripUrlQueries('What happened? nothing')).toBe('What happened? nothing')
  })
})

describe('installClientLogger', () => {
  it('reports window errors and rejections, hides tokens, and never logs its own POST failure', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? '') })
      if (url === '/api/logs/client') return new Response('nope', { status: 500 })
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchStub)
    window.fetch = fetchStub as unknown as typeof fetch
    const uninstall = installClientLogger()
    try {
      const err = new Error('bad http://h/p?token=SECRET')
      window.dispatchEvent(new ErrorEvent('error', { error: err, message: err.message }))
      const rejection = new Event('unhandledrejection') as PromiseRejectionEvent
      Object.defineProperty(rejection, 'reason', { value: new Error('rejected') })
      window.dispatchEvent(rejection)
      await expect(window.fetch('/api/thing?secret=1')).rejects.toThrow('Failed to fetch')
      await vi.advanceTimersByTimeAsync(CLIENT_LOG_FLUSH_MS)

      const posts = calls.filter((c) => c.url === '/api/logs/client')
      expect(posts).toHaveLength(1) // failed once; no retry, no entry about the failure
      const entries = JSON.parse(posts[0]!.body).entries as ClientLogInput[]
      expect(entries.map((e) => e.event)).toEqual(['client.error', 'client.unhandledrejection', 'client.fetch.fail'])
      expect(posts[0]!.body).not.toContain('SECRET')
      expect(posts[0]!.body).not.toContain('secret=1')
      await vi.advanceTimersByTimeAsync(CLIENT_LOG_BACKOFF_MS * 2)
      expect(calls.filter((c) => c.url === '/api/logs/client')).toHaveLength(1)
    } finally {
      uninstall()
    }
  })
})
