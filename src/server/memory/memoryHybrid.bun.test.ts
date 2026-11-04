// Bun-only (bun:sqlite). Hybrid retrieval: RRF maths, visibility, B5 (NULL project dedupe) and canary secrets.
import { expect, test } from 'bun:test'
import { RRF_K, rankScore, rrfFuse } from './memoryRrf'
import { getVisibleMemory, searchMemoryHybrid, touchMemoryUse } from './memoryHybrid'
import { T0, fixture, same, seedRow, thrown } from './memoryV2.fixture'
import { findRowByKey } from './memoryInsert'

const GLOBAL = { projectId: null }
const P1 = { projectId: 'p1' }
const search = (db: ReturnType<typeof fixture>, viewer: { projectId: string | null }, query: string, extra = {}) =>
  searchMemoryHybrid(db, { viewer, query, now: T0, ...extra }).map((h) => h.record.key)

test('rrfFuse sums 1/(k+rank) across lists and favours ids present in both', () => {
  const fused = rrfFuse([['a', 'b'], ['b', 'c']])
  expect(Math.abs((fused.get('a') ?? 0) - (1 / (RRF_K + 1))) < 1e-9).toBe(true)
  expect(Math.abs((fused.get('b') ?? 0) - (1 / (RRF_K + 2) + 1 / (RRF_K + 1))) < 1e-9).toBe(true)
  expect((fused.get('b')!) > fused.get('a')!).toBe(true)
})

test('rankScore penalises stale entries and ranks decisions above episodes', () => {
  const base = { rrf: 1 / 61, lists: 1, updatedAt: T0, now: T0, scope: 'user' as const, stale: false }
  expect((rankScore({ ...base, kind: 'decision' })) > rankScore({ ...base, kind: 'episode' })).toBe(true)
  expect(Math.abs((rankScore({ ...base, kind: 'decision', stale: true })) - (rankScore({ ...base, kind: 'decision' }) - 0.2)) < 1e-9).toBe(true)
})

test('global scope rows are found by exact word and by trigram substring', () => {
  const db = fixture()
  seedRow(db, { key: 'global.style.indent', body: 'Prefers the solarized dark theme everywhere', scope: 'global' })
  same(search(db, GLOBAL, 'solarized'), ['global.style.indent'])
  same(search(db, GLOBAL, 'olarize'), ['global.style.indent'])
  same(search(db, GLOBAL, 'nothingmatches'), [])
  same(search(db, GLOBAL, '   '), [])
})

test('B4: the global conversation sees global/user/central-global memory, not project facts', () => {
  const db = fixture()
  seedRow(db, { key: 'user.lang.reply', body: 'Reply in Indonesian', scope: 'user', trust: 'attested' })
  seedRow(db, { key: 'central.note.alpha', body: 'Reply format note', scope: 'central', status: 'claim', trust: 'agent' })
  seedRow(db, { key: 'proj.alpha.reply', body: 'Reply with project detail', scope: 'project', projectId: 'p1' })
  const keys = search(db, GLOBAL, 'reply')
  expect(keys).toContain('user.lang.reply')
  expect(keys).toContain('central.note.alpha')
  expect(keys).not.toContain('proj.alpha.reply')
})

test('project viewers see their project and global rows but never another project', () => {
  const db = fixture()
  seedRow(db, { key: 'proj.alpha.db', body: 'database is sqlite', scope: 'project', projectId: 'p1' })
  seedRow(db, { key: 'proj.beta.db', body: 'database is postgres', scope: 'project', projectId: 'p2' })
  seedRow(db, { key: 'central.beta.db', body: 'database is mysql', scope: 'central', status: 'claim', trust: 'agent', projectId: 'p2' })
  seedRow(db, { key: 'global.any.db', body: 'database naming rule', scope: 'global' })
  const keys = search(db, P1, 'database')
  same(keys.sort(), ['global.any.db', 'proj.alpha.db'])
})

test('hostile rows are never served: external trust, quarantine, superseded, expired claim, project-bound user row', () => {
  const db = fixture()
  // The write guard refuses an external fact; seed a human one and taint it in SQL (hostile legacy data).
  seedRow(db, { key: 'global.ext.one', body: 'zebra external' })
  db.query("UPDATE memory SET trust='external' WHERE key='global.ext.one'").run()
  seedRow(db, { key: 'global.q.one', body: 'zebra quarantined', status: 'fact' })
  db.query("UPDATE memory SET status='quarantine' WHERE key='global.q.one'").run()
  seedRow(db, { key: 'central.old.one', body: 'zebra expired', scope: 'central', status: 'claim', trust: 'agent', staleAfter: T0 - 1 })
  seedRow(db, { key: 'user.leak.one', body: 'zebra leaked', scope: 'user', projectId: 'p2' })
  seedRow(db, { key: 'global.ok.one', body: 'zebra fine' })
  same(search(db, P1, 'zebra'), ['global.ok.one'])
})

test('expired facts stay visible but flagged stale; claims are flagged unverified', () => {
  const db = fixture()
  seedRow(db, { key: 'global.old.fact', body: 'quokka fact', staleAfter: T0 - 1 })
  seedRow(db, { key: 'central.new.claim', body: 'quokka claim', scope: 'central', status: 'claim', trust: 'agent' })
  const hits = searchMemoryHybrid(db, { viewer: GLOBAL, query: 'quokka', now: T0 })
  expect(hits.find((h) => h.record.key === 'global.old.fact')?.stale).toBe(true)
  expect(hits.find((h) => h.record.key === 'central.new.claim')?.unverified).toBe(true)
})

test('B5: a second row with the same key and NULL project is rejected, and the lookup finds the first', () => {
  const db = fixture()
  seedRow(db, { key: 'global.dup.key', body: 'first', scope: 'global' })
  expect(thrown(() => seedRow(db, { key: 'global.dup.key', body: 'second', scope: 'global' }))).toContain('MemoryConflictError')
  expect(findRowByKey(db, null, 'global', 'global.dup.key')?.body).toBe('first')
  expect(findRowByKey(db, 'p1', 'global', 'global.dup.key')).toBe(null)
})

test('getVisibleMemory hides what search hides; touchMemoryUse counts usage', () => {
  const db = fixture()
  const mine = seedRow(db, { key: 'proj.alpha.x', body: 'alpha only', scope: 'project', projectId: 'p1' })
  expect(getVisibleMemory(db, P1, mine, T0)?.key).toBe('proj.alpha.x')
  expect(getVisibleMemory(db, { projectId: 'p2' }, mine, T0)).toBe(null)
  expect(getVisibleMemory(db, GLOBAL, mine, T0)).toBe(null)
  touchMemoryUse(db, [mine, mine], T0 + 5)
  expect(getVisibleMemory(db, P1, mine, T0)?.useCount).toBe(1)
})

test('limit is clamped and FTS syntax in the query cannot break or widen the search', () => {
  const db = fixture()
  for (let i = 0; i < 12; i++) seedRow(db, { key: `global.bulk.n${i}`, body: `bulk item ${i}` })
  expect((search(db, GLOBAL, 'bulk', { limit: 3 })).length).toBe(3)
  // Operators are tokenised away: only the word 'bulk' remains, so the query still matches normally.
  expect((search(db, GLOBAL, '"bulk" OR * NEAR( ) -x', { limit: 5 }).length) > 0).toBe(true)
  expect((search(db, GLOBAL, 'bulk"; DROP TABLE memory; --', { limit: 5 }).length) > 0).toBe(true)
  expect((search(db, GLOBAL, 'zzz* OR bulk', { limit: 30 })).length).toBe(12)
  same(db.query('SELECT count(*) AS c FROM memory').get(), { c: 12 })
})
