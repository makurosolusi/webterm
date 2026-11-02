import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelStore } from './channelStore'
import { dispatchTelegramUpdate } from './channelDispatch'
import { startTelegramPoller, type TelegramPoller, type TelegramPollerOptions, type TelegramPollStatus } from './telegramPoll'
import { TEST_TOKEN, fakeBotApi, msg, ok } from './telegramPollHarness'

let dir: string
let poller: TelegramPoller | undefined
const env = { WEBTERM_TELEGRAM_BOT_TOKEN: TEST_TOKEN } as NodeJS.ProcessEnv
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)) }
const newStore = (): ChannelStore => new ChannelStore(join(dir, 'channels.json'))

function start(
  extra: Partial<TelegramPollerOptions> & Pick<TelegramPollerOptions, 'fetch'>,
  store = newStore()
): { store: ChannelStore; poller: TelegramPoller; sleeps: number[] } {
  const sleeps: number[] = []
  poller = startTelegramPoller({
    env,
    cursor: () => store.snapshot().cursor,
    dispatch: (u) => dispatchTelegramUpdate(u, { store }),
    sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setImmediate(r)) },
    random: () => 1,
    ...extra,
  })
  return { store, poller, sleeps }
}

describe('telegram poller', () => {
  let logs: string[]
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tgpoll-'))
    logs = []
    for (const level of ['warn', 'error', 'log', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')) })
    }
  })
  afterEach(async () => {
    await poller?.stop()
    poller = undefined
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes the webhook first, then long-polls message updates and dispatches them', async () => {
    const api = fakeBotApi([ok(true), ok([msg(10)])])
    const dispatch = vi.fn(async () => ({ status: 'ok' }))
    start({ fetch: api.fetch, dispatch, pollTimeoutSec: 7 })
    await flush()
    expect(api.calls.map((c) => c.method).slice(0, 3)).toEqual(['deleteWebhook', 'getUpdates', 'getUpdates'])
    expect(api.calls[0]?.params).toEqual({})
    expect(api.calls[1]?.params).toEqual({ offset: 1, timeout: 7, allowed_updates: ['message'] })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ update_id: 10 }))
    expect(api.calls[2]?.params['offset']).toBe(11)
  })

  it('drops duplicate updates through the shared claimUpdate dedupe', async () => {
    const api = fakeBotApi([ok(true), ok([msg(5), msg(5)])])
    const outcomes: unknown[] = []
    const store = newStore()
    start({
      fetch: api.fetch,
      dispatch: async (u) => { const o = await dispatchTelegramUpdate(u, { store }); outcomes.push(o); return o },
    }, store)
    await flush()
    expect(outcomes.map((o) => (o as { status: string }).status)).toEqual(['denied', 'duplicate'])
  })

  it('advances the cursor, persists it, and resumes after a restart', async () => {
    const api = fakeBotApi([ok(true), ok([msg(7), msg(9)])])
    start({ fetch: api.fetch })
    await flush()
    await poller?.stop()
    poller = undefined
    expect(newStore().snapshot().cursor).toBe(9)
    const again = fakeBotApi([ok(true)])
    start({ fetch: again.fetch })
    await flush()
    expect(again.calls[1]?.params['offset']).toBe(10)
  })

  it('does not advance past an update whose dispatch threw, and retries it with backoff', async () => {
    const api = fakeBotApi([ok(true), ok([msg(3)]), ok([msg(3)])])
    let first = true
    const dispatch = vi.fn(async () => { if (first) { first = false; throw new Error(`boom ${TEST_TOKEN}`) } })
    const { sleeps } = start({ fetch: api.fetch, dispatch })
    await flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(api.calls[2]?.params['offset']).toBe(1)
    expect(api.calls[3]?.params['offset']).toBe(4)
    expect(sleeps).toEqual([1000])
    expect(logs.join('\n')).not.toContain(TEST_TOKEN)
  })

  it('stops on 401 with exactly one error log and no further calls', async () => {
    const api = fakeBotApi([{ status: 401, body: { ok: false, description: 'Unauthorized' } }])
    const statuses: TelegramPollStatus[] = []
    const { poller: p } = start({ fetch: api.fetch, onStatus: (s) => statuses.push(s) })
    await p.done
    expect(api.calls).toHaveLength(1)
    const errors = logs.filter((l) => l.startsWith('telegram poll stopped'))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('401')
    expect(statuses).toEqual([expect.objectContaining({ ok: false, error: expect.stringContaining('401') })])
  })

  it('also treats 404 (unknown token path) as fatal', async () => {
    const api = fakeBotApi([ok(true), { status: 404, body: { ok: false } }])
    const { poller: p } = start({ fetch: api.fetch })
    await p.done
    expect(api.calls).toHaveLength(2)
  })

  it('warns and retries on 409 (another consumer), honoring backoff', async () => {
    const api = fakeBotApi([ok(true), { status: 409, body: { ok: false, description: 'Conflict: terminated by other getUpdates' } }, ok([])])
    const { sleeps } = start({ fetch: api.fetch })
    await flush()
    expect(sleeps).toEqual([1000])
    expect(api.calls.map((c) => c.method).slice(0, 3)).toEqual(['deleteWebhook', 'getUpdates', 'getUpdates'])
    expect(logs.some((l) => l.includes('telegram poll:') && l.includes('409'))).toBe(true)
  })

  it('backs off exponentially with jitter, capped, and resets after success', async () => {
    const boom = (): Error => new Error('socket hang up')
    const api = fakeBotApi([ok(true), boom(), boom(), boom(), boom(), ok([]), boom()])
    const { sleeps } = start({ fetch: api.fetch, backoffBaseMs: 100, backoffMaxMs: 300 })
    await flush()
    expect(sleeps).toEqual([100, 200, 300, 300, 100])
  })

  it('applies jitter within [50%, 100%] of the backoff', async () => {
    const api = fakeBotApi([ok(true), new Error('x')])
    const { sleeps } = start({ fetch: api.fetch, backoffBaseMs: 1000, random: () => 0 })
    await flush()
    expect(sleeps).toEqual([500])
  })

  it('never leaks the token into logs, status or errors', async () => {
    const api = fakeBotApi([ok(true), new Error(`fetch failed: https://api.telegram.org/bot${TEST_TOKEN}/getUpdates`)])
    const statuses: TelegramPollStatus[] = []
    start({ fetch: api.fetch, onStatus: (s) => statuses.push(s) })
    await flush()
    const blob = JSON.stringify([logs, statuses])
    expect(blob).toContain('network error')
    expect(blob).not.toContain(TEST_TOKEN)
    expect(blob).not.toContain('AAFakeToken')
  })

  it('stop() aborts the in-flight long poll and resolves after the loop exits', async () => {
    const api = fakeBotApi([ok(true)])
    const { poller: p } = start({ fetch: api.fetch })
    await flush()
    expect(api.calls).toHaveLength(2)
    await p.stop()
    await p.stop()
    expect(api.calls).toHaveLength(2)
    expect(logs.filter((l) => l.includes('telegram poll'))).toEqual([])
  })

  it('allows only one poller per process until it is stopped', async () => {
    const api = fakeBotApi([])
    const { poller: p } = start({ fetch: api.fetch })
    expect(() => start({ fetch: api.fetch })).toThrow(/already running/)
    await p.stop()
    const next = fakeBotApi([])
    expect(() => start({ fetch: next.fetch })).not.toThrow()
  })

  it('reports ok status after each successful poll', async () => {
    const api = fakeBotApi([ok(true), ok([])])
    const statuses: TelegramPollStatus[] = []
    start({ fetch: api.fetch, onStatus: (s) => statuses.push(s), now: () => 123 })
    await flush()
    expect(statuses[0]).toEqual({ ok: true, at: 123 })
  })
})
