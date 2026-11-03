import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconcile } from './featureCapabilities.runtime'
import { startCentralAutonomyBoot, type AutonomyController } from './centralAutonomyBoot'
import type { AutonomyPlan } from './central/centralAutonomy'

const ON = { WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on', WEBTERM_CENTRAL_AUTONOMY: 'on' }
const PLAN: AutonomyPlan = { status: 'active', version: 1, items: [{ id: 'i1', seq: 1, status: 'assigned' }] }
const FAKE_RUNTIME = { db: {}, ledger: { event: { appendEvent: () => undefined } } } as never
const live: AutonomyController[] = []

function boot(env: Record<string, string | undefined>, run = vi.fn(async () => ({ ok: true }))) {
  const warn = vi.fn()
  const c = startCentralAutonomyBoot({
    runtime: FAKE_RUNTIME,
    env,
    warn,
    log: () => undefined,
    overrides: { projects: () => [{ id: 'p1', status: 'active' }], plan: () => PLAN, run },
  })
  live.push(c)
  return { c, run, warn }
}

afterEach(() => {
  for (const c of live.splice(0)) {
    c.stop()
    c.dispose()
  }
  vi.useRealTimers()
})

describe('centralAutonomyBoot', () => {
  it('returns a controller (never null) when everything is off, and ticks send nothing', async () => {
    const { c, run } = boot({})
    expect(c.running).toBe(false)
    expect(await c.tick()).toEqual({ ran: false, reason: 'no_projects' })
    expect(run).not.toHaveBeenCalled()
  })

  it('returns a no-op controller without a ledger, warning only when asked to start', async () => {
    const warn = vi.fn()
    const c = startCentralAutonomyBoot({ runtime: null, env: ON, warn, log: () => undefined })
    live.push(c)
    expect(c.running).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(await c.tick()).toEqual({ ran: false, reason: 'no_projects' })
  })

  it('does not warn about approval at boot (autonomy never approving is normal)', () => {
    const { warn } = boot({ ...ON, WEBTERM_RUN_REQUIRE_APPROVAL: 'on' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('starts through reconcile and then ticks send', async () => {
    const env: Record<string, string | undefined> = { WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on' }
    const { c, run } = boot(env)
    expect(c.running).toBe(false)
    env.WEBTERM_CENTRAL_AUTONOMY = 'on'
    await reconcile(new Set(['central', 'workers']), new Set(['central', 'workers', 'autonomy']))
    expect(c.running).toBe(true)
    expect(await c.tick()).toMatchObject({ ran: true, projectId: 'p1', itemId: 'i1', ok: true })
    expect(run).toHaveBeenCalledWith('p1', 'i1', 1)
  })

  it('the interval itself drives ticks while on, and flipping the flag off silences it', async () => {
    vi.useFakeTimers()
    const env: Record<string, string | undefined> = { ...ON }
    const { c, run } = startBootWithInterval(env)
    expect(c.running).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    const sent = run.mock.calls.length
    expect(sent).toBeGreaterThan(0)
    env.WEBTERM_CENTRAL_AUTONOMY = 'off'
    await vi.advanceTimersByTimeAsync(3000)
    expect(run.mock.calls.length).toBe(sent)
  })

  it('start;start, stop;stop and start;stop;start are idempotent', () => {
    const { c } = boot({})
    c.start()
    c.start()
    expect(c.running).toBe(true)
    c.stop()
    c.stop()
    expect(c.running).toBe(false)
    c.start()
    c.stop()
    c.start()
    expect(c.running).toBe(true)
  })

  it('workers off while autonomy is on (legacy) sends nothing', async () => {
    const { c, run } = boot({ WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_AUTONOMY: 'on' })
    c.start()
    expect(await c.tick()).toEqual({ ran: false, reason: 'no_projects' })
    expect(run).not.toHaveBeenCalled()
  })

  it('stop does not cancel a dispatch already in flight', async () => {
    let release!: () => void
    const run = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { release = () => resolve({ ok: true }) }))
    const { c } = boot(ON, run)
    const pending = c.tick()
    c.stop()
    expect(c.running).toBe(false)
    release()
    expect(await pending).toMatchObject({ ran: true, ok: true })
  })

  it('a throwing start is caught and warned, not thrown', () => {
    const warn = vi.fn()
    const c = startCentralAutonomyBoot({
      runtime: FAKE_RUNTIME, env: ON, warn, log: () => { throw new Error('boom') },
      overrides: { projects: () => [], plan: () => null },
    })
    live.push(c)
    expect(warn).toHaveBeenCalledWith('central autonomy: start failed (Error)')
  })
})

function startBootWithInterval(env: Record<string, string | undefined>) {
  const run = vi.fn(async () => ({ ok: true }))
  const c = startCentralAutonomyBoot({
    runtime: FAKE_RUNTIME, env, intervalMs: 500, log: () => undefined, warn: () => undefined,
    overrides: { projects: () => [{ id: 'p1', status: 'active' }], plan: () => PLAN, run },
  })
  live.push(c)
  return { c, run }
}
