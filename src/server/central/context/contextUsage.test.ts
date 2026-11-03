import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, type Fixture } from '../centralTestFixture.testutil'
import { createCtxTracker, ctxTokensOf, lastCtxTokens, recordCtxTokens } from './contextUsage'

const usage = (inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number) => ({ inputTokens, cacheReadTokens, cacheWriteTokens })

describe('ctx tracker', () => {
  it('sums input and cache of one step and keeps only the LAST step, not a total', () => {
    expect(ctxTokensOf(usage(100, 4_000, 50))).toBe(4_150)
    const tracker = createCtxTracker()
    expect(tracker.value()).toBeNull()
    tracker.observe(usage(100, 4_000, 0))
    tracker.observe(usage(150, 6_000, 0))
    expect(tracker.value()).toBe(6_150)
  })
})

describe('ctx_tokens column', () => {
  let fixture: Fixture
  beforeEach(() => { fixture = openFixture() })
  afterEach(() => fixture.close())

  it('records on a turn and reads the newest succeeded one', () => {
    const insert = (id: string, status: string, at: number) => fixture.db.query(
      `INSERT INTO central_turn (id, conversation_id, message_id, status, started_at) VALUES (?, 'c', 'm', ?, ?)`
    ).run(id, status, at)
    expect(lastCtxTokens(fixture.db, 'c')).toBeNull()
    insert('t1', 'succeeded', 1)
    insert('t2', 'failed', 2)
    recordCtxTokens(fixture.db, 't1', 1234.9)
    recordCtxTokens(fixture.db, 't2', 9999)
    expect(lastCtxTokens(fixture.db, 'c')).toBe(1234)
  })
})
