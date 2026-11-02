import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createLedger } from './ledger'
import { openLedgerDb } from './migration'

const T0 = 1_700_000_000_000

function fixture() {
  const db: Database = openLedgerDb(':memory:')
  const clock = { at: T0 }
  const ledger = createLedger(db, { now: () => clock.at })
  ledger.project.createProject({ id: 'p1', workspaceId: 'w1', name: 'p', path: '/tmp/p' })
  ledger.project.createProject({ id: 'p2', workspaceId: 'w2', name: 'q', path: '/tmp/q' })
  return { db, ledger, clock }
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

test('run lifecycle is idempotent and paginated', () => {
  const { ledger } = fixture()
  const run = ledger.run.startRun({
    id: 'r1',
    projectId: 'p1',
    depth: 0,
    provider: 'anthropic',
    model: 'claude',
    route: 'direct',
  })
  expect(run.endedAt).toBe(null)
  const done = ledger.run.finishRun('r1', {
    outcome: 'success',
    evidence: { tests: 12 },
    versions: { node: '22' },
  })
  expect(done.outcome).toBe('success')
  expect(done.endedAt).toBe(T0)
  // Second finish must not overwrite evidence or end time.
  const again = ledger.run.finishRun('r1', { outcome: 'failed', endedAt: T0 + 5_000 })
  expect(again.outcome).toBe('success')
  expect(again.endedAt).toBe(T0)
  expect(ledger.run.listRuns('p1').length).toBe(1)
  expect(ledger.run.getRun('missing')).toBe(null)
})

test('usage dedupes provider response ids and keeps unknown buckets null', () => {
  const { ledger } = fixture()
  ledger.run.startRun({ id: 'r1', projectId: 'p1', depth: 0 })
  const first = ledger.usage.recordUsage({
    runId: 'r1',
    providerResponseId: 'resp-1',
    inputTokens: 10,
    outputTokens: 5,
    costMicros: 1234,
    priceKnown: true,
  })
  const dup = ledger.usage.recordUsage({
    runId: 'r1',
    providerResponseId: 'resp-1',
    inputTokens: 999,
  })
  expect(dup.id).toBe(first.id)
  expect(dup.inputTokens).toBe(10)

  const unknown = ledger.usage.recordUsage({ runId: 'r1', inputTokens: 7 })
  expect(unknown.cacheReadTokens).toBe(null)
  expect(unknown.costMicros).toBe(null)
  expect(unknown.priceKnown).toBe(false)

  const sum = ledger.usage.sumUsage('p1')
  expect(sum.costMicros).toBe(1234)
  expect(sum.inputTokens).toBe(17)
  expect(sum.unpricedRecords).toBe(1)
  expect(ledger.usage.sumUsage('p2').costMicros).toBe(0)
})

test('budget hard cap allows up to the limit and denies beyond it', () => {
  const { ledger } = fixture()
  ledger.run.startRun({ id: 'r1', projectId: 'p1', depth: 0 })
  ledger.usage.recordUsage({ runId: 'r1', costMicros: 600, priceKnown: true })
  ledger.budget.setBudget({ projectId: 'p1', limitMicros: 1000 })

  const ok = ledger.usage.checkBudget({ projectId: 'p1', estimateMicros: 400 })
  expect(ok.allowed).toBe(true)
  expect(ok.spentMicros).toBe(600)
  expect(ok.remainingMicros).toBe(400)
  const denied = ledger.usage.checkBudget({ projectId: 'p1', estimateMicros: 401 })
  expect(denied.allowed).toBe(false)

  ledger.budget.setBudget({ projectId: 'p1', limitMicros: 1000, hardCap: false })
  expect(ledger.usage.checkBudget({ projectId: 'p1', estimateMicros: 10_000 }).allowed).toBe(true)
  expect(ledger.usage.checkBudget({ projectId: 'p2', estimateMicros: 1 }).allowed).toBe(true)
})

test('invalid token buckets are rejected instead of silently coerced', () => {
  const { ledger } = fixture()
  ledger.run.startRun({ id: 'r1', projectId: 'p1', depth: 0 })
  expect(throws(() => ledger.usage.recordUsage({ runId: 'r1', inputTokens: -1 }))).toBe(true)
  expect(throws(() => ledger.budget.setBudget({ projectId: 'p1', limitMicros: -5 }))).toBe(true)
  expect(throws(() => ledger.run.startRun({ projectId: 'p1', depth: 3 }))).toBe(true)
})
