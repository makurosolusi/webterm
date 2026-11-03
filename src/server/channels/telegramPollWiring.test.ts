import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import { buildTelegramCentralPort, resolveTelegramMode } from './telegramPollWiring'

const db = {} as Database
const central = { WEBTERM_TELEGRAM: 'on', WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_RUNTIME: 'mock' }

describe('buildTelegramCentralPort gate', () => {
  it('creates the bridge only when every flag is on', () => {
    const create = vi.fn(() => ({ ask: vi.fn() }))
    expect(buildTelegramCentralPort({ db }, central, create)).toBeDefined()
    expect(create).toHaveBeenCalledWith({ db, kind: 'mock' })
  })

  it.each([
    ['WEBTERM_CENTRAL=off', { WEBTERM_CENTRAL: 'off' }],
    ['WEBTERM_CENTRAL unset', { WEBTERM_CENTRAL: undefined }],
    ['WEBTERM_TELEGRAM off', { WEBTERM_TELEGRAM: 'off' }],
    ['runtime off', { WEBTERM_CENTRAL_RUNTIME: 'off' }],
  ])('does not create the bridge when %s', (_name, override) => {
    const create = vi.fn(() => ({ ask: vi.fn() }))
    expect(buildTelegramCentralPort({ db }, { ...central, ...override } as NodeJS.ProcessEnv, create)).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
  })

  it('tolerates case and surrounding whitespace in the capability flags (shared flagOn)', () => {
    const create = vi.fn(() => ({ ask: vi.fn() }))
    expect(buildTelegramCentralPort({ db }, { ...central, WEBTERM_TELEGRAM: ' ON ', WEBTERM_CENTRAL: ' On ' }, create)).toBeDefined()
  })

  it('does not create the bridge without a ledger runtime', () => {
    const create = vi.fn(() => ({ ask: vi.fn() }))
    expect(buildTelegramCentralPort(null, central, create)).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
  })
})

describe('resolveTelegramMode', () => {
  afterEach(() => vi.restoreAllMocks())

  it('defaults to poll when a bot token exists, webhook otherwise', () => {
    expect(resolveTelegramMode({ WEBTERM_TELEGRAM_BOT_TOKEN: '1:abcdefghij' })).toBe('poll')
    expect(resolveTelegramMode({})).toBe('webhook')
  })

  it('lets an explicit value win, case-insensitively', () => {
    expect(resolveTelegramMode({ WEBTERM_TELEGRAM_MODE: 'WEBHOOK', WEBTERM_TELEGRAM_BOT_TOKEN: '1:abcdefghij' })).toBe('webhook')
    expect(resolveTelegramMode({ WEBTERM_TELEGRAM_MODE: ' poll ' })).toBe('poll')
  })

  it('warns without echoing the value and falls back to the default for unsupported input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(resolveTelegramMode({ WEBTERM_TELEGRAM_MODE: 'sekret-typo' })).toBe('webhook')
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('sekret-typo')
  })
})
