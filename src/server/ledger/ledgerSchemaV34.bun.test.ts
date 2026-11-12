// v34: central_playbook_run is additive and re-applying keeps its rows; retention drops runs 30+ days old
// except one still parked on a pending approval card.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './ledgerSchema'
import { RETENTION } from './ledgerRetention.policy'
import { LATEST_VERSION, migrate } from './migration'
import { applyV34 } from './ledgerSchemaV34'
import { requestApproval } from './ledgerApproval'

const DAY = 86_400_000
const ids = (db: Database): string[] => (db.query('SELECT id FROM central_playbook_run ORDER BY id').all() as { id: string }[]).map((r) => r.id)
const insert = (db: Database, id: string, status: string, at: number, approvalId: string | null = null): void => {
  db.query(`INSERT INTO central_playbook_run (id, playbook, project_id, conversation_id, call_key, params_json, status, approval_id, created_at, updated_at)
    VALUES (?, 'web_research', 'p1', 'c', ?, '{}', ?, ?, ?, ?)`).run(id, id, status, approvalId, at, at)
}

function atV33(): Database {
  const db = new Database(':memory:')
  migrate(db, MIGRATIONS.filter((m) => m.version <= 33))
  return db
}

test('migrates from v33, re-applying is a no-op that keeps rows, and the status is checked', () => {
  const db = atV33()
  expect(migrate(db)).toBe(LATEST_VERSION)
  insert(db, 'r1', 'waiting', 1)
  applyV34(db)
  expect(ids(db)).toEqual(['r1'])
  let threw = false
  try { insert(db, 'bad', 'paused', 1) } catch { threw = true }
  expect(threw).toBe(true)
})

test('retention: runs idle 30+ days go, recent ones and ones parked on a pending card stay', () => {
  const db = atV33()
  migrate(db)
  const now = 100 * DAY
  db.exec("INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','One','/tmp/p1',1,1)")
  requestApproval({ db, now: () => now }, { id: 'card', projectId: 'p1', kind: 'agent.spawn', request: {} })
  insert(db, 'done-old', 'done', 0)
  insert(db, 'failed-old', 'failed', 0)
  insert(db, 'stale-running', 'running', 0)
  insert(db, 'waiting-old-dead-card', 'waiting', 0, 'gone')
  insert(db, 'waiting-old-live-card', 'waiting', 0, 'card')
  insert(db, 'done-new', 'done', now - DAY)
  const entry = RETENTION.central_playbook_run
  if (entry?.kind !== 'sweep') throw new Error('central_playbook_run has no sweep')
  expect(entry.sweep({ db, now: () => now }, now, 10)).toBe(4)
  expect(ids(db)).toEqual(['done-new', 'waiting-old-live-card'])
})
