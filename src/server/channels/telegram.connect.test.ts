import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecretStore } from '../envSecrets.store'
import { connectTelegram } from './telegram.connect'
import { fakeBotApi, ok, TEST_TOKEN } from './telegramPollHarness'

const KEY = 'WEBTERM_TELEGRAM_BOT_TOKEN'

/** Store in-memori yang mencatat setiap penulisan, supaya "tidak berubah" bisa diasersi. */
function memStore(): SecretStore & { map: Map<string, string>; writes: number } {
  const map = new Map<string, string>()
  const store = {
    map, writes: 0,
    read: (k: string) => map.get(k) ?? null,
    write(k: string, v: string) { store.writes += 1; map.set(k, v) },
    remove: (k: string) => void map.delete(k),
  }
  return store
}

let logged: unknown[][]
beforeEach(() => {
  logged = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a))
  }
})
afterEach(() => vi.restoreAllMocks())

/** Token tidak boleh ada di hasil, log, maupun penulisan selain ke store. */
function expectNoLeak(result: unknown): void {
  expect(JSON.stringify(result)).not.toContain(TEST_TOKEN)
  expect(JSON.stringify(logged)).not.toContain(TEST_TOKEN)
}

describe('connectTelegram', () => {
  it('ok: getMe diterima -> token disimpan, kemampuan dinyalakan, hasil @username', async () => {
    const store = memStore()
    const enable = vi.fn()
    const api = fakeBotApi([ok({ id: 1, is_bot: true, username: 'webterm_bot' })])
    const result = await connectTelegram({ token: `  ${TEST_TOKEN}\n`, fetch: api.fetch, store, enable })
    expect(result).toEqual({ ok: true, bot: '@webterm_bot' })
    expect(api.calls.map((c) => c.method)).toEqual(['getMe'])
    expect(store.map.get(KEY)).toBe(TEST_TOKEN)
    expect(enable).toHaveBeenCalledOnce()
    expectNoLeak(result)
  })

  it.each([401, 404])('HTTP %i -> token_rejected, store tidak berubah, tidak dinyalakan', async (status) => {
    const store = memStore()
    const enable = vi.fn()
    const api = fakeBotApi([{ status, body: { ok: false, description: `Unauthorized ${TEST_TOKEN}` } }])
    const result = await connectTelegram({ token: TEST_TOKEN, fetch: api.fetch, store, enable })
    expect(result).toEqual({ ok: false, reason: 'token_rejected' })
    expect(store.writes).toBe(0)
    expect(enable).not.toHaveBeenCalled()
    expectNoLeak(result)
  })

  it('jaringan mati / timeout / 5xx -> unreachable, tidak ada yang disimpan', async () => {
    for (const reply of [new Error(`connect ECONNREFUSED /bot${TEST_TOKEN}/getMe`), { status: 502, body: {} }]) {
      const store = memStore()
      const api = fakeBotApi([reply])
      const result = await connectTelegram({ token: TEST_TOKEN, fetch: api.fetch, store })
      expect(result).toEqual({ ok: false, reason: 'unreachable' })
      expect(store.writes).toBe(0)
      expectNoLeak(result)
    }
    const store = memStore()
    const hang = fakeBotApi([]) // tak pernah menjawab sampai di-abort
    expect(await connectTelegram({ token: TEST_TOKEN, fetch: hang.fetch, store, timeoutMs: 5 })).toEqual({ ok: false, reason: 'unreachable' })
    expect(store.writes).toBe(0)
  })

  it.each(['', 'abc', '123456:short', 'bukan token sama sekali', '12:34 5678901234'])('bentuk salah %j -> invalid_token_shape tanpa memanggil jaringan', async (bad) => {
    const store = memStore()
    const api = fakeBotApi([ok({ username: 'webterm_bot' })])
    expect(await connectTelegram({ token: bad, fetch: api.fetch, store })).toEqual({ ok: false, reason: 'invalid_token_shape' })
    expect(api.calls).toHaveLength(0)
    expect(store.writes).toBe(0)
  })

  it.each([undefined, '', 'ab', 'has space', 'x'.repeat(33), 'bad-name'])('username %j tidak sah -> tidak disimpan', async (username) => {
    const store = memStore()
    const api = fakeBotApi([ok({ username })])
    expect(await connectTelegram({ token: TEST_TOKEN, fetch: api.fetch, store })).toEqual({ ok: false, reason: 'unreachable' })
    expect(store.writes).toBe(0)
  })

  it('store gagal menulis -> save_failed, tidak dinyalakan, token tak bocor', async () => {
    const store = memStore()
    store.write = () => { throw new Error(`disk full while writing ${TEST_TOKEN}`) }
    const enable = vi.fn()
    const api = fakeBotApi([ok({ username: 'webterm_bot' })])
    const result = await connectTelegram({ token: TEST_TOKEN, fetch: api.fetch, store, enable })
    expect(result).toEqual({ ok: false, reason: 'save_failed' })
    expect(enable).not.toHaveBeenCalled()
    expectNoLeak(result)
  })

  it('enable gagal -> enable_failed (token tetap tersimpan), galat tak bocor', async () => {
    const store = memStore()
    const api = fakeBotApi([ok({ username: 'webterm_bot' })])
    const enable = (): never => { throw new Error(`apply failed ${TEST_TOKEN}`) }
    const result = await connectTelegram({ token: TEST_TOKEN, fetch: api.fetch, store, enable })
    expect(result).toEqual({ ok: false, reason: 'enable_failed' })
    expect(store.map.get(KEY)).toBe(TEST_TOKEN)
    expectNoLeak(result)
  })
})
