// `sweepTrashOnBoot`: jalan sekali bila MUTATE on (juga saat kosong: default on), tidak sama sekali bila off, dan error tak menolak.
import { test, expect } from 'bun:test'
import { FILES_FLAG } from './envRegistry.files'
import { createTrashReaper, sweepTrashOnBoot, TRASH_SWEEP_INTERVAL_MS } from './fsBoot'

async function withFlag(v: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[FILES_FLAG.MUTATE]
  if (v === undefined) delete process.env[FILES_FLAG.MUTATE]
  else process.env[FILES_FLAG.MUTATE] = v
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env[FILES_FLAG.MUTATE]
    else process.env[FILES_FLAG.MUTATE] = prev
  }
}

test('MUTATE on: sweep runs exactly once', async () => {
  await withFlag('on', async () => {
    let calls = 0
    await sweepTrashOnBoot(async () => { calls++; return 3 })
    expect(calls).toBe(1)
  })
})

test('MUTATE unset: sweep runs (default on since 2026-11-12)', async () => {
  await withFlag(undefined, async () => {
    let calls = 0
    await sweepTrashOnBoot(async () => { calls++; return 0 })
    expect(calls).toBe(1)
  })
})

test('MUTATE off: sweep never runs', async () => {
  await withFlag('off', async () => {
    let calls = 0
    await sweepTrashOnBoot(async () => { calls++; return 0 })
    expect(calls).toBe(0)
  })
})

test('sweep failure is logged, not thrown', async () => {
  await withFlag('on', async () => {
    let threw = false
    await sweepTrashOnBoot(() => Promise.reject(new Error('boom'))).catch(() => { threw = true })
    expect(threw).toBe(false)
  })
})

test('reaper: first sweep one interval after boot, then at most once per interval, never two at once', async () => {
  await withFlag('on', async () => {
    let calls = 0
    let release: () => void = () => {}
    const reaper = createTrashReaper(() => { calls++; return new Promise<number>((r) => { release = () => r(1) }) }, TRASH_SWEEP_INTERVAL_MS, 0)
    expect(reaper.tick(TRASH_SWEEP_INTERVAL_MS - 1)).toBe(null) // boot just swept
    const first = reaper.tick(TRASH_SWEEP_INTERVAL_MS)
    expect(first).not.toBe(null)
    expect(reaper.tick(10 * TRASH_SWEEP_INTERVAL_MS)).toBe(null) // still running
    release(); await first
    expect(reaper.tick(2 * TRASH_SWEEP_INTERVAL_MS - 1)).toBe(null)
    const second = reaper.tick(2 * TRASH_SWEEP_INTERVAL_MS)
    release(); await second
    expect(calls).toBe(2)
  })
})
