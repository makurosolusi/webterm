import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCentralAutonomy, type AutonomyAuditEvent, type AutonomyDeps, type AutonomyPlan } from './centralAutonomy'
import { DEFAULT_MAX_INFLIGHT_WORKERS, maxInflightFromEnv, reliabilityEnabled } from './autonomyDispatch'
import { BREAKER_THRESHOLD, type BreakerRow, type SyncBreaker } from './guard/breakerStore'
import { WAKE_DEBOUNCE_MS, WAKE_SWEEP_MS } from './wake'

afterEach(() => vi.useRealTimers())

const T0 = 1_700_000_000_000
const assigned = (id: string): AutonomyPlan => ({ status: 'active', version: 4, items: [{ id, seq: 1, status: 'assigned' }] })

/** In-memory SyncBreaker with the real threshold semantics; the SQLite one is covered by the .bun test. */
function fakeBreaker(clock: () => number) {
  const rows = new Map<string, BreakerRow>()
  const put = (key: string, patch: Partial<BreakerRow>) => rows.set(key, { key, state: 'closed', failures: 0, openedAt: null, retryAt: null, lastCode: null, ...rows.get(key), ...patch })
  const breaker: SyncBreaker = {
    peek: (k) => rows.get(k) ?? null,
    allow: (k) => {
      const r = rows.get(k)
      if (!r || r.state === 'closed') return { allowed: true, state: 'closed' }
      if (clock() < (r.retryAt ?? 0)) return { allowed: false, state: r.state, retryAt: r.retryAt ?? 0 }
      put(k, { state: 'half_open' })
      return { allowed: true, state: 'half_open' }
    },
    trip: (k, code) => {
      const failures = (rows.get(k)?.failures ?? 0) + 1
      const open = failures >= BREAKER_THRESHOLD || rows.get(k)?.state === 'half_open'
      put(k, { failures, lastCode: code, state: open ? 'open' : 'closed', retryAt: open ? clock() + 60_000 : null })
      return open ? 'open' : 'closed'
    },
    recordSuccess: (k) => { rows.delete(k) },
    open: (k, code) => { put(k, { state: 'open', lastCode: code, retryAt: clock() + 60_000 }); return 'open' },
  }
  return breaker
}

/** A run whose completion the test controls. */
function gate() {
  const pending: Array<(r: { ok: boolean; code?: string }) => void> = []
  const calls: string[] = []
  const run: AutonomyDeps['run'] = (p, i) => { calls.push(`${p}/${i}`); return new Promise((res) => pending.push(res)) }
  return { run, calls, release: (r: { ok: boolean; code?: string } = { ok: true }) => pending.shift()?.(r) }
}

function setup(projects: string[], over: Partial<AutonomyDeps> = {}) {
  const audits: AutonomyAuditEvent[] = []
  const plans = new Map(projects.map((p) => [p, assigned(`${p}-i1`)]))
  const deps: AutonomyDeps = {
    projects: () => projects.map((id) => ({ id, status: 'active' })),
    plan: (id) => plans.get(id) ?? null,
    run: async () => ({ ok: true }),
    audit: (e) => audits.push(e),
    now: () => T0,
    ...over,
  }
  return { deps, audits }
}

describe('dispatch mode', () => {
  it('tick returns while the worker is still running and tracks it in flight', async () => {
    const g = gate()
    const { deps } = setup(['p1'], { run: g.run, dispatch: {} })
    const autonomy = createCentralAutonomy(deps)
    const result = await autonomy.tick()
    expect(result).toMatchObject({ ran: true, projectId: 'p1', itemId: 'p1-i1', dispatched: 1 })
    expect(autonomy.inflight).toBe(1)
    // The same item is not claimed twice while its worker runs.
    expect(await autonomy.tick()).toEqual({ ran: false, reason: 'no_eligible' })
    expect(g.calls).toEqual(['p1/p1-i1'])
    g.release()
    await autonomy.drain()
    expect(autonomy.inflight).toBe(0)
    expect(autonomy.failures('p1')).toBe(0)
  })

  it('never exceeds maxInflight and resumes when a slot frees up', async () => {
    const g = gate()
    const { deps } = setup(['p1', 'p2', 'p3'], { run: g.run, dispatch: { maxInflight: 2 } })
    const autonomy = createCentralAutonomy(deps)
    expect(await autonomy.tick()).toMatchObject({ ran: true, dispatched: 2 })
    expect(autonomy.inflight).toBe(2)
    expect(await autonomy.tick()).toEqual({ ran: false, reason: 'saturated' })
    expect(g.calls).toHaveLength(2)
    g.release()
    await new Promise((r) => setTimeout(r, 0))
    expect(autonomy.inflight).toBe(1)
    // Round-robin: the project skipped last time goes first now.
    expect(await autonomy.tick()).toMatchObject({ ran: true, projectId: 'p3', dispatched: 1 })
    expect(g.calls).toHaveLength(3)
    g.release(); g.release()
    await autonomy.drain()
  })

  it('defaults the cap to 3 workers', async () => {
    const g = gate()
    const { deps } = setup(['p1', 'p2', 'p3', 'p4'], { run: g.run, dispatch: {} })
    const autonomy = createCentralAutonomy(deps)
    await autonomy.tick()
    expect(autonomy.inflight).toBe(DEFAULT_MAX_INFLIGHT_WORKERS)
    for (let i = 0; i < 3; i++) g.release()
    await autonomy.drain()
  })

  it('doom-loop: the same failure root opens the persistent breaker and stops dispatch until reset', async () => {
    let t = T0
    const breaker = fakeBreaker(() => t)
    const run = vi.fn(async () => ({ ok: false, code: 'verify_failed' }))
    const { deps, audits } = setup(['p1'], { run, now: () => t, maxConsecutiveFailures: 99, dispatch: { breaker } })
    const autonomy = createCentralAutonomy(deps)
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      expect(await autonomy.tick()).toMatchObject({ ran: true })
      await autonomy.drain()
    }
    expect(run).toHaveBeenCalledTimes(BREAKER_THRESHOLD)
    expect(breaker.peek('item:p1:p1-i1')).toMatchObject({ state: 'open', lastCode: 'verify_failed' })
    expect(audits.filter((a) => a.kind === 'autonomy.breaker_open')).toHaveLength(1)

    expect(await autonomy.tick()).toEqual({ ran: false, reason: 'no_eligible' })
    expect(run).toHaveBeenCalledTimes(BREAKER_THRESHOLD)

    // Past retry_at one probe is admitted; a success closes the breaker again.
    t += 60 * 60_000
    run.mockResolvedValueOnce({ ok: true } as never)
    expect(await autonomy.tick()).toMatchObject({ ran: true })
    await autonomy.drain()
    expect(breaker.peek('item:p1:p1-i1')).toBeNull()
  })

  it('different failure roots do not add up to a doom-loop', async () => {
    const breaker = fakeBreaker(() => T0)
    const codes = ['a', 'b', 'a', 'b', 'a']
    const run = vi.fn(async () => ({ ok: false, code: codes.shift() }))
    const { deps } = setup(['p1'], { run, maxConsecutiveFailures: 99, dispatch: { breaker } })
    const autonomy = createCentralAutonomy(deps)
    for (let i = 0; i < 5; i++) {
      await autonomy.tick()
      await autonomy.drain()
    }
    expect(run).toHaveBeenCalledTimes(5)
    expect(breaker.peek('item:p1:p1-i1')?.state).toBe('closed')
  })

  it('a thrown worker counts as a failure and frees its slot', async () => {
    const { deps } = setup(['p1'], { run: async () => { throw new Error('x') }, dispatch: { maxInflight: 1 } })
    const autonomy = createCentralAutonomy(deps)
    await autonomy.tick()
    await autonomy.drain()
    expect(autonomy.inflight).toBe(0)
    expect(autonomy.failures('p1')).toBe(1)
  })

  it('wakes on success after the debounce, sweeps every 60 s, and stop() leaves no timers', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => ({ ok: true }))
    const { deps } = setup(['p1'], { run, dispatch: {} })
    const autonomy = createCentralAutonomy(deps)
    autonomy.start()
    expect(autonomy.running).toBe(true)
    autonomy.wake('assigned')
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS - 1)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    // The success settled in that same turn and scheduled its own wake.
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS)
    const before = run.mock.calls.length
    await vi.advanceTimersByTimeAsync(WAKE_SWEEP_MS)
    expect(run.mock.calls.length).toBeGreaterThan(before)
    autonomy.stop()
    expect(autonomy.running).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('flag off keeps the legacy loop', () => {
  it('awaits the worker inside tick, overlaps are refused, wake/inflight are inert', async () => {
    const g = gate()
    const { deps } = setup(['p1', 'p2'], { run: g.run })
    const autonomy = createCentralAutonomy(deps)
    const first = autonomy.tick()
    let settled = false
    void first.then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)
    expect(await autonomy.tick()).toEqual({ ran: false, reason: 'overlap' })
    expect(autonomy.inflight).toBe(0)
    autonomy.wake('x')
    g.release()
    expect(await first).toEqual({ ran: true, projectId: 'p1', itemId: 'p1-i1', ok: true })
    expect(g.calls).toEqual(['p1/p1-i1'])
    await autonomy.drain()
  })

  it('reads the flag and cap strictly', () => {
    expect(reliabilityEnabled(undefined)).toBe(false)
    expect(reliabilityEnabled('true')).toBe(false)
    expect(reliabilityEnabled(' ON ')).toBe(true)
    expect(maxInflightFromEnv(undefined)).toBe(3)
    expect(maxInflightFromEnv('0')).toBe(3)
    expect(maxInflightFromEnv('abc')).toBe(3)
    expect(maxInflightFromEnv('5')).toBe(5)
  })
})
