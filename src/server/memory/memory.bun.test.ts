// Bun-only (needs bun:sqlite). Exercises the P4a memory claim/promote/supersede/FTS paths and the
// M2 authority rule: the actor kind is server-derived, never read from the payload.
import { expect, test } from 'bun:test'
import { openLedgerDb } from '../ledger/migration'
import { createLedger } from '../ledger/ledger'
import {
  type ClaimMemoryInput,
  type MemoryAuthority,
  claimMemory,
  listMemory,
  memoryEvents,
  promoteMemory,
  quarantineMemory,
  searchMemory,
  supersedeMemory,
} from './memory'

const T0 = 1_700_000_000_000

const WORKER: MemoryAuthority = { kind: 'worker', id: 'worker-1' }
const ORCH: MemoryAuthority = { kind: 'orchestrator', id: 'orch' }
const HUMAN: MemoryAuthority = { kind: 'human', id: 'human-1' }

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

function input(key: string, body: string, projectId = 'p1'): ClaimMemoryInput {
  return {
    projectId,
    key,
    title: `title ${key}`,
    body,
    sourceKind: 'file',
    sourceRef: 'src/server/memory/memory.ts',
    now: T0,
  }
}

function claim(db: ReturnType<typeof fixture>, key: string, body: string, projectId = 'p1') {
  return claimMemory(db, WORKER, input(key, body, projectId))
}

test('claim requires sourceKind and sourceRef', () => {
  const db = fixture()
  // Provenance fields omitted one at a time: a partial claim must never be stored.
  const base = input('k1', 'b')
  const partial = {
    projectId: base.projectId,
    key: base.key,
    title: base.title,
    body: base.body,
    now: base.now,
  }
  expect(failure(() => claimMemory(db, WORKER, { ...partial, sourceRef: 'x' } as never)).length > 0).toBe(true)
  expect(failure(() => claimMemory(db, WORKER, { ...partial, sourceKind: 'x' } as never)).length > 0).toBe(true)
  expect(failure(() => claimMemory(db, WORKER, { ...partial, sourceKind: '  ', sourceRef: 'x' })).length > 0).toBe(true)
  expect(failure(() => claimMemory(db, WORKER, { ...partial, sourceKind: 'file', sourceRef: '' })).length > 0).toBe(true)
  expect(listMemory(db, 'p1').length).toBe(0)

  const claim1 = claim(db, 'k1', 'body one')
  expect(claim1.status).toBe('claim')
  expect(claim1.sourceKind).toBe('file')
  // (project, scope, key) is unique: corrections must supersede.
  expect(failure(() => claim(db, 'k1', 'duplicate')).length > 0).toBe(true)
})

test('M2: a worker cannot create core scope even if the payload declares a human', () => {
  const db = fixture()
  const forged = {
    ...input('policy', 'core policy'),
    scope: 'core',
    // Caller-declared authority fields must be inert: they are not part of the input type.
    actor: 'human-1',
    actorKind: 'human',
  } as never
  expect(failure(() => claimMemory(db, WORKER, forged))).toContain('core is human-only')
  expect(listMemory(db, 'p1').length).toBe(0)

  const core = claimMemory(db, HUMAN, { ...input('policy', 'core policy'), scope: 'core' })
  expect(core.status).toBe('claim')
  expect(core.scope).toBe('core')
})

test('M2: an absent or malformed authority is rejected, never defaulted', () => {
  const db = fixture()
  const body = input('k1', 'body')
  expect(failure(() => claimMemory(db, undefined as never, body))).toContain('authority is required')
  expect(failure(() => claimMemory(db, { kind: 'root' as never, id: 'x' }, body))).toContain(
    'authority kind must be one of'
  )
  expect(failure(() => claimMemory(db, { kind: 'worker', id: '  ' }, body))).toContain(
    'authority id'
  )
  expect(listMemory(db, 'p1').length).toBe(0)
})

test('promotion needs machine evidence and a non-worker authority', () => {
  const db = fixture()
  const c1 = claim(db, 'k1', 'body')
  expect(failure(() => promoteMemory(db, ORCH, { id: c1.id, now: T0 } as never)).length > 0).toBe(true)
  expect(failure(() => promoteMemory(db, ORCH, {
    id: c1.id, now: T0,
    evidence: { command: 'bun test', exitCode: 1, observedAt: T0 },
  })).length > 0).toBe(true)
  expect(failure(() => promoteMemory(db, ORCH, {
    id: c1.id, now: T0,
    evidence: { command: '', exitCode: 0, observedAt: T0 },
  })).length > 0).toBe(true)
  // Forged: evidence claims to be observed far in the future.
  expect(failure(() => promoteMemory(db, ORCH, {
    id: c1.id, now: T0,
    evidence: { ...EVIDENCE, observedAt: T0 + 10 * 365 * 24 * 3600_000 },
  })).length > 0).toBe(true)
  // A digest that is not verifier output is rejected.
  expect(failure(() => promoteMemory(db, ORCH, {
    id: c1.id, now: T0,
    evidence: { ...EVIDENCE, digest: 'not-a-digest' },
  }))).toContain('evidence.digest')
  // Worker may not promote even with perfect evidence.
  expect(failure(() => promoteMemory(db, WORKER, { id: c1.id, evidence: EVIDENCE, now: T0 }))).toContain(
    'workers may only claim'
  )
  // ... and a payload-supplied `actorKind: 'human'` does not upgrade that authority.
  expect(failure(() => promoteMemory(db, WORKER, {
    id: c1.id, evidence: EVIDENCE, now: T0, actorKind: 'human', actor: 'human-1',
  } as never)).length > 0).toBe(true)
  expect(listMemory(db, 'p1', { status: 'claim' }).length).toBe(1)

  const fact = promoteMemory(db, ORCH, {
    id: c1.id,
    evidence: { ...EVIDENCE, digest: 'a'.repeat(64) },
    now: T0,
  })
  expect(fact.status).toBe('fact')
  expect(listMemory(db, 'p1', { status: 'claim' }).length).toBe(0)
})

test('audit rows record the server-derived actor, not the payload', () => {
  const db = fixture()
  const c = claim(db, 'audit', 'body')
  promoteMemory(db, ORCH, { id: c.id, evidence: EVIDENCE, now: T0 })
  const events = memoryEvents(db, c.id)
  expect(events.map((event) => event.actor).join(',')).toBe('worker-1,orch')
  expect((events[1]?.payload as { actorKind?: string }).actorKind).toBe('orchestrator')
})

test('core scope is human-only; supersede keeps history', () => {
  const db = fixture()
  const core = claimMemory(db, HUMAN, { ...input('policy', 'core policy'), scope: 'core' })
  expect(failure(() => promoteMemory(db, ORCH, {
    id: core.id, evidence: EVIDENCE, now: T0,
  }))).toContain("scope 'core' is human-only")

  const c = claim(db, 'db-config', 'retention is 30 days')
  const first = promoteMemory(db, ORCH, { id: c.id, evidence: EVIDENCE, now: T0 })
  const second = supersedeMemory(db, ORCH, {
    id: first.id, title: 'db config', body: 'retention is 90 days',
    sourceKind: 'file', sourceRef: 'docs/db.md',
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

test('M2: a worker cannot supersede a fact into a new fact', () => {
  const db = fixture()
  const c = claim(db, 'cfg', 'retention is 30 days')
  const first = promoteMemory(db, ORCH, { id: c.id, evidence: EVIDENCE, now: T0 })
  expect(failure(() => supersedeMemory(db, WORKER, {
    id: first.id, title: 't', body: 'b', sourceKind: 'file', sourceRef: 'f',
    evidence: EVIDENCE, now: T0,
  }))).toContain('workers may only claim')
  expect(listMemory(db, 'p1').length).toBe(1)
})

test('FTS search uses MATCH + bm25 and neutralises query syntax', () => {
  const db = fixture()
  const strong = claim(db, 'strong', 'postgres migration runbook')
  promoteMemory(db, HUMAN, { id: strong.id, evidence: EVIDENCE, now: T0 })
  const weak = claim(
    db,
    'weak',
    'a very long note about unrelated deployment steps and rollback checks that only ' +
      'mentions postgres migration once near the end of a much longer paragraph'
  )
  promoteMemory(db, HUMAN, { id: weak.id, evidence: EVIDENCE, now: T0 })
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
  promoteMemory(db, HUMAN, { id: a.id, evidence: EVIDENCE, now: T0 })
  promoteMemory(db, HUMAN, { id: b.id, evidence: EVIDENCE, now: T0 })
  const hits = searchMemory(db, 'p2', 'postgres', 10)
  expect(hits.length).toBe(1)
  expect(hits[0]?.id).toBe(b.id)
  expect(listMemory(db, 'p1').length).toBe(1)
})

test('quarantine and the audit trail are recorded', () => {
  const db = fixture()
  const c = claim(db, 'k', 'body')
  promoteMemory(db, ORCH, { id: c.id, evidence: EVIDENCE, now: T0 })
  const q = quarantineMemory(db, ORCH, {
    id: c.id, reason: 'source diverged', now: T0 + 1,
  })
  expect(q.status).toBe('quarantine')
  expect(searchMemory(db, 'p1', 'body', 10).length).toBe(0)
  const kinds = memoryEvents(db, c.id).map((event) => event.kind).join(',')
  expect(kinds).toBe('memory.claim,memory.promote,memory.quarantine')
})
