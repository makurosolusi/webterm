// Detector behaviour with a fake fetch and a fake clock: no real network, no real timers.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrate } from '../ledger/migration'
import { changeEvent, netFrame } from './connectivity.events'
import { CONTROL_URL, DEFAULT_API_BASE_URL, classifyProbeError, probeOnce, type FetchFn } from './connectivity.probe'
import { createConnectivityService, nextDelayMs, PROBE_BACKOFF_CAP_MS, PROBE_INTERVAL_MS, type StateChange } from './connectivity.service'
import { EPISODE_MAX_ROWS, EPISODE_RETENTION_DAYS, createEpisodeStore } from './connectivity.store'

type Net = { api: 'ok' | 'fail'; control: 'ok' | 'fail'; errorText: string }
function rig(opts: { base?: string; db?: Database } = {}) {
  const net: Net = { api: 'ok', control: 'ok', errorText: 'getaddrinfo ENOTFOUND api.example' }
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init })
    const up = url === CONTROL_URL ? net.control : net.api
    if (up === 'fail') throw Object.assign(new Error(net.errorText), { code: 'ENOTFOUND' })
    return new Response(null, { status: 401 }) // any HTTP answer = reachable
  }
  const clock = { t: 1_000_000 }
  const db = opts.db ?? (() => { const d = new Database(':memory:'); migrate(d); return d })()
  const changes: StateChange[] = []
  const logged: unknown[] = []
  const log = { warn: (...a: unknown[]) => { logged.push(a) }, info: (...a: unknown[]) => { logged.push(a) } }
  const make = () => createConnectivityService({
    fetch: fetchFn, now: () => clock.t, random: () => 0.5, baseUrl: () => opts.base, store: createEpisodeStore(db, () => clock.t),
    log, onChange: (c) => changes.push(c),
  })
  return { net, calls, clock, db, changes, logged, svc: make(), make }
}
const seq = async (r: ReturnType<typeof rig>, ...steps: ('ok' | 'fail')[]): Promise<void> => {
  for (const s of steps) { r.net.api = s; r.clock.t += PROBE_INTERVAL_MS; await r.svc.tick() }
}

describe('hysteresis', () => {
  test('1 failure degrades, 3 go offline, a single success does not recover, 2 do', async () => {
    const r = rig()
    await seq(r, 'fail')
    expect(r.svc.state().state).toBe('degraded')
    expect(r.svc.isOffline()).toBe(false)
    expect(r.svc.isImpaired()).toBe(true)
    await seq(r, 'fail')
    expect(r.svc.state().state).toBe('degraded')
    await seq(r, 'fail')
    expect(r.svc.state().state).toBe('offline')
    expect(r.svc.isOffline()).toBe(true)
    await seq(r, 'ok')
    expect(r.svc.state().state).toBe('offline')
    await seq(r, 'ok')
    expect(r.svc.state()).toMatchObject({ state: 'online', consecutiveSuccesses: 2 })
    expect(r.svc.state().cause).toBe(undefined)
    expect(r.svc.isImpaired()).toBe(false)
  })

  test('flapping fires events only on state changes', async () => {
    const r = rig()
    await seq(r, 'ok', 'ok', 'fail', 'ok', 'fail', 'ok', 'ok', 'ok')
    // ok ok | fail -> degraded | ok (1 ok, still degraded) | fail (still degraded) | ok ok -> online | ok
    expect(r.changes.map((c) => `${c.from}>${c.to}`)).toEqual(['online>degraded', 'degraded>online'])
    expect(r.calls.filter((c) => c.url === CONTROL_URL)).toHaveLength(2)
  })

  test('subscribers get changes only and unsubscribe works; a throwing listener is isolated', async () => {
    const r = rig()
    const heard: string[] = []
    const off = r.svc.subscribe((s, from) => heard.push(`${from}>${s.state}`))
    r.svc.subscribe(() => { throw new Error('boom') })
    await seq(r, 'ok', 'fail', 'fail')
    off()
    await seq(r, 'fail')
    expect(heard).toEqual(['online>degraded'])
    expect(r.svc.state().state).toBe('offline')
  })
})

describe('scope', () => {
  test('control failing too = network, control fine = api; control is probed only after an API failure', async () => {
    const r = rig()
    r.net.control = 'fail'
    await seq(r, 'fail')
    expect(r.svc.state()).toMatchObject({ cause: 'dns', scope: 'network' })
    r.net.control = 'ok'
    await seq(r, 'fail')
    expect(r.svc.state()).toMatchObject({ cause: 'dns', scope: 'api' })
    const before = r.calls.length
    await seq(r, 'ok')
    expect(r.calls.length - before).toBe(1)
  })

  test('probe errors map to bounded causes', async () => {
    expect(classifyProbeError(new Error('x'), true)).toBe('timeout')
    expect(classifyProbeError({ cause: { code: 'ECONNREFUSED' } }, false)).toBe('tcp')
    expect(classifyProbeError({ code: 'CERT_HAS_EXPIRED' }, false)).toBe('tls')
    expect(classifyProbeError(new Error('weird'), false)).toBe('unknown')
    const hang: FetchFn = (_u, init) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))
    expect(await probeOnce(hang, DEFAULT_API_BASE_URL, 10)).toEqual({ ok: false, cause: 'timeout' })
  })
})

describe('sleep/wake', () => {
  test('a clock jump re-probes at once and old streaks cannot push the state to offline', async () => {
    const r = rig()
    await seq(r, 'fail', 'fail')
    expect(r.svc.state()).toMatchObject({ state: 'degraded', consecutiveFailures: 2 })
    const before = r.calls.length
    r.clock.t += 3 * 3_600_000 // laptop slept three hours
    r.net.api = 'fail'
    await r.svc.tick()
    expect(r.calls.length).toBeGreaterThan(before) // probed immediately
    expect(r.svc.state()).toMatchObject({ state: 'degraded', consecutiveFailures: 1 }) // the third old failure did not count
  })
})

describe('redaction and credentials', () => {
  const BASE = 'https://alice:s3cretpw@proxy.internal.example:8443/v1?key=topsecret'
  test('cause, events, frames, episodes and logs never carry the URL, userinfo or headers', async () => {
    const r = rig({ base: BASE })
    r.net.errorText = `fetch failed for ${BASE}`
    await seq(r, 'fail', 'fail', 'fail')
    const dump = JSON.stringify([r.svc.state(), r.svc.episodes(10), r.changes.map((c) => [changeEvent(c), netFrame(c)]), r.logged])
    for (const secret of ['alice', 's3cretpw', 'proxy.internal', 'topsecret', 'https://']) expect(dump).not.toContain(secret)
    expect(r.calls[0]?.url).toBe('https://proxy.internal.example:8443') // origin only: no userinfo, path or query
  })

  test('probes carry no credentials, headers or body', async () => {
    const r = rig()
    await seq(r, 'fail')
    expect(r.calls.length).toBeGreaterThan(1)
    for (const { init } of r.calls) {
      expect(init.method).toBe('HEAD')
      expect(init.headers).toBe(undefined)
      expect(init.body).toBe(undefined)
      expect(init.credentials).toBe('omit')
    }
  })
})

describe('episodes', () => {
  test('state changes open and close episodes with their cause and scope', async () => {
    const r = rig()
    await seq(r, 'fail', 'fail', 'fail', 'ok', 'ok')
    const eps = r.svc.episodes(10)
    expect(eps.map((e) => [e.state, e.endedAt !== null, e.cause, e.scope])).toEqual([['offline', true, 'dns', 'api'], ['degraded', true, 'dns', 'api']])
    expect(eps[0]?.durationMs).toBe(2 * PROBE_INTERVAL_MS)
  })

  test('retention drops old and surplus closed episodes, never the open one', () => {
    const db = new Database(':memory:'); migrate(db)
    let t = 400 * 86_400_000
    const store = createEpisodeStore(db, () => t)
    store.begin('offline', t - (EPISODE_RETENTION_DAYS + 1) * 86_400_000, 'dns', 'network')
    store.end(t - (EPISODE_RETENTION_DAYS + 1) * 86_400_000 + 1)
    store.begin('degraded', t - 1000, null, null) // open, keeps
    for (let i = 0; i < EPISODE_MAX_ROWS + 20; i++) { t += 1; store.end(t); store.begin('degraded', t, null, null) }
    const n = (db.query('SELECT COUNT(*) AS n FROM connectivity_episode').get() as { n: number }).n
    expect(n <= EPISODE_MAX_ROWS + 1).toBe(true)
    expect(store.open()).not.toBeNull()
    expect(db.query("SELECT COUNT(*) AS n FROM connectivity_episode WHERE started_at < ?").get(t - EPISODE_RETENTION_DAYS * 86_400_000)).toEqual({ n: 0 })
  })

  test('restart resumes the open episode instead of dropping or duplicating it', async () => {
    const r = rig()
    await seq(r, 'fail', 'fail', 'fail')
    const since = r.svc.state().since
    const again = r.make() // same db = process restarted
    expect(again.state()).toMatchObject({ state: 'offline', since, cause: 'dns', scope: 'api' })
    r.net.api = 'fail'; r.clock.t += PROBE_INTERVAL_MS; await again.tick()
    expect(again.state().state).toBe('offline')
    expect(again.episodes(10).filter((e) => e.endedAt === null)).toHaveLength(1)
    r.net.api = 'ok'
    for (let i = 0; i < 2; i++) { r.clock.t += PROBE_INTERVAL_MS; await again.tick() }
    expect(again.state().state).toBe('online')
    expect(again.episodes(10).every((e) => e.endedAt !== null)).toBe(true)
  })
})

describe('scheduling', () => {
  test('Full Jitter stays within 0..cap, floored; online keeps the plain interval', () => {
    const online = { state: 'online', since: 0, lastOkAt: 0, consecutiveFailures: 0, consecutiveSuccesses: 1 } as const
    expect(nextDelayMs(online, () => 0.99)).toBe(PROBE_INTERVAL_MS)
    const down = { ...online, state: 'offline', consecutiveFailures: 30, consecutiveSuccesses: 0 } as const
    expect(nextDelayMs(down, () => 0.999) <= PROBE_BACKOFF_CAP_MS).toBe(true)
    expect(nextDelayMs(down, () => 0)).toBeGreaterThan(0)
  })

  test('start then stop never probes and leaves no timer behind', () => {
    const r = rig()
    r.svc.start(); r.svc.stop()
    expect(r.calls).toHaveLength(0)
  })

  test('the default target is the Anthropic API when no base URL is set', async () => {
    const r = rig()
    await seq(r, 'ok')
    expect(r.calls[0]?.url).toBe(DEFAULT_API_BASE_URL)
  })
})
