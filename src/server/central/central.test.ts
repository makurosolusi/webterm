import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CentralError,
  EVENT_PAUSED,
  EVENT_PRIORITY,
  EVENT_RESUMED,
  MAX_PRIORITY,
  MIN_PRIORITY,
  clampPriority,
  pauseProject,
  portfolio,
  prioritize,
  projectPortfolio,
  resumeProject,
} from './central'
import type { CentralActor } from './centralModel'
import { openFixture, seedPortfolio, type Fixture } from './centralTestFixture.testutil'
import type { Database } from 'bun:sqlite'

const human: CentralActor = { id: 'alice', kind: 'human' }
const root: CentralActor = { id: 'root', kind: 'root' }

let fixture: Fixture

beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
})
afterEach(() => fixture.close())

function events(): { actor: string; kind: string; payload: string }[] {
  return fixture.db
    .query('SELECT actor, kind, payload_json AS payload FROM event ORDER BY seq')
    .all() as unknown as { actor: string; kind: string; payload: string }[]
}

function status(projectId: string): string {
  const row = fixture.db
    .query('SELECT status FROM project WHERE id = ?')
    .get(projectId) as { status: string }
  return row.status
}

describe('portfolio projection', () => {
  it('orders by priority and aggregates every project without cross-contamination', () => {
    const page = portfolio(fixture.db)
    expect(page.total).toBe(3)
    expect(page.limit).toBe(50)
    expect(page.offset).toBe(0)
    expect(page.items.map((p) => p.id)).toEqual(['p2', 'p1', 'p3'])

    const p1 = page.items.find((p) => p.id === 'p1')!
    expect(p1).toMatchObject({
      name: 'Alpha',
      status: 'active',
      priority: 5,
      pendingApprovals: 1,
      taskTotal: 5,
      plan: {
        id: 'pl1',
        status: 'active',
        version: 3,
        items: { total: 4, pending: 1, assigned: 0, running: 1, done: 2, failed: 0, cancelled: 0 },
      },
      latest: { verified: { id: 't-verified-new', updatedAt: 900 }, failed: { id: 't-failed', updatedAt: 700 } },
      budget: { limitMicros: 1_000_000, spentMicros: 250_000, hardCap: true },
      usage: { costMicros: 100, inputTokens: 10, outputTokens: 5, unpricedRecords: 0 },
    })
    expect(p1.tasks).toMatchObject({ verified: 2, failed: 1, pending: 1, claimed_done: 1, blocked: 0 })

    const p2 = page.items.find((p) => p.id === 'p2')!
    expect(p2.tasks).toMatchObject({ failed: 1, verified: 1 })
    expect(p2.pendingApprovals).toBe(1)
    expect(p2.plan?.items).toMatchObject({ total: 1, failed: 1 })
    expect(p2.budget).toEqual({ limitMicros: 500_000, spentMicros: 100_000, hardCap: false })
    expect(p2.usage).toEqual({ costMicros: 0, inputTokens: 10, outputTokens: 5, unpricedRecords: 1 })
    expect(p2.latest).toEqual({ verified: { id: 't-p2-verified', updatedAt: 400 }, failed: { id: 't-p2-failed', updatedAt: 950 } })

    const p3 = page.items.find((p) => p.id === 'p3')!
    expect(p3.plan).toBeNull()
    expect(p3.taskTotal).toBe(0)
    expect(p3.pendingApprovals).toBe(0)
    expect(p3.latest).toEqual({ verified: null, failed: null })
    expect(p3.budget).toBeNull()
    expect(p3.usage).toEqual({ costMicros: 0, inputTokens: 0, outputTokens: 0, unpricedRecords: 0 })
  })

  it('paginates while keeping the total stable', () => {
    const page = portfolio(fixture.db, { limit: 2, offset: 2 })
    expect(page.items.map((p) => p.id)).toEqual(['p3'])
    expect(page.total).toBe(3)
    expect(page.limit).toBe(2)
    expect(page.offset).toBe(2)
  })

  it('scopes to a single project and returns null for an unknown one', () => {
    const page = portfolio(fixture.db, { projectId: 'p1' })
    expect(page.total).toBe(1)
    expect(page.items.map((p) => p.id)).toEqual(['p1'])
    expect(projectPortfolio(fixture.db, 'p1')?.name).toBe('Alpha')
    expect(projectPortfolio(fixture.db, 'nope')).toBeNull()
  })

  it('issues a fixed number of statements regardless of page width (no N+1)', () => {
    let statements = 0
    const counting = {
      query: (sql: string) => {
        statements += 1
        return fixture.db.query(sql)
      },
      exec: (sql: string) => fixture.db.exec(sql),
    } as unknown as Database
    portfolio(counting)
    const wide = statements
    statements = 0
    portfolio(counting, { projectId: 'p1' })
    expect(statements).toBe(wide)
    expect(wide).toBeLessThanOrEqual(8)
  })

  it('returns an empty page for an empty ledger', () => {
    const empty = openFixture()
    try {
      expect(portfolio(empty.db).items).toEqual([])
    } finally {
      empty.close()
    }
  })

  it('rejects malformed paging and project ids', () => {
    expect(() => portfolio(fixture.db, { limit: 0 })).toThrow(CentralError)
    expect(() => portfolio(fixture.db, { offset: -1 })).toThrow(CentralError)
    expect(() => portfolio(fixture.db, { projectId: '  ' })).toThrow(CentralError)
  })
})

describe('pause and resume', () => {
  it('pauses and resumes with a human actor, appending one event per change', () => {
    const paused = pauseProject(fixture.db, human, 'p1')
    expect(paused.changed).toBe(true)
    expect(paused.project.status).toBe('paused')
    expect(status('p1')).toBe('paused')

    const resumed = resumeProject(fixture.db, root, 'p1')
    expect(resumed.changed).toBe(true)
    expect(resumed.project.status).toBe('active')
    expect(status('p1')).toBe('active')

    const rows = events()
    expect(rows.map((e) => e.kind)).toEqual([EVENT_PAUSED, EVENT_RESUMED])
    expect(rows[0].actor).toBe('alice')
    expect(JSON.parse(rows[0].payload)).toEqual({ from: 'active', to: 'paused', actorKind: 'human' })
    expect(rows[1].actor).toBe('root')
  })

  it('is idempotent: a second pause changes nothing and appends no event', () => {
    pauseProject(fixture.db, human, 'p1')
    const again = pauseProject(fixture.db, human, 'p1')
    expect(again.changed).toBe(false)
    expect(events()).toHaveLength(1)
  })

  it('rejects every agent-like authority kind without touching state', () => {
    for (const kind of ['agent', 'worker', 'orchestrator', 'central', 'system'] as const) {
      expect(() => pauseProject(fixture.db, { id: 'x', kind }, 'p1')).toThrow(CentralError)
      expect(() => resumeProject(fixture.db, { id: 'x', kind }, 'p1')).toThrow(CentralError)
      expect(() => prioritize(fixture.db, { id: 'x', kind }, 'p1', 99)).toThrow(CentralError)
    }
    expect(status('p1')).toBe('active')
    expect(events()).toHaveLength(0)
  })

  it('rejects malformed actors and unknown projects', () => {
    expect(() => pauseProject(fixture.db, { id: '', kind: 'human' }, 'p1')).toThrow(/actor.id/)
    expect(() => pauseProject(fixture.db, human, 'missing')).toThrow(CentralError)
    expect(() => pauseProject(fixture.db, human, '')).toThrow(CentralError)
  })
})

describe('priority envelope', () => {
  it('sets an integer priority and appends an audit event', () => {
    const result = prioritize(fixture.db, human, 'p1', 42)
    expect(result.changed).toBe(true)
    expect(result.project.priority).toBe(42)
    const row = events()[0]
    expect(row.kind).toBe(EVENT_PRIORITY)
    expect(JSON.parse(row.payload)).toEqual({ from: 5, to: 42, actorKind: 'human' })
  })

  it('clamps out-of-range integers instead of rejecting', () => {
    expect(clampPriority(500)).toBe(MAX_PRIORITY)
    expect(clampPriority(-500)).toBe(MIN_PRIORITY)
    expect(prioritize(fixture.db, human, 'p1', 500).project.priority).toBe(MAX_PRIORITY)
    expect(prioritize(fixture.db, human, 'p2', -500).project.priority).toBe(MIN_PRIORITY)
  })

  it('rejects non-integers and leaves the row untouched', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => prioritize(fixture.db, human, 'p1', bad)).toThrow(CentralError)
    }
    expect(prioritize(fixture.db, human, 'p1', 5).changed).toBe(false)
    expect(events()).toHaveLength(0)
  })
})
