import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNEL_ENV_SPECS } from '../envRegistry.channels'
import { reconcile } from '../featureCapabilities.runtime'
import { callApi, harnessLedger } from './channelsRuntimeHarness'
import { TELEGRAM_PENDING_PATH } from './channelPendingHttp'
import { createTelegramHot, registerTelegramCentralRefresh, registerTelegramHot, type TelegramHot } from './telegramHot'
import { fakeBotApi, TEST_TOKEN } from './telegramPollHarness'

const TOKEN_ENV = 'WEBTERM_TELEGRAM_BOT_TOKEN'
let dir: string
let unregister: (() => void) | undefined
let hot: TelegramHot | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'webterm-tg-hot-'))
  for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => undefined)
})
afterEach(async () => {
  unregister?.()
  await hot?.stop()
  hot = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** Poller memakai fetch global; jawaban kosong = long-poll menggantung sampai di-abort. */
function make(env: NodeJS.ProcessEnv) {
  const api = fakeBotApi([{ body: { ok: true, result: true } }, { body: { ok: true, result: true } }, { body: { ok: true, result: true } }])
  vi.stubGlobal('fetch', api.fetch)
  hot = createTelegramHot({
    ledger: harnessLedger,
    options: { env, storePath: join(dir, 'channels.json'), sender: { intervalMs: 60_000 }, secrets: { read: () => null, write: () => undefined, remove: () => undefined } },
  })
  const deletes = (): number => api.calls.filter((c) => c.method === 'deleteWebhook').length
  return { api, hot, deletes }
}

describe('Telegram hot-apply', () => {
  it('token diisi saat server berjalan -> poller hidup tanpa restart', async () => {
    const env: NodeJS.ProcessEnv = { WEBTERM_TELEGRAM: 'on' }
    const { hot, deletes, api } = make(env)
    await hot.start()
    expect(hot.channels?.mode).toBe('poll') // menunggu token, kanal tidak mati
    await new Promise((r) => setTimeout(r, 20))
    expect(api.calls).toHaveLength(0) // tanpa token: tidak ada poller
    env[TOKEN_ENV] = TEST_TOKEN
    await hot.refresh()
    await vi.waitFor(() => expect(deletes()).toBe(1))
    await vi.waitFor(() => expect(api.calls.some((c) => c.method === 'getUpdates')).toBe(true))
    expect(hot.channels?.senderRunning).toBe(true)
  })

  it('stop;stop aman, start;start satu poller, start;stop;start satu poller', async () => {
    const { hot, deletes } = make({ WEBTERM_TELEGRAM: 'on', [TOKEN_ENV]: TEST_TOKEN })
    await hot.stop() // sebelum start
    await hot.start()
    await hot.start()
    await vi.waitFor(() => expect(deletes()).toBe(1))
    await hot.stop()
    await hot.stop()
    expect(hot.channels).toBeNull()
    await hot.start()
    await hot.stop()
    await hot.start()
    await vi.waitFor(() => expect(deletes()).toBe(3)) // satu per start nyata; tak pernah dua sekaligus
    await hot.stop()
    expect(hot.channels).toBeNull()
  })

  it('refresh tidak mereset daftar chat pending', async () => {
    const { hot } = make({ WEBTERM_TELEGRAM: 'on' })
    await hot.start()
    const before = hot.channels!
    await before.ingest({ update_id: 1, message: { message_id: 1, text: 'hi', chat: { id: 555, type: 'private' }, from: { id: 555 } } })
    const total = async (): Promise<number> => JSON.parse((await callApi(hot.channels!, 'GET', TELEGRAM_PENDING_PATH)).body).total
    expect(await total()).toBe(1)
    await hot.refresh()
    expect(hot.channels).not.toBe(before) // runtime benar-benar dibangun ulang
    expect(await total()).toBe(1)
  })

  it('start tanpa kemampuan on tidak membangun apa pun', async () => {
    const { hot, api } = make({ WEBTERM_TELEGRAM: 'off', [TOKEN_ENV]: TEST_TOKEN })
    await hot.start()
    expect(hot.channels).toBeNull()
    expect(api.calls).toHaveLength(0)
  })

  it('hook onCapabilityChange: reconcile on menyalakan, off mematikan', async () => {
    const { hot } = make({ WEBTERM_TELEGRAM: 'on', [TOKEN_ENV]: TEST_TOKEN })
    unregister = registerTelegramHot(hot)
    await reconcile(new Set(), new Set(['telegram']))
    expect(hot.channels).not.toBeNull()
    await reconcile(new Set(['telegram']), new Set())
    expect(hot.channels).toBeNull()
  })
})

describe('registry kanal', () => {
  it('kunci channels yang hot-apply tidak berlabel boot dan tidak butuh ledger', () => {
    for (const key of ['WEBTERM_TELEGRAM', TOKEN_ENV]) {
      expect(CHANNEL_ENV_SPECS.find((s) => s.key === key)?.restart).toBe('hot')
    }
    const telegramLike = CHANNEL_ENV_SPECS.filter((s) => s.owner === 'channels')
    expect(JSON.stringify(telegramLike.map((s) => s.requires))).not.toContain('WEBTERM_LEDGER')
  })
})

describe('registerTelegramCentralRefresh', () => {
  const on = new Set(['central'] as const)
  const off = new Set<never>()
  function setup(centralOn: { v: boolean }) {
    const refresh = vi.fn(async () => undefined)
    const fake = { refresh } as unknown as TelegramHot
    unregister = registerTelegramCentralRefresh(fake, () => centralOn.v, () => true)
    return refresh
  }
  /** Boot: reconcile from nothing to what is on (marks the hook running, like server.main.ts). */
  const boot = (): Promise<void> => reconcile(off, on)

  it('a Central restart with no on/off change (bounce: stop then start) does not rebuild the channel', async () => {
    const refresh = setup({ v: true })
    await boot()
    await reconcile(on, off)
    await reconcile(off, on)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('Central really turning off, then on, rebuilds once each', async () => {
    const central = { v: true }
    const refresh = setup(central)
    await boot()
    expect(refresh).not.toHaveBeenCalled()
    central.v = false
    await reconcile(on, off)
    expect(refresh).toHaveBeenCalledTimes(1)
    central.v = true
    await reconcile(off, on)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
