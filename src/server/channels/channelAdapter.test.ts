import { describe, expect, it } from 'vitest'

import { createTelegramAdapter } from './channelAdapter'
import type { TelegramSenderFetch } from './telegramSend'

const SECRET = 's'.repeat(40)
const TOKEN = '123456:SECRET-TOKEN-VALUE'
const headers = { 'x-telegram-bot-api-secret-token': SECRET }

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetch: TelegramSenderFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
    return { ok: status < 300, status, json: async () => body }
  }
  return { fetch, calls }
}

describe('telegram ChannelAdapter', () => {
  it('verify normalizes messages and callbacks, and rejects a bad secret or junk', () => {
    const adapter = createTelegramAdapter({ secret: SECRET, tokenFor: () => TOKEN })
    const msg = { update_id: 4, message: { text: 'hi', chat: { id: -9, type: 'group' }, from: { id: 3 } } }
    expect(adapter.verify({ headers, body: JSON.stringify(msg) })).toMatchObject({
      kind: 'message', accountId: 'default', externalEventId: '4', chatId: '-9', userId: '3', isGroup: true, text: 'hi',
    })
    const cb = { update_id: 5, callback_query: { id: 'c1', from: { id: 3 }, data: 'a:x:y', message: { chat: { id: 8, type: 'private' } } } }
    expect(adapter.verify({ headers, body: JSON.stringify(cb) })).toMatchObject({ kind: 'callback', callbackId: 'c1', text: 'a:x:y', isGroup: false })
    expect(adapter.verify({ headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: JSON.stringify(msg) })).toBeNull()
    expect(adapter.verify({ headers, body: 'not json' })).toBeNull()
  })

  it('render cuts to maxText, drops oversize button ids, and sets no parse_mode', () => {
    const adapter = createTelegramAdapter({ secret: SECRET, tokenFor: () => TOKEN })
    const payload = adapter.render({
      text: 'x'.repeat(5000),
      card: { title: 'T', status: 'S', actions: [{ id: 'a:1:y', label: 'Approve' }, { id: 'z'.repeat(70), label: 'Too long' }] },
    })
    expect((payload['text'] as string).length).toBe(4096)
    expect(payload['parse_mode']).toBeUndefined()
    expect(payload['reply_markup']).toEqual({ inline_keyboard: [[{ text: 'Approve', callback_data: 'a:1:y' }]] })
  })

  it('send uses the per-account token, and failures never expose it', async () => {
    const ok = fakeFetch(200, { ok: true, result: { message_id: 12 } })
    const tokens: Record<string, string> = { default: TOKEN }
    const adapter = createTelegramAdapter({ secret: SECRET, tokenFor: (id) => tokens[id], fetch: ok.fetch })
    expect(await adapter.send('default', { chat_id: '1', text: 'hi' })).toEqual({ ok: true, externalId: '12' })
    expect(ok.calls[0]?.url).toContain('/sendMessage')
    expect(await adapter.send('other', { chat_id: '1', text: 'hi' })).toEqual({ ok: false, errorCode: 'not_configured' })

    const limited = fakeFetch(429, { ok: false, description: `Too Many Requests ${TOKEN}`, parameters: { retry_after: 3 } })
    const failing = createTelegramAdapter({ secret: SECRET, tokenFor: () => TOKEN, fetch: limited.fetch })
    const result = await failing.send('default', { chat_id: '1', text: 'hi' })
    expect(result).toEqual({ ok: false, errorCode: 'rate_limited', retryAfterMs: 3000 })
    expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN')

    await adapter.answerCallback('default', 'c9', 'done')
    expect(ok.calls.at(-1)?.url).toContain('/answerCallbackQuery')
    expect(ok.calls.at(-1)?.body).toEqual({ callback_query_id: 'c9', text: 'done' })
  })
})
