import { describe, expect, it } from 'vitest'

import { CONTINUATION_KEY, createTelegramAdapter } from './channelAdapter'
import { telegramMarkdownChunks, type TelegramSenderFetch } from './telegramSend'

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

  it('render uses the shared HTML renderer, splits long text, and drops oversize button ids', () => {
    const adapter = createTelegramAdapter({ secret: SECRET, tokenFor: () => TOKEN })
    const text = `<b>not a tag</b> ${'x'.repeat(5000)}`
    const payload = adapter.render({
      text,
      card: { title: 'T', status: 'S', actions: [{ id: 'a:1:y', label: 'Approve' }, { id: 'z'.repeat(70), label: 'Too long' }] },
    })
    const chunks = telegramMarkdownChunks(`T\nS\n\n${text}`)
    expect(chunks.length).toBeGreaterThan(1)
    expect(payload['text']).toBe(chunks[0])
    expect(payload['text']).toContain('&lt;b&gt;not a tag&lt;/b&gt;') // untrusted markup is escaped
    expect(payload[CONTINUATION_KEY]).toEqual(chunks.slice(1))
    expect(payload['parse_mode']).toBe('HTML')
    expect(payload['reply_markup']).toEqual({ inline_keyboard: [[{ text: 'Approve', callback_data: 'a:1:y' }]] })
  })

  it('send delivers every chunk in order and puts the buttons on the last one only', async () => {
    const ok = fakeFetch(200, { ok: true, result: { message_id: 3 } })
    const adapter = createTelegramAdapter({ secret: SECRET, tokenFor: () => TOKEN, fetch: ok.fetch })
    const payload = adapter.render({ text: 'y'.repeat(9000), chatId: '1', card: { title: 'T', status: 'S', actions: [{ id: 'a:1:y', label: 'Go' }] } })
    expect(await adapter.send('default', payload)).toEqual({ ok: true, externalId: '3' })
    expect(ok.calls.length).toBe(1 + (payload[CONTINUATION_KEY] as string[]).length)
    expect(ok.calls.every((c) => c.body['parse_mode'] === 'HTML' && !(CONTINUATION_KEY in c.body))).toBe(true)
    expect(ok.calls.slice(0, -1).every((c) => !('reply_markup' in c.body))).toBe(true)
    expect(ok.calls.at(-1)?.body['reply_markup']).toBeDefined()
  })

  it('render puts chatId into the payload as chat_id and omits it otherwise', () => {
    const adapter = createTelegramAdapter({ secret: SECRET, tokenFor: () => TOKEN })
    expect(adapter.render({ text: 'hi', chatId: '42' })['chat_id']).toBe('42')
    expect('chat_id' in adapter.render({ text: 'hi' })).toBe(false)
  })

  it('send uses the per-account token, and failures never expose it', async () => {
    const ok = fakeFetch(200, { ok: true, result: { message_id: 12 } })
    const tokens: Record<string, string> = { default: TOKEN }
    const adapter = createTelegramAdapter({ secret: SECRET, tokenFor: (id) => tokens[id], fetch: ok.fetch })
    expect(await adapter.send('default', { chat_id: '1', text: 'hi' })).toEqual({ ok: true, externalId: '12' })
    expect(ok.calls).toHaveLength(1)
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
