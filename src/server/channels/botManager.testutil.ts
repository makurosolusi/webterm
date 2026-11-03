// test-only: fake Telegram fetch and canary token shared by the managed bots tests.
import type { TelegramSenderFetch } from './telegramSend'

// test-only: synthetic token that must never appear anywhere except the secret file.
export const CANARY_TOKEN = '123456789:CANARYtokenABCDEFGHIJKLMNOPQRSTUVWXYZ012'

export interface FakeCall { method: string; body: Record<string, unknown>; url: string }
export type FakeReply = { status?: number; result?: unknown; description?: string }

/** Fetch that answers by Bot API method name and records every call. */
export function fakeTelegram(replies: Record<string, FakeReply | ((body: Record<string, unknown>) => FakeReply)>): { fetch: TelegramSenderFetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const fetch: TelegramSenderFetch = async (url, init) => {
    const method = url.split('/').pop() as string
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ method, body, url })
    const entry = replies[method]
    const reply = typeof entry === 'function' ? entry(body) : entry ?? { status: 404, description: 'Not Found' }
    const status = reply.status ?? 200
    const ok = status === 200
    return { ok, status, json: async () => (ok ? { ok: true, result: reply.result } : { ok: false, description: reply.description ?? 'error' }) }
  }
  return { fetch, calls }
}
