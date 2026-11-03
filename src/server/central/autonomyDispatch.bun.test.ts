// Bun-only. Doom-loop against the real SQLite breaker: the item breaker survives a restart (new autonomy, same db).
import { expect, test } from 'bun:test'
import { createCentralAutonomy, type AutonomyDeps } from './centralAutonomy'
import { BREAKER_THRESHOLD, createBreakerStore } from './guard/breakerStore'
import { eventKinds, freshDb, T0 } from './guard/controlGuard.testutil'

test('repeated failure of one item opens the persisted breaker and a restarted loop stays stopped', async () => {
  const db = freshDb()
  let t = T0
  const breaker = createBreakerStore({ db, now: () => t, random: () => 0 })
  let runs = 0
  const make = () => createCentralAutonomy({
    projects: () => [{ id: 'p1', status: 'active' }],
    plan: () => ({ status: 'active', version: 1, items: [{ id: 'i1', seq: 1, status: 'assigned' }] }),
    run: async () => { runs++; return { ok: false, code: 'verify_failed' } },
    audit: () => undefined,
    now: () => t,
    maxConsecutiveFailures: 99,
    dispatch: { breaker },
  } satisfies AutonomyDeps)

  const first = make()
  for (let i = 0; i < BREAKER_THRESHOLD; i++) {
    await first.tick()
    await first.drain()
  }
  expect(runs).toBe(BREAKER_THRESHOLD)
  expect(breaker.peek('item:p1:i1')?.state).toBe('open')
  expect(breaker.peek('item:p1:i1')?.lastCode).toBe('verify_failed')
  expect(eventKinds(db, 'central.breaker').map((e) => e.to)).toContain('open')

  const restarted = make()
  const result = await restarted.tick()
  expect(result.ran).toBe(false)
  expect(runs).toBe(BREAKER_THRESHOLD)
})
