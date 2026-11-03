// Test-only helpers shared by the guard bun tests (real ledger schema on bun:sqlite).
import type { Database } from 'bun:sqlite'
import { openLedgerDb } from '../../ledger/migration'

export const T0 = Date.UTC(2026, 10, 3, 12, 0, 0)
export const HUMAN = { kind: 'human', id: 'alice' } as const
export const ROOT = { kind: 'root', id: 'root' } as const

type Row = Record<string, unknown>
export function rows(db: Database, sql: string, ...params: unknown[]): Row[] {
  return (db.query(sql) as unknown as { all(...p: unknown[]): Row[] }).all(...params)
}
export function run(db: Database, sql: string, ...params: unknown[]): void {
  ;(db.query(sql) as unknown as { run(...p: unknown[]): unknown }).run(...params)
}
export function freshDb(path = ':memory:'): Database {
  const db = openLedgerDb(path)
  if (path === ':memory:') {
    run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','One','/tmp/p1',1,1)")
    run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p2','w2','Two','/tmp/p2',1,1)")
  }
  return db
}
export function addAgent(db: Database, id: string, projectId: string, state: string): void {
  run(db, "INSERT INTO central_agents (id, project_id, kind, runner, state, owner, started_at) VALUES (?, ?, 'opencode', 'exec', ?, 'human', 1)", id, projectId, state)
}
export function eventKinds(db: Database, kind: string): Row[] {
  return rows(db, 'SELECT payload_json FROM event WHERE kind = ? ORDER BY seq', kind).map((r) => JSON.parse(String(r.payload_json)) as Row)
}
