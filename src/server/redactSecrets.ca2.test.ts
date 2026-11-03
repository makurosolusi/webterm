import { describe, expect, it } from 'vitest'
import { PERSIST_LIMITS, REDACTED, STREAM_LIMITS, redactSecrets, redactValue } from './redactSecrets'

const BOT_TOKEN = '123456789:AAEhBP0av28ABCDEFGHIJKLMNOPQRSTUVWXYZ1234'

describe('botToken redaction (CA2)', () => {
  it('masks the botToken key whatever its value looks like', () => {
    const out = redactValue({ accountId: 'ops', botToken: 'not-token-shaped', bot_token: 'x', purpose: 'alerts' }, PERSIST_LIMITS) as Record<string, string>
    expect(out.botToken).toBe(REDACTED)
    expect(out.bot_token).toBe(REDACTED)
    expect(out.accountId).toBe('ops')
    expect(out.purpose).toBe('alerts')
  })

  it('masks a bare BotFather token in free text, with or without the bot prefix', () => {
    expect(redactSecrets(`token is ${BOT_TOKEN} ok`)).not.toContain(BOT_TOKEN)
    expect(redactSecrets(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)).not.toContain('AAEhBP0av28')
  })

  it('masks it inside nested tool input on the stream path too', () => {
    const out = JSON.stringify(redactValue({ tool: 'channel.bot.propose', input: { botToken: BOT_TOKEN, note: `see ${BOT_TOKEN}` } }, STREAM_LIMITS))
    expect(out).not.toContain(BOT_TOKEN)
    expect(out).toContain('channel.bot.propose')
  })

  it('leaves ordinary id:value text alone', () => {
    expect(redactSecrets('ratio 12:30 and 2026:11')).toBe('ratio 12:30 and 2026:11')
  })
})
