import { describe, expect, it } from 'vitest'
import { memoryRoute, type RouteResult } from './memoryApi'
import { nodeSqlite } from './nodeSqlite.testutil'
import type { LedgerRuntime } from './ledger/ledgerRuntime'

const NOW = Date.now()

const DDL = `
CREATE TABLE memory (
  id TEXT PRIMARY KEY, project_id TEXT, scope TEXT NOT NULL, key TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
  source_kind TEXT, source_ref TEXT, supersedes TEXT, superseded_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE memory_fts USING fts5(title, body);`

interface MemoryBody {
  projectId: string
  q?: string
  limit: number
  items: { id: string; status: string; title: string }[]
}

function fixture(): LedgerRuntime {
  const { db, raw } = nodeSqlite()
  raw.exec(DDL)
  raw.exec(`
    INSERT INTO memory (id, project_id, scope, key, title, body, status, source_kind,
      source_ref, supersedes, superseded_at, created_at, updated_at)
      VALUES ('m1', 'p1', 'project', 'deploy', 'Deploy', 'deploy uses bun', 'fact',
              'file', 'README.md', NULL, NULL, ${NOW - 3000}, ${NOW - 3000}),
             ('m2', 'p1', 'project', 'deploy-old', 'Deploy old', 'deploy used node',
              'superseded', 'file', 'README.md', NULL, ${NOW - 1000}, ${NOW - 2000}, ${NOW - 1000}),
             ('m3', 'p1', 'scratch', 'deploy-claim', 'Deploy claim', 'deploy may use deno',
              'claim', 'worker', 'w1', NULL, NULL, ${NOW - 500}, ${NOW - 500});
    INSERT INTO memory_fts (rowid, title, body)
      VALUES (1, 'Deploy', 'deploy uses bun'),
             (2, 'Deploy old', 'deploy used node'),
             (3, 'Deploy claim', 'deploy may use deno');
  `)
  return { db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
}

const search = (query: string, runtime: LedgerRuntime | null = fixture()) =>
  memoryRoute('/api/memory/search', 'GET', new URLSearchParams(query), runtime)
const list = (query: string, runtime: LedgerRuntime | null = fixture()) =>
  memoryRoute('/api/memory', 'GET', new URLSearchParams(query), runtime)
const ok = (result: RouteResult | null): NonNullable<RouteResult> =>
  result as NonNullable<RouteResult>

describe('memory read routes', () => {
  it('searches only live facts inside the project', () => {
    const result = search('projectId=p1&q=deploy')
    expect(result?.status).toBe(200)
    const body = ok(result).body as MemoryBody
    expect(body.q).toBe('deploy')
    expect(body.limit).toBe(20)
    expect(body.items.map((item) => item.id)).toEqual(['m1'])
    expect(body.items[0].status).toBe('fact')
  })

  it('lists history including superseded rows, newest first', () => {
    const body = ok(list('projectId=p1')).body as MemoryBody
    expect(body.items.map((item) => item.id)).toEqual(['m3', 'm2', 'm1'])
    expect(body.limit).toBe(200)
  })

  it('validates query, project, and limit bounds', () => {
    expect(ok(search('projectId=p1')).status).toBe(400)
    expect(ok(search(`projectId=p1&q=${'x'.repeat(513)}`)).status).toBe(400)
    expect(ok(search('projectId=p1&q=deploy&limit=0')).status).toBe(400)
    expect(ok(list('projectId=p1&limit=5000')).status).toBe(400)
    expect(ok(list('q=deploy')).status).toBe(400)
  })

  it('answers 503 when the ledger is off and null for foreign paths', () => {
    expect(search('projectId=p1&q=deploy', null)).toEqual({
      status: 503,
      body: { error: 'ledger_off' },
    })
    expect(memoryRoute('/api/memories', 'GET', new URLSearchParams(), fixture())).toBe(null)
    expect(memoryRoute('/api/memory', 'POST', new URLSearchParams(), fixture())).toBe(null)
  })
})
