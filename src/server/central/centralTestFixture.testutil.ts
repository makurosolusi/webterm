// Test-only fixture: a real ledger schema (all migrations) on node:sqlite, seeded with
// three projects that exercise every aggregate in the central portfolio. Values are
// test-only literals; nothing here ships.
import type { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from '../ledger/ledgerSchema'
import { nodeSqlite } from '../nodeSqlite.testutil'

export const NOW = 1_700_000_000_000

export interface Fixture {
  db: Database
  raw: DatabaseSync
  close(): void
}

export function openFixture(): Fixture {
  const { db, raw } = nodeSqlite()
  for (const migration of MIGRATIONS) migration.up(db)
  return { db, raw, close: () => raw.close() }
}

function project(
  db: Database,
  id: string,
  name: string,
  status: string,
  priority: number,
  createdAt: number
): void {
  db.query(
    `INSERT INTO project (id, workspace_id, name, path, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, `w-${id}`, name, `/tmp/${id}`, status, priority, createdAt, createdAt)
}

function task(
  db: Database,
  id: string,
  projectId: string,
  status: string,
  updatedAt: number
): void {
  db.query(
    `INSERT INTO task (id, project_id, spec, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, `spec ${id}`, status, updatedAt, updatedAt)
}

function run(db: Database, id: string, projectId: string): void {
  db.query(
    'INSERT INTO run (id, project_id, started_at) VALUES (?, ?, ?)'
  ).run(id, projectId, NOW)
}

function usage(
  db: Database,
  id: string,
  runId: string,
  cost: number | null,
  priceKnown: boolean
): void {
  db.query(
    `INSERT INTO usage (id, run_id, input_tokens, output_tokens, cost_micros, price_known, ts)
     VALUES (?, ?, 10, 5, ?, ?, ?)`
  ).run(id, runId, cost, priceKnown ? 1 : 0, NOW)
}

/**
 * p2 (priority 10) sorts first, then p1 and p3 (both 5, p1 older). p1 carries a plan,
 * mixed tasks, one live and one expired approval, a budget, and priced usage; p2 carries
 * an unpriced usage row; p3 is deliberately empty.
 */
export function seedPortfolio(db: Database): void {
  project(db, 'p1', 'Alpha', 'active', 5, 1_000)
  project(db, 'p2', 'Beta', 'paused', 10, 2_000)
  project(db, 'p3', 'Gamma', 'active', 5, 3_000)

  task(db, 't-verified-old', 'p1', 'verified', 500)
  task(db, 't-verified-new', 'p1', 'verified', 900)
  task(db, 't-failed', 'p1', 'failed', 700)
  task(db, 't-pending', 'p1', 'pending', 300)
  task(db, 't-done', 'p1', 'claimed_done', 400)
  task(db, 't-p2-failed', 'p2', 'failed', 950)
  task(db, 't-p2-verified', 'p2', 'verified', 400)

  db.query(
    `INSERT INTO plan (id, project_id, version, status, created_at, updated_at)
     VALUES ('pl1', 'p1', 3, 'active', 1, 1), ('pl2', 'p2', 1, 'draft', 2, 2)`
  ).run()
  const item = (id: string, planId: string, seq: number, status: string) =>
    db.query(
      `INSERT INTO plan_item (id, plan_id, seq, title, scope_json, status, updated_at)
       VALUES (?, ?, ?, ?, '[]', ?, 1)`
    ).run(id, planId, seq, `item ${seq}`, status)
  item('i1', 'pl1', 1, 'pending')
  item('i2', 'pl1', 2, 'done')
  item('i3', 'pl1', 3, 'running')
  item('i4', 'pl1', 4, 'done')
  item('i5', 'pl2', 1, 'failed')

  const approval = (id: string, projectId: string, status: string, expires: number | null) =>
    db.query(
      `INSERT INTO approval (id, project_id, kind, status, expires_at, created_at, updated_at)
       VALUES (?, ?, 'git.push', ?, ?, 1, 1)`
    ).run(id, projectId, status, expires)
  approval('a-live', 'p1', 'pending', null)
  approval('a-expired', 'p1', 'pending', 1)
  approval('a-approved', 'p1', 'approved', null)
  approval('a-p2', 'p2', 'pending', null)

  db.query(
    `INSERT INTO budget (id, project_id, scope, period, limit_micros, spent_micros, hard_cap, updated_at)
     VALUES ('b1', 'p1', 'project', 'total', 1000000, 250000, 1, 1),
            ('b2', 'p2', 'project', 'total', 500000, 100000, 0, 1)`
  ).run()

  run(db, 'r1', 'p1')
  run(db, 'r2', 'p1')
  run(db, 'r3', 'p2')
  usage(db, 'u1', 'r1', 100, true)
  usage(db, 'u2', 'r3', null, false)
}
