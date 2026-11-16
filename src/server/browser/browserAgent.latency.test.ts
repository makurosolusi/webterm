import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockedError } from '../../shared/browser.contract'
import type { BrowserHostApi, BrowserState } from '../../shared/browser.contract'
import { LATENCY_BUFFER_MAX, LATENCY_KEYS, activeLatency, createLatencyRecorder, setActiveLatency } from './browserAgent.latency'
import { SnapshotStore } from './browserAgent.snapshot'
import { createAgentVerbs } from './browserAgent.verbs'
import { LeaseService } from './browserLease.service'

const SECRET = 'SECRET-MARK-9f2c' // test-only
const original = activeLatency()
afterEach(() => setActiveLatency(original))

/** A recorder whose perf clock advances by the next scripted duration on every call pair. */
function scripted(durations: number[]) {
  let t = 0
  let i = 0
  let start = true
  return createLatencyRecorder({ perf: () => { if (start) { start = false; return t } start = true; t += durations[i++] ?? 0; return t }, wall: () => 1000 })
}

describe('ring buffer', () => {
  it('never exceeds its capacity and drops the oldest first', async () => {
    const rec = createLatencyRecorder({ capacity: 3 })
    for (let i = 0; i < 7; i++) await rec.timed(`v${i}`, async () => i)
    expect(rec.records().map((r) => r.verb)).toEqual(['v4', 'v5', 'v6'])
    expect(LATENCY_BUFFER_MAX).toBe(500)
    const big = createLatencyRecorder()
    for (let i = 0; i < LATENCY_BUFFER_MAX + 25; i++) await big.timed('x', async () => 1)
    expect(big.records()).toHaveLength(LATENCY_BUFFER_MAX)
  })
})

describe('what a record may hold', () => {
  const stateOf = (): BrowserState => ({ id: 'n1', url: 'https://a.test/', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })
  const rig = () => {
    const host = { state: stateOf, isLoading: () => false, navigate: vi.fn(async () => undefined), input: vi.fn(async () => undefined), cdp: vi.fn(async () => { throw new Error(`boom ${SECRET}`) }) } as unknown as BrowserHostApi
    let t = 0
    return createAgentVerbs({ host, leases: new LeaseService(() => t), snapshots: new SnapshotStore(), agentAllowed: () => true, sleep: async (ms) => { t += ms }, now: () => t })
  }

  it('only the fixed keys, host instead of URL, no typed text, no error message', async () => {
    const rec = createLatencyRecorder()
    setActiveLatency(rec)
    const verbs = rig()
    const url = `https://user:pw@a.test:8443/path?token=${SECRET}#frag`
    await verbs.navigate('n1', { url })
    await verbs.type('n1', { ref: 'e1', text: `typed ${SECRET}` }).catch(() => undefined)
    await verbs.click('n1', { ref: 'e1', cookie: SECRET }).catch(() => undefined)
    const recs = rec.records()
    expect(recs.length).toBeGreaterThanOrEqual(3)
    for (const r of recs) expect(Object.keys(r).every((k) => (LATENCY_KEYS as readonly string[]).includes(k))).toBe(true)
    expect(JSON.stringify(recs)).not.toContain(SECRET)
    expect(JSON.stringify(recs)).not.toContain('/path')
    expect(recs.find((r) => r.verb === 'navigate')).toMatchObject({ ok: true, host: 'a.test' })
  })
})

describe('failure and robustness', () => {
  it('a failing verb is recorded ok:false with its code and the original error is rethrown unchanged', async () => {
    const rec = createLatencyRecorder()
    setActiveLatency(rec)
    const host = { state: stateOf0, isLoading: () => false, navigate: vi.fn(async () => { throw new BlockedError('private_host', 'evil') }) } as unknown as BrowserHostApi
    function stateOf0() { return { id: 'n1', url: '', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' } as BrowserState }
    const verbs = createAgentVerbs({ host, leases: new LeaseService(() => 0), snapshots: new SnapshotStore(), agentAllowed: () => true, sleep: async () => undefined, now: () => 0 })
    const err = await verbs.navigate('n1', { url: 'https://evil.test/' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BlockedError)
    expect(rec.records()[0]).toMatchObject({ verb: 'navigate', ok: false, code: 'private_host', host: 'evil.test' })
  })

  it('a recorder fault never fails the verb or changes its result', async () => {
    const rec = createLatencyRecorder({ wall: () => { throw new Error('clock broke') } })
    await expect(rec.timed('v', async () => 42)).resolves.toBe(42)
    await expect(rec.timed('v', async () => { throw new TypeError('orig') })).rejects.toThrow('orig')
    expect(rec.records()).toHaveLength(0)
  })

  it('with no active recorder the wrapper is a plain passthrough', async () => {
    setActiveLatency(null)
    const { timed } = await import('./browserAgent.latency')
    await expect(timed('v', async () => 'r')).resolves.toBe('r')
  })
})

describe('summary', () => {
  it('computes count, okRate, p50, p95 and max on synthetic data', async () => {
    const durations = Array.from({ length: 20 }, (_, i) => i + 1) // 1..20 ms
    const rec = scripted(durations)
    for (let i = 0; i < 20; i++) await rec.timed('v', async () => (i === 3 ? { fail: true } : {}), { judge: (r: { fail?: boolean }) => ({ ok: !r.fail, ...(r.fail ? { code: 'x' } : {}) }) })
    expect(rec.summary().v).toEqual({ count: 20, okRate: 0.95, p50: 10, p95: 19, max: 20 })
  })

  it('sinceMs keeps only recent records', async () => {
    let now = 0
    const rec = createLatencyRecorder({ wall: () => now })
    await rec.timed('old', async () => 1)
    now = 10_000
    await rec.timed('new', async () => 1)
    expect(Object.keys(rec.summary({ sinceMs: 5000 }))).toEqual(['new'])
    expect(Object.keys(rec.summary()).sort()).toEqual(['new', 'old'])
  })
})
