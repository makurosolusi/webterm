// startOutbox memoises a successful start only: a rejected start must not poison every later call.
import { describe, expect, it } from 'vitest'
import { logBus } from '../logs'
import type { OutboxDelivery } from './outboxDelivery'
import { startOutbox } from './outboxRuntime'

describe('startOutbox', () => {
  it('start rejects once then succeeds on next call', async () => {
    const before = logBus.query({}).length
    const ready = {} as OutboxDelivery // test-only stand-in; never used as a real outbox
    let calls = 0
    const build = async (): Promise<OutboxDelivery> => {
      calls += 1
      if (calls === 1) throw new Error('ledger briefly unavailable')
      return ready
    }
    await expect(startOutbox(build)).rejects.toThrow('outbox start failed: ledger briefly unavailable')
    expect(await startOutbox(build)).toBe(ready)
    expect(await startOutbox(build)).toBe(ready)
    expect(calls).toBe(2)
    const entry = logBus.query({}).slice(before).find((e) => e.event === 'outbox.start_failed')
    expect(entry?.level).toBe('error')
    expect(entry?.data).toMatchObject({ error: 'ledger briefly unavailable' })
  })
})
