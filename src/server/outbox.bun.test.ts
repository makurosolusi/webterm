// Bun-only (bun:sqlite). Outbox on a REAL ledger file: schema v12+ migrates idempotently, queued
// mail survives closing and reopening the DB (a restart), and enqueue/deliver land as chained
// Senses events. Lives at src/server/ (not outbox/) so the `src/server/*.bun.test.ts` gate runs it.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { LATEST_VERSION, openLedgerDb } from './ledger/migration'
import { applyV12 } from './ledger/ledgerSchemaV12'
import { createEventLog } from './events/eventLog'
import { createEventBus } from './events/eventBus'
import { OutboxDelivery } from './outbox/outboxDelivery'
import { createOutboxStore } from './outbox/outboxStore'

const root = mkdtempSync(join(tmpdir(), 'outbox-')) // test-only temp dir, never the user's data dir
afterAll(() => rmSync(root, { recursive: true, force: true }))
const close = (db: Database): void => (db as unknown as { close(): void }).close()

function outboxOn(db: Database, st: { status?: 'working' | 'waiting' }, writes: string[]) {
  const log = createEventLog(db, { bus: createEventBus() })
  const outbox = new OutboxDelivery({
    store: createOutboxStore(db),
    agentOf: () => 'codex', // non-Claude: no composer to read, Enter after the fixed gap
    sessions: { statusOf: () => st.status, screenSource: () => ({ data: '', seq: 1, cols: 80, rows: 24, pid: 1 }), input: (_i, d) => { writes.push(d) } },
    record: (e) => { log.append(e) },
    sleep: async () => {},
  })
  return { outbox, log }
}

test('v12 creates agent_outbox; re-applying is a no-op', () => {
  const db = openLedgerDb(':memory:')
  expect(Number((db.query('PRAGMA user_version').get() as Record<string, unknown>)['user_version'])).toBe(LATEST_VERSION)
  applyV12(db)
  applyV12(db)
  const cols = (db.query('PRAGMA table_info(agent_outbox)').all() as Array<Record<string, unknown>>).map((r) => String(r['name']))
  for (const c of ['operation_id', 'to_node', 'kind', 'body', 'priority', 'status', 'transport']) expect(cols).toContain(c)
  let err = ''
  try { db.query("INSERT INTO agent_outbox (id, operation_id, to_node, kind, body, created_by, created_at) VALUES ('x','o','n','loud','b','t',1)").run() } catch (e) { err = String(e) }
  expect(err).toContain('CHECK')
  close(db)
})

test('queued mail survives a restart and is delivered once; events are chained', async () => {
  const path = join(root, 'ledger.db')
  const writes: string[] = []
  const st: { status?: 'working' | 'waiting' } = { status: 'working' }
  const db1 = openLedgerDb(path)
  const first = outboxOn(db1, st, writes)
  first.outbox.enqueue({ to: 'n1', body: 'hello', kind: 'visible', operationId: 'op-restart', createdBy: 'test' })
  await first.outbox.kick('n1')
  expect(writes).toEqual([])
  close(db1)

  const db2 = openLedgerDb(path) // the "restart"
  const second = outboxOn(db2, st, writes)
  expect(second.outbox.enqueue({ to: 'n1', body: 'hello', kind: 'visible', operationId: 'op-restart', createdBy: 'test' }).deduped).toBe(true)
  st.status = 'waiting'
  await second.outbox.kickAll()
  await second.outbox.kickAll()
  expect(writes).toEqual(['hello', '\r'])
  expect(second.outbox.list('n1')).toMatchObject([{ status: 'delivered', transport: 'pty' }])
  const kinds = second.log.list().map((e) => e.kind).filter((k) => k.startsWith('outbox.'))
  expect(kinds).toEqual(['outbox.enqueue', 'outbox.deliver'])
  expect(second.log.verifyChain()).toMatchObject({ ok: true })
  close(db2)
})
