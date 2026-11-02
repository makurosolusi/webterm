// test-only: scripted fake Bot API transport for the poller tests (no network).
import type { TelegramSenderFetch } from './telegramSend'

export const TEST_TOKEN = '123456789:AAFakeTokenForPollerTestsOnly_xyz'

export interface FakeCall { method: string; params: Record<string, unknown>; url: string }
type Reply = { status?: number; body?: unknown } | Error

/** Replies are consumed in order; once exhausted, requests hang until aborted (an idle long-poll). */
export function fakeBotApi(script: Reply[]): { fetch: TelegramSenderFetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const fetch: TelegramSenderFetch = (url, init) => {
    const method = url.slice(url.lastIndexOf('/') + 1)
    calls.push({ method, url, params: JSON.parse(init.body) as Record<string, unknown> })
    const next = script.shift()
    if (next instanceof Error) return Promise.reject(next)
    if (next) {
      const status = next.status ?? 200
      return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => next.body })
    }
    return new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  return { fetch, calls }
}

export const ok = (result: unknown): Reply => ({ body: { ok: true, result } })
export const msg = (updateId: number, chatId = 42): unknown => ({
  update_id: updateId,
  message: { message_id: updateId, chat: { id: chatId, type: 'private' }, from: { id: chatId }, text: 'hi' },
})
