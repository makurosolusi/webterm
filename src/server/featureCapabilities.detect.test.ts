// Deteksi kartu: nama bot dari getMe (sekali per token, gagal = tanpa nama), dan probe mahal hanya saat kemampuan on.
import { describe, expect, it } from 'vitest'
import { TEST_TOKEN, fakeBotApi, ok } from './channels/telegramPollHarness'
import { defaultDetect, rememberTelegramBot, telegramBotName } from './featureCapabilities.detect'

// test-only: token berbeda per kasus supaya cache modul tak bocor antar-kasus.
const tok = (n: number): string => TEST_TOKEN.replace('123456789', String(100000000 + n))

describe('telegramBotName', () => {
  it('getMe sekali per token lalu dari cache', async () => {
    const api = fakeBotApi([ok({ id: 1, is_bot: true, username: 'webterm_bot' })])
    const env = { WEBTERM_TELEGRAM_BOT_TOKEN: tok(1) }
    expect(await telegramBotName(env, api.fetch)).toBe('@webterm_bot')
    expect(await telegramBotName(env, api.fetch)).toBe('@webterm_bot')
    expect(api.calls.map((c) => c.method)).toEqual(['getMe'])
  })
  it('token ditolak = tanpa nama, tidak melempar', async () => {
    const api = fakeBotApi([{ status: 401, body: { ok: false } }])
    expect(await telegramBotName({ WEBTERM_TELEGRAM_BOT_TOKEN: tok(2) }, api.fetch)).toBeUndefined()
  })
  it('nama yang diingat saat Hubungkan bot dipakai tanpa getMe; tanpa token = undefined', async () => {
    rememberTelegramBot(tok(3), '@known_bot')
    const api = fakeBotApi([])
    expect(await telegramBotName({ WEBTERM_TELEGRAM_BOT_TOKEN: tok(3) }, api.fetch)).toBe('@known_bot')
    expect(await telegramBotName({}, api.fetch)).toBeUndefined()
    expect(api.calls).toEqual([])
  })
})

describe('defaultDetect', () => {
  it('kemampuan off = tanpa probe mesin agen maupun getMe', async () => {
    const api = fakeBotApi([])
    const d = await defaultDetect({ WEBTERM_TELEGRAM_BOT_TOKEN: tok(4) }, api.fetch)
    expect(d).toMatchObject({ telegramToken: true, agentEngine: false })
    expect(d.telegramBot).toBeUndefined()
    expect(api.calls).toEqual([])
  })
  it('telegram on = nama bot ikut terisi', async () => {
    const api = fakeBotApi([ok({ id: 1, is_bot: true, username: 'card_bot' })])
    const d = await defaultDetect({ WEBTERM_TELEGRAM: 'on', WEBTERM_TELEGRAM_BOT_TOKEN: tok(5) }, api.fetch)
    expect(d.telegramBot).toBe('@card_bot')
  })
})
