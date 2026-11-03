import { describe, expect, it, vi } from 'vitest'

const MARK = 'LEGACY-MARK-9f3a'
let warns: () => { level: string; event: string }[]

// Flag "sekali per proses" ada di level modul: muat ulang modul (termasuk logBus-nya) per tes.
async function load() {
  vi.resetModules()
  const { logBus } = await import('../logs/logBus')
  warns = () => logBus.query({}).filter((e) => e.level === 'warn' && e.event === 'settings.telegram_token_legacy')
  return (await import('./telegramSend')).resolveTelegramBotToken
}

describe('alias TELEGRAM_BOT_TOKEN', () => {

  it('hanya alias: token terbaca dan warn tepat sekali untuk 3 panggilan, tanpa nilai', async () => {
    const resolve = await load()
    const env = { TELEGRAM_BOT_TOKEN: MARK } as NodeJS.ProcessEnv
    expect([resolve(env), resolve(env), resolve(env)]).toEqual([MARK, MARK, MARK])
    const found = warns()
    expect(found).toHaveLength(1)
    const text = JSON.stringify(found[0])
    expect(text).toContain('TELEGRAM_BOT_TOKEN')
    expect(text).toContain('WEBTERM_TELEGRAM_BOT_TOKEN')
    expect(text).not.toContain(MARK)
  })

  it('token baru ada: alias diabaikan dan tanpa warn', async () => {
    const resolve = await load()
    const env = { WEBTERM_TELEGRAM_BOT_TOKEN: 'new-token', TELEGRAM_BOT_TOKEN: MARK } as NodeJS.ProcessEnv
    expect(resolve(env)).toBe('new-token')
    expect(warns()).toHaveLength(0)
  })
})
