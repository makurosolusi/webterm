// Bun-only (needs bun:sqlite): the durable request-idempotency journal that lets approval acks
// survive a process restart. Uses a real ledger file so close/reopen exercises SQLite, not a mock.
// Only toBe/toContain matchers are available (see src/server/bun-test.d.ts).
import { afterAll, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACK_LIMIT, ACK_TTL_MS } from '../control/controlTypes'
import { DurableAckStore, durableAckFor, type AckDatabase } from './durableAck'
import { openLedgerDb } from './migration'

const T0 = 1_700_000_000_000

const root = mkdtempSync(join(tmpdir(), 'durable-ack-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const filePath = (name: string): string => join(root, `${name}.db`)

interface Stmt {
  get(...params: unknown[]): Record<string, unknown> | null
}

const q = (db: Database, sql: string): Stmt => db.query(sql) as unknown as Stmt
const ackDb = (db: Database): AckDatabase => db as unknown as AckDatabase
const close = (db: Database): void => (db as unknown as { close(): void }).close()

test('set/get roundtrip preserves the response body', () => {
  const db = openLedgerDb(filePath('roundtrip'))
  try {
    const store = new DurableAckStore(ackDb(db))
    const result = { status: 201, body: { id: 'ap-1', nested: { ok: true } } }
    store.set('approval.request|project:p1|req-00000001', result, T0)
    expect(JSON.stringify(store.get('approval.request|project:p1|req-00000001', T0 + 1))).toBe(
      JSON.stringify(result)
    )
    expect(store.get('missing', T0) === undefined).toBe(true)
  } finally {
    close(db)
  }
})

test('an expired row is ignored and deleted', () => {
  const db = openLedgerDb(filePath('expired'))
  try {
    const store = new DurableAckStore(ackDb(db))
    store.set('k', { status: 200, body: { ok: true } }, T0)
    expect(store.get('k', T0 + ACK_TTL_MS - 1) !== undefined).toBe(true)
    expect(store.get('k', T0 + ACK_TTL_MS) === undefined).toBe(true)
    const row = q(db, 'SELECT count(*) AS n FROM request_ack WHERE key = ?').get('k')
    expect(Number(row?.['n'])).toBe(0)
  } finally {
    close(db)
  }
})

test('re-setting the same key keeps the original result and expiry', () => {
  const db = openLedgerDb(filePath('reset'))
  try {
    const store = new DurableAckStore(ackDb(db))
    store.set('k', { status: 200, body: { v: 1 } }, T0)
    store.set('k', { status: 200, body: { v: 2 } }, T0 + ACK_TTL_MS / 2)
    const replay = store.get('k', T0 + ACK_TTL_MS - 1)
    expect(JSON.stringify(replay)).toBe(JSON.stringify({ status: 200, body: { v: 1 } }))
    // The window was not extended: the original expiry still applies.
    expect(store.get('k', T0 + ACK_TTL_MS) === undefined).toBe(true)
  } finally {
    close(db)
  }
})

test('rows beyond ACK_LIMIT evict the oldest inserts', () => {
  const db = openLedgerDb(filePath('limit'))
  try {
    const store = new DurableAckStore(ackDb(db))
    for (let i = 0; i <= ACK_LIMIT; i += 1) {
      store.set(`k-${i}`, { status: 200, body: { i } }, T0)
    }
    const row = q(db, 'SELECT count(*) AS n FROM request_ack').get()
    expect(Number(row?.['n'])).toBe(ACK_LIMIT)
    expect(store.get('k-0', T0 + 1) === undefined).toBe(true)
    expect(JSON.stringify(store.get('k-1', T0 + 1))).toBe(
      JSON.stringify({ status: 200, body: { i: 1 } })
    )
    expect(store.get(`k-${ACK_LIMIT}`, T0 + 1) !== undefined).toBe(true)
  } finally {
    close(db)
  }
})

test('acks persist across a close/reopen of the same file', () => {
  const path = filePath('persist')
  const first = openLedgerDb(path)
  const result = { status: 200, body: { id: 'ap-1', status: 'approved' } }
  new DurableAckStore(ackDb(first)).set('approval.decide|approval:ap-1|req-00000002', result, T0)
  close(first)

  const second = openLedgerDb(path)
  try {
    const store = durableAckFor(second)
    expect(store !== undefined).toBe(true)
    expect(
      JSON.stringify(store?.get('approval.decide|approval:ap-1|req-00000002', T0 + 1000))
    ).toBe(JSON.stringify(result))
  } finally {
    close(second)
  }
})

test('scoped stores keep human and control acks independent across reopen', () => {
  const path = filePath('scopes')
  const key = 'approval.request|project:p1|req-00000009'
  const humanResult = { status: 201, body: { surface: 'human' } }
  const controlResult = { status: 202, body: { surface: 'control' } }

  const first = openLedgerDb(path)
  const human = durableAckFor(first, 'human')
  const control = durableAckFor(first, 'control')
  expect(human !== undefined && control !== undefined).toBe(true)
  expect(human === durableAckFor(first, 'human')).toBe(true)
  expect(human === control).toBe(false)
  try {
    human?.set(key, humanResult, T0)
    control?.set(key, controlResult, T0)
    // Same original key, two independent responses.
    expect(JSON.stringify(human?.get(key, T0 + 1))).toBe(JSON.stringify(humanResult))
    expect(JSON.stringify(control?.get(key, T0 + 1))).toBe(JSON.stringify(controlResult))
    // A scoped store cannot read the other scope's row, even with a hand-built raw key.
    expect(human?.get(`control\u0000${key}`, T0 + 1) === undefined).toBe(true)
    // The persisted key itself carries the scope prefix.
    const persisted = q(first, 'SELECT key FROM request_ack WHERE key = ?').get(`human\u0000${key}`)
    expect(persisted !== null).toBe(true)
  } finally {
    close(first)
  }

  const second = openLedgerDb(path)
  try {
    expect(JSON.stringify(durableAckFor(second, 'human')?.get(key, T0 + 1000))).toBe(
      JSON.stringify(humanResult)
    )
    expect(JSON.stringify(durableAckFor(second, 'control')?.get(key, T0 + 1000))).toBe(
      JSON.stringify(controlResult)
    )
  } finally {
    close(second)
  }
})

test('durableAckFor returns undefined for a db-like object without query', () => {
  expect(durableAckFor({}) === undefined).toBe(true)
  expect(durableAckFor(null) === undefined).toBe(true)
  expect(durableAckFor(undefined) === undefined).toBe(true)
})
