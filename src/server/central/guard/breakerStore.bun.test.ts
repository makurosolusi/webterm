// Bun-only. Persistent breaker: threshold, backoff, half_open single probe, survives restart.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BREAKER_BASE_MS, BREAKER_MAX_MS, BREAKER_PROBE_LEASE_MS, BREAKER_THRESHOLD, createBreakerStore } from './breakerStore'
import { eventKinds, freshDb, T0 } from './controlGuard.testutil'

const KEY = 'provider:free' as const

function clocked() {
  let t = T0
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

test('opens after the threshold, probes once half_open, closes on success', () => {
  const db = freshDb()
  const clock = clocked()
  const b = createBreakerStore({ db, now: clock.now, random: () => 0 })
  for (let i = 1; i < BREAKER_THRESHOLD; i++) expect(b.trip(KEY, '429')).toBe('closed')
  expect(b.allow(KEY).allowed).toBe(true)
  expect(b.trip(KEY, '429')).toBe('open')
  const denied = b.allow(KEY)
  expect(denied.allowed).toBe(false)
  expect(denied.state).toBe('open')
  expect(denied.retryAt).toBe(T0 + BREAKER_BASE_MS)

  clock.advance(BREAKER_BASE_MS)
  const probe = b.allow(KEY)
  expect(probe.allowed).toBe(true)
  expect(probe.state).toBe('half_open')
  expect(b.allow(KEY).allowed).toBe(false)

  b.recordSuccess(KEY)
  expect(b.allow(KEY).state).toBe('closed')
  expect(b.peek(KEY)?.failures).toBe(0)
  const states = eventKinds(db, 'central.breaker').map((e) => e.to)
  expect(states.join(',')).toBe('open,half_open,closed')
})

test('a failed probe reopens with a longer backoff, capped at the maximum', () => {
  const db = freshDb()
  const clock = clocked()
  const b = createBreakerStore({ db, now: clock.now, random: () => 0 })
  for (let i = 0; i < BREAKER_THRESHOLD; i++) b.trip(KEY, 'x')
  clock.advance(BREAKER_BASE_MS)
  expect(b.allow(KEY).state).toBe('half_open')
  expect(b.trip(KEY, 'x')).toBe('open')
  expect(b.peek(KEY)?.retryAt).toBe(clock.now() + BREAKER_BASE_MS * 2)
  for (let i = 0; i < 30; i++) { clock.advance(BREAKER_MAX_MS); b.allow(KEY); b.trip(KEY, 'x') }
  expect((b.peek(KEY)?.retryAt ?? 0) - clock.now()).toBe(BREAKER_MAX_MS)
})

test('a probe that never reports frees the slot after the lease', () => {
  const clock = clocked()
  const b = createBreakerStore({ db: freshDb(), now: clock.now, random: () => 0 })
  for (let i = 0; i < BREAKER_THRESHOLD; i++) b.trip(KEY, 'x')
  clock.advance(BREAKER_BASE_MS)
  expect(b.allow(KEY).allowed).toBe(true)
  clock.advance(BREAKER_PROBE_LEASE_MS)
  expect(b.allow(KEY).allowed).toBe(true)
})

test('an open breaker survives closing and reopening the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca2-breaker-'))
  try {
    const path = join(dir, 'ledger.db')
    const first = freshDb(path)
    const b1 = createBreakerStore({ db: first, now: () => T0, random: () => 0 })
    for (let i = 0; i < BREAKER_THRESHOLD; i++) b1.trip('project:p1', 'crash')
    ;(first as unknown as { close(): void }).close()

    const second = freshDb(path)
    const b2 = createBreakerStore({ db: second, now: () => T0 + 1, random: () => 0 })
    const d = b2.allow('project:p1')
    expect(d.allowed).toBe(false)
    expect(d.state).toBe('open')
    expect(b2.peek('project:p1')?.lastCode).toBe('crash')
    ;(second as unknown as { close(): void }).close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
