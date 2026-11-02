// Vitest over Node's in-memory SQLite: the approved-but-unconsumed projection must survive a
// request_json that the ledger would reject at write time (corrupt/absent/scalar) instead of
// throwing away the whole recovery list. No ledger modules are imported: the two read tables are
// declared here so the CHECK constraint cannot hide the malformed-input path.
import { describe, expect, it } from 'vitest'
import type { Database } from 'bun:sqlite'
import { listApprovedUnconsumed } from './approvalQuery'
import { nodeSqlite } from './nodeSqlite.testutil'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

function readDb(): Database {
  const { db } = nodeSqlite()
  db.exec(`
    CREATE TABLE decision (
      id TEXT PRIMARY KEY,
      action_digest TEXT,
      nonce TEXT,
      single_use INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE approval (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      task_id TEXT,
      decision_id TEXT,
      kind TEXT NOT NULL,
      request_json TEXT,
      status TEXT NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return db
}

let seq = 0

/** One approved, unconsumed, unexpired row. `requestJson` is written verbatim. */
function addRow(db: Database, requestJson: string | null, taskId: string | null = null): string {
  seq += 1
  const id = `ap-${seq}`
  const decisionId = `d-${seq}`
  const createdAt = NOW - HOUR + seq
  db.query(
    `INSERT INTO decision (id, action_digest, nonce, single_use) VALUES (?, ?, ?, 1)`
  ).run(decisionId, `digest-${seq}`, `nonce-${seq}`)
  db.query(
    `INSERT INTO approval (id, project_id, task_id, decision_id, kind, request_json, status,
       expires_at, created_at, updated_at)
     VALUES (?, 'p1', ?, ?, 'task', ?, 'approved', ?, ?, ?)`
  ).run(id, taskId, decisionId, requestJson, NOW + HOUR, createdAt, createdAt + 10)
  return id
}

function list(db: Database, opts: { projectId?: string; limit?: number; offset?: number } = {}) {
  return listApprovedUnconsumed(db, { ...opts, now: NOW })
}

describe('listApprovedUnconsumed projection', () => {
  it('returns the approval fields plus the parsed request', () => {
    const db = readDb()
    const id = addRow(db, JSON.stringify({ taskId: 't-1', fence: 7, title: 'Review' }))
    const digest = `digest-${seq}`

    const [item] = list(db).items
    expect(item).toMatchObject({
      id,
      projectId: 'p1',
      taskId: 't-1',
      kind: 'task',
      digest,
      expiresAt: NOW + HOUR,
      request: { taskId: 't-1', fence: 7, title: 'Review' },
      fence: 7,
    })
    expect(item?.approvedAt).toBe(Number(item?.createdAt) + 10)
  })

  it('degrades corrupt, absent and scalar request_json to no task and no fence', () => {
    const db = readDb()
    const malformed = addRow(db, '{"taskId": ')
    const absent = addRow(db, null)
    const scalar = addRow(db, '"just a string"')
    const array = addRow(db, '[1,2,3]')

    const items = list(db).items
    expect(items.map((row) => row.id)).toEqual([malformed, absent, scalar, array])
    for (const item of items) {
      expect(item.taskId).toBeNull()
      expect(item).not.toHaveProperty('fence')
    }
    expect(items[0]?.request).toBeNull()
    expect(items[1]?.request).toBeNull()
    expect(items[2]?.request).toBe('just a string')
    expect(items[3]?.request).toEqual([1, 2, 3])
  })

  it('rejects unbounded task ids and non-safe fences in the payload', () => {
    const db = readDb()
    const longId = addRow(db, JSON.stringify({ taskId: 'x'.repeat(201), fence: 3 }))
    const blankId = addRow(db, JSON.stringify({ taskId: '   ', fence: 3 }))
    const fraction = addRow(db, JSON.stringify({ taskId: 't-9', fence: 1.5 }))
    const negative = addRow(db, JSON.stringify({ taskId: 't-9', fence: -1 }))
    const stringFence = addRow(db, JSON.stringify({ taskId: 't-9', fence: '7' }))
    const numericStringFence = addRow(db, JSON.stringify({ taskId: 't-9', fence: 0 }))

    const items = list(db).items
    expect(items.map((row) => row.id)).toEqual([longId, blankId, fraction, negative, stringFence, numericStringFence])
    expect(items[0]?.taskId).toBeNull()
    expect(items[1]?.taskId).toBeNull()
    for (const item of items.slice(2, 5)) expect(item).not.toHaveProperty('fence')
    expect(items[5]?.fence).toBe(0)
  })

  it('prefers the approval task_id column over the payload', () => {
    const db = readDb()
    addRow(db, JSON.stringify({ taskId: 'payload-task', fence: 2 }), 'column-task')

    expect(list(db).items[0]).toMatchObject({ taskId: 'column-task', fence: 2 })
  })

  it('keeps pagination and totals unchanged while adding the request projection', () => {
    const db = readDb()
    addRow(db, null)
    addRow(db, null)
    addRow(db, null)

    const first = list(db, { limit: 2, offset: 0 })
    expect(first.total).toBe(3)
    expect(first.items).toHaveLength(2)
    expect(first.limit).toBe(2)

    const second = list(db, { limit: 2, offset: 2 })
    expect(second.total).toBe(3)
    expect(second.items).toHaveLength(1)
    expect(second.offset).toBe(2)
  })

  it('filters by project', () => {
    const db = readDb()
    addRow(db, null)

    expect(list(db, { projectId: 'p1' }).total).toBe(1)
    expect(list(db, { projectId: 'other' }).total).toBe(0)
  })
})
