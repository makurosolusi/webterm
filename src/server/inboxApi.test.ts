import { describe, expect, it } from 'vitest'
import { inboxRoute } from './inboxApi'
import type { RouteResult } from './apiShared.types'
import { nodeSqlite } from './nodeSqlite.testutil'
import type { LedgerRuntime } from './ledger/ledgerRuntime'

const NOW = Date.now()

const DDL = `
CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE approval (
  id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL, request_json TEXT,
  status TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE task (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, spec TEXT NOT NULL, evidence_json TEXT,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, lease_expires INTEGER, fence INTEGER NOT NULL DEFAULT 0
);`

interface Item {
  id: string
  category: string
  kind: string
  projectId: string | null
  projectName: string | null
  title: string
}
interface InboxBody {
  items: Item[]
  total: number
  limit: number
  offset: number
  counts: { needsYou: number; review: number; broken: number; total: number }
}

function fixture(): LedgerRuntime {
  const { db, raw } = nodeSqlite()
  raw.exec(DDL)
  raw.exec(`
    INSERT INTO project (id, name) VALUES ('p1', 'Alpha'), ('p2', 'Beta');
    INSERT INTO approval (id, project_id, kind, request_json, status, expires_at, created_at)
      VALUES ('a1', 'p1', 'git.push', '{"branch":"main"}', 'pending', NULL, ${NOW - 3000}),
             ('a2', 'p1', 'git.push', '{"branch":"old"}', 'pending', 1, ${NOW - 2000});
    INSERT INTO task (id, project_id, spec, evidence_json, status, created_at, lease_expires)
      VALUES ('t1', 'p1', 'blocked task', NULL, 'blocked', ${NOW - 1000}, NULL),
             ('t2', 'p2', 'review task', '{"command":"bun test"}', 'claimed_done', ${NOW - 500}, NULL),
             ('t3', 'p1', 'failed task', NULL, 'failed', ${NOW - 400}, NULL);
  `)
  return { db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
}

const call = (query = '', method = 'GET', path = '/api/inbox', runtime: LedgerRuntime | null = fixture()) =>
  inboxRoute(path, method, new URLSearchParams(query), runtime)
const ok = (...args: Parameters<typeof call>): NonNullable<RouteResult> =>
  call(...args) as NonNullable<RouteResult>

describe('inbox route', () => {
  it('projects the cross-project inbox with badge counts', () => {
    const result = ok()
    expect(result.status).toBe(200)
    const body = result.body as InboxBody
    expect(body.items.map((item) => item.id)).toEqual(['a1', 't1', 't2', 't3'])
    expect(body.total).toBe(4)
    expect(body.limit).toBe(50)
    expect(body.offset).toBe(0)
    expect(body.counts).toEqual({ needsYou: 2, review: 1, broken: 1, total: 4 })
    // Expired approval is not "needs you": it is not in the projection at all.
    expect(body.items.some((item) => item.id === 'a2')).toBe(false)
    expect(body.items[0].projectName).toBe('Alpha')
  })

  it('scopes by project and paginates without changing total', () => {
    const scoped = ok('projectId=p1').body as InboxBody
    expect(scoped.items.map((item) => item.id)).toEqual(['a1', 't1', 't3'])
    expect(scoped.total).toBe(3)

    const page = ok('limit=1&offset=1').body as InboxBody
    expect(page.items.map((item) => item.id)).toEqual(['t1'])
    expect(page.limit).toBe(1)
    expect(page.offset).toBe(1)
    expect(page.total).toBe(4)
  })

  it('keeps badge counts independent of the page limit', () => {
    const page = ok('limit=1&offset=0').body as InboxBody
    expect(page.items).toHaveLength(1)
    expect(page.total).toBe(4)
    expect(page.counts).toEqual({ needsYou: 2, review: 1, broken: 1, total: 4 })
  })

  it('rejects malformed paging and project ids', () => {
    expect(ok('limit=0').status).toBe(400)
    expect(ok('limit=abc').status).toBe(400)
    expect(ok('limit=500').status).toBe(400)
    expect(ok('offset=-1').status).toBe(400)
    expect(ok('projectId=%20').status).toBe(400)
  })

  it('answers 503 when the ledger is off, and null for other paths/methods', () => {
    expect(call('', 'GET', '/api/inbox', null)).toEqual({ status: 503, body: { error: 'ledger_off' } })
    expect(call('', 'POST')).toBe(null)
    expect(call('', 'GET', '/api/inboxx')).toBe(null)
  })
})
