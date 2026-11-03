// `sweepTrashOnBoot`: jalan sekali bila MUTATE on, tidak sama sekali bila off, dan error tak menolak.
import { test, expect } from 'bun:test'
import { FILES_FLAG } from './envRegistry.files'
import { sweepTrashOnBoot } from './fsBoot'

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

test('MUTATE off: sweep never runs', async () => {
  await withFlag(undefined, async () => {
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
