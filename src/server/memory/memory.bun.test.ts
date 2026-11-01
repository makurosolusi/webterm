// Bun-only (needs bun:sqlite). Exercises the P4a memory claim/promote/supersede/FTS paths.
import { expect, test } from 'bun:test'
import { openLedgerDb } from '../ledger/migration'
import { createLedger } from '../ledger/ledger'
import {
  claimMemory,
  listMemory,
  memoryEvents,
  promoteMemory,
  quarantineMemory,
  searchMemory,
  supersedeMemory,
} from './memory'

const T0 = 1_700_000_000_000

function fixture() {
  const db = openLedgerDb(':memory:')
  const ledger = createLedger(db, { now: T0 })
  ledger.project.createProject({ id: 'p1', workspaceId: 'w1', name: 'Alpha', path: '/tmp/a' })
  ledger.project.createProject({ id: 'p2', workspaceId: 'w2', name: 'Beta', path: '/tmp/b' })
  return db
}

function failure(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return ''
}

const EVIDENCE = { command: 'bun test src/server/memory', exitCode: 0, observedAt: T0 }

function claim(db: ReturnType<typeof fixture>, key: string, body: string, projectId = 'p1') {
  return claimMemory(db, {
    projectId,
    key,
    title: `title ${key}`,
    body,
    sourceKind: 'file',
    sourceRef: 'src/server/memory/memory.ts',
    actor: 'worker-1',
    now: T0,
  })
}

test('claim requires sourceKind and sourceRef', () => {
  const db = fixture()
  const base = {
    projectId: 'p1', key: 'k1', title: 't', body: 'b', actor: 'w', now: T0,
  }
  expect(failure(() => claimMemory(db, { ...base, sourceRef: 'x' } as never)).length > 0).toBe(true)
  expect(failure(() => claimMemory(db, { ...base, sourceKind: 'x' } as never)).length > 0).toBe(true)
  expect(failure(() => claimMemory(db, { ...base, sourceKind: '  ', sourceRef: 'x' })).length > 0).toBe(true)
  expect(failure(() => claimMemory(db, { ...base, sourceKind: 'file', sourceRef: '' })).length > 0).toBe(true)
  expect(listMemory(db, 'p1').length).toBe(0)

  const claim1 = claim(db, 'k1', 'body one')
  expect(claim1.status).toBe('claim')
  expect(claim1.sourceKind).toBe('file')
  // (project, scope, key) is unique: corrections must supersede.
  expect(failure(() => claim(db, 'k1', 'duplicate')).length > 0).toBe(true)
})

test('promotion needs machine evidence and a non-worker actor', () => {
  const db = fixture()
  const c1 = claim(db, 'k1', 'body')
  expect(failure(() => promoteMemory(db, { id: c1.id, actor: 'o', actorKind: 'orchestrator', now: T0 } as never)).length > 0).toBe(true)
  expect(failure(() => promoteMemory(db, {
    id: c1.id, actor: 'o', actorKind: 'orchestrator', now: T0,
    evidence: { command: 'bun test', exitCode: 1, observedAt: T0 },
  })).length > 0).toBe(true)
  expect(failure(() => promoteMemory(db, {
    id: c1.id, actor: 'o', actorKind: 'orchestrator', now: T0,
    evidence: { command: '', exitCode: 0, observedAt: T0 },
  })).length > 0).toBe(true)
  // Forged: evidence claims to be observed far in the future.
  expect(failure(() => promoteMemory(db, {
    id: c1.id, actor: 'o', actorKind: 'orchestrator', now: T0,
    evidence: { ...EVIDENCE, observedAt: T0 + 10 * 365 * 24 * 3600_000 },
  })).length > 0).toBe(true)
  // Worker may not promote even with perfect evidence.
  expect(failure(() => promoteMemory(db, {
    id: c1.id, actor: 'w', actorKind: 'worker', evidence: EVIDENCE, now: T0,
  })).length > 0).toBe(true)

  const fact = promoteMemory(db, { id: c1.id, actor: 'orch', actorKind: 'orchestrator', evidence: EVIDENCE, now: T0 })
  expect(fact.status).toBe('fact')
  expect(listMemory(db, 'p1', { status: 'claim' }).length).toBe(0)
})

test('core scope is human-only; supersede keeps history', () => {
  const db = fixture()
  const core = claimMemory(db, {
    projectId: 'p1', scope: 'core', key: 'policy', title: 'Policy', body: 'core policy',
    sourceKind: 'human', sourceRef: 'CORE.md', actor: 'human-1', actorKind: 'human', now: T0,
  })
  expect(failure(() => promoteMemory(db, {
    id: core.id, actor: 'orch', actorKind: 'orchestrator', evidence: EVIDENCE, now: T0,
  })).length > 0).toBe(true)

  const c = claim(db, 'db-config', 'retention is 30 days')
  const first = promoteMemory(db, {
    id: c.id, actor: 'orch', actorKind: 'orchestrator', evidence: EVIDENCE, now: T0,
  })
  const second = supersedeMemory(db, {
    id: first.id, title: 'db config', body: 'retention is 90 days',
    sourceKind: 'file', sourceRef: 'docs/db.md', actor: 'orch', actorKind: 'orchestrator',
    evidence: { command: 'bun test', exitCode: 0, observedAt: T0 + 1000 }, now: T0 + 1000,
  })
  expect(second.status).toBe('fact')
  expect(second.supersedes).toBe(first.id)
  expect(second.body).toBe('retention is 90 days')

  const all = listMemory(db, 'p1')
  expect(all.length).toBe(3)
  const old = all.find((row) => row.id === first.id)
  expect(old?.status).toBe('superseded')
  expect(old?.supersededAt).toBe(T0 + 1000)

  const hits = searchMemory(db, 'p1', 'retention', 10)
  expect(hits.length).toBe(1)
  expect(hits[0]?.id).toBe(second.id)
  expect(hits[0]?.body).toBe('retention is 90 days')
})

test('FTS search uses MATCH + bm25 and neutralises query syntax', () => {
  const db = fixture()
  const strong = claim(db, 'strong', 'postgres migration runbook')
  promoteMemory(db, { id: strong.id, actor: 'o', actorKind: 'human', evidence: EVIDENCE, now: T0 })
  const weak = claim(
    db,
    'weak',
    'a very long note about unrelated deployment steps and rollback checks that only ' +
      'mentions postgres migration once near the end of a much longer paragraph'
  )
  promoteMemory(db, { id: weak.id, actor: 'o', actorKind: 'human', evidence: EVIDENCE, now: T0 })
  const claimOnly = claim(db, 'draft', 'postgres migration draft not promoted')
  expect(claimOnly.status).toBe('claim')

  const hits = searchMemory(db, 'p1', 'postgres migration', 10)
  expect(hits.length).toBe(2)
  expect(hits[0]?.id).toBe(strong.id)
  expect(hits[0]?.rank < hits[1]!.rank).toBe(true)

  // Raw FTS operators would throw (`foo AND`, lone quote). Tokenising makes them inert.
  for (const query of ['postgres AND', '"', '* OR ""', 'postgres" OR body:x', 'NEAR(']) {
    expect(failure(() => searchMemory(db, 'p1', query, 10))).toBe('')
  }
  expect(searchMemory(db, 'p1', '* OR ""', 10).length).toBe(0)
})

test('search and listing stay inside one project', () => {
  const db = fixture()
  const a = claim(db, 'shared-key', 'alpha postgres note', 'p1')
  const b = claim(db, 'shared-key', 'beta postgres note', 'p2')
  promoteMemory(db, { id: a.id, actor: 'o', actorKind: 'human', evidence: EVIDENCE, now: T0 })
  promoteMemory(db, { id: b.id, actor: 'o', actorKind: 'human', evidence: EVIDENCE, now: T0 })
  const hits = searchMemory(db, 'p2', 'postgres', 10)
  expect(hits.length).toBe(1)
  expect(hits[0]?.id).toBe(b.id)
  expect(listMemory(db, 'p1').length).toBe(1)
})

test('quarantine and the audit trail are recorded', () => {
  const db = fixture()
  const c = claim(db, 'k', 'body')
  promoteMemory(db, { id: c.id, actor: 'o', actorKind: 'orchestrator', evidence: EVIDENCE, now: T0 })
  const q = quarantineMemory(db, {
    id: c.id, reason: 'source diverged', actor: 'orch', actorKind: 'orchestrator', now: T0 + 1,
  })
  expect(q.status).toBe('quarantine')
  expect(searchMemory(db, 'p1', 'body', 10).length).toBe(0)
  const kinds = memoryEvents(db, c.id).map((event) => event.kind).join(',')
  expect(kinds).toBe('memory.claim,memory.promote,memory.quarantine')
})
