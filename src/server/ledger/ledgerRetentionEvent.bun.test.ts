// data-209-1: the Senses event chain is pruned by retention (age + row cap) and stays verifiable.
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventLog } from '../events/eventLog'
import { anchorStatus } from '../events/eventAnchor'
import { GENESIS_HASH, chainHash, type HashedColumns } from '../events/eventModel'
import { MIGRATIONS } from './ledgerSchema'
import { applyV23 } from './ledgerSchemaV23'
import { migrate, openLedgerDb } from './migration'
import { EVENT_MAX_AGE_MS, pruneEventChain } from './ledgerRetentionEvent'
import { sweepRetention } from './ledgerRetention'

const NOW = 1_800_000_000_000 // test-only fixed clock
const root = mkdtempSync(join(tmpdir(), 'webterm-retention-event-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const errorOf = (fn: () => void): string => { try { fn(); return '' } catch (e) { return String(e) } }
const chainedCount = (db: Database): number => Number((db.query('SELECT COUNT(*) AS n FROM event WHERE hash IS NOT NULL').get() as { n: number }).n)

function freshLog(): { db: Database; log: ReturnType<typeof createEventLog> } {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return { db, log: createEventLog(db, { now: () => NOW }) }
}

const appendN = (log: ReturnType<typeof createEventLog>, n: number, ts: number): void => {
  for (let i = 0; i < n; i++) log.append({ kind: 'test.tick', source: 'test', trust: 'trusted', ts, payload: { i } })
}

test('event chain past the row cap is pruned to the cap; verifyChain stays ok and appends keep chaining', () => {
  const { db, log } = freshLog()
  appendN(log, 250, NOW)
  const oldAnchor = { ...log.list(0, 1)[0]!, at: NOW }
  const limits = { maxAgeMs: EVENT_MAX_AGE_MS, maxRows: 100 }
  let total = 0
  for (let n = pruneEventChain({ db, now: () => NOW }, NOW, 40, limits); n > 0; n = pruneEventChain({ db, now: () => NOW }, NOW, 40, limits)) {
    expect(n <= 40).toBe(true)
    total += n
  }
  expect(total).toBe(150)
  expect(chainedCount(db)).toBe(100)
  expect(log.prunedThrough()).toBe(150)
  expect(log.verifyChain()).toMatchObject({ ok: true, checked: 100, head: log.head() })
  // An anchor on a pruned row is expected, not a divergence; a live anchor still matches.
  expect(anchorStatus(oldAnchor, (s) => log.hashAt(s), log.prunedThrough())).toBe('pruned')
  expect(anchorStatus({ ...log.head()!, at: NOW }, (s) => log.hashAt(s), log.prunedThrough())).toBe('match')
  appendN(log, 3, NOW)
  expect(log.verifyChain()).toMatchObject({ ok: true, checked: 103 })
})

test('the registry sweep drops chained events older than 30 days, keeps the head row and the legacy rows', () => {
  const { db, log } = freshLog()
  appendN(log, 12, NOW - EVENT_MAX_AGE_MS - 1)
  db.exec(`INSERT INTO event (ts, kind, actor) VALUES (${NOW - EVENT_MAX_AGE_MS - 1}, 'legacy.audit', 'ledger')`)
  appendN(log, 5, NOW)
  const report = sweepRetention({ db, now: () => NOW }, NOW)
  expect(report.changed['event']).toBe(12)
  expect(chainedCount(db)).toBe(5)
  expect(Number((db.query('SELECT COUNT(*) AS n FROM event WHERE hash IS NULL').get() as { n: number }).n)).toBe(1)
  expect(log.verifyChain()).toMatchObject({ ok: true, checked: 5 })

  const only = freshLog()
  appendN(only.log, 4, NOW - EVENT_MAX_AGE_MS - 1)
  sweepRetention({ db: only.db, now: () => NOW }, NOW)
  expect(chainedCount(only.db)).toBe(1) // the head row is never dropped
  expect(only.log.verifyChain()).toMatchObject({ ok: true, checked: 1 })
})

test('rows above the chain base stay append-only after a prune; editing a kept row is still detected', () => {
  const { db, log } = freshLog()
  appendN(log, 10, NOW - EVENT_MAX_AGE_MS - 1)
  appendN(log, 2, NOW)
  sweepRetention({ db, now: () => NOW }, NOW)
  const head = log.head()!
  expect(errorOf(() => db.exec(`DELETE FROM event WHERE seq = ${head.seq}`))).toContain('append-only')
  expect(errorOf(() => db.exec(`UPDATE event SET kind = 'x.y' WHERE seq = ${head.seq}`))).toContain('append-only')
  // Moving the base past a row by hand without fixing the chain breaks verification at that row.
  db.exec(`UPDATE event_chain_base SET hash = '${'f'.repeat(64)}'`)
  expect(log.verifyChain()).toMatchObject({ ok: false, brokenAt: { reason: 'prev_hash_mismatch' } })
})

/** Writes chained rows the way eventLog does, without needing v23 (pre-change schema). */
function insertChained(db: Database, n: number, ts: number): void {
  let prev = (db.query('SELECT hash FROM event WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1').get() as { hash: string } | null)?.hash ?? GENESIS_HASH
  for (let i = 0; i < n; i++) {
    const c: HashedColumns = { prev_hash: prev, ts, kind: 'test.tick', source: 'test', actor: 'test', subject: null, workspace_id: null, node_id: null, trust: 'trusted', dedupe_key: null, payload_json: `{"i":${i}}` }
    const hash = chainHash(c)
    db.query(`INSERT INTO event (ts, kind, source, actor, subject, workspace_id, node_id, trust, dedupe_key, payload_json, prev_hash, hash)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?)`).run(c.ts, c.kind, c.source, c.actor, c.trust, c.payload_json, c.prev_hash, hash)
    prev = hash
  }
}

test('a v22 ledger file with chained events upgrades to v23, verifies, prunes; re-applying v23 is a no-op', () => {
  const file = join(root, 'v22.db')
  const old = new Database(file)
  expect(migrate(old, MIGRATIONS.filter((m) => m.version <= 22))).toBe(22)
  insertChained(old, 8, NOW - EVENT_MAX_AGE_MS - 1)
  insertChained(old, 3, NOW)
  expect(errorOf(() => old.exec('DELETE FROM event WHERE seq = 1'))).toContain('append-only')

  const db = openLedgerDb(file)
  const log = createEventLog(db, { now: () => NOW })
  expect(Number((db.query('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(23)
  expect(log.prunedThrough()).toBe(0) // no base row = genesis, nothing to backfill
  expect(log.verifyChain()).toMatchObject({ ok: true, checked: 11 })
  applyV23(db)
  applyV23(db)
  expect(sweepRetention({ db, now: () => NOW }, NOW).changed['event']).toBe(8)
  expect(log.verifyChain()).toMatchObject({ ok: true, checked: 3 })
  const triggers = (db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'event' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
  expect(triggers).toEqual(['event_chain_no_delete', 'event_chain_no_fk', 'event_chain_no_update'])
})
