// Bun-only: world view counts across webterm.db + ledger.db through a read-only ATTACH (K5).
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { openDb } from './db'
import { openLedgerDb } from './ledger/migration'
import { worldCounts } from './worldView'

const dir = mkdtempSync(join(tmpdir(), 'worldview-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const paths = { webterm: join(dir, 'webterm.db'), ledger: join(dir, 'ledger.db') }

const close = (db: Database): void => (db as unknown as { close(): void }).close()

function seed(): void {
  const w = openDb(paths.webterm)
  const ins = w.query('INSERT INTO workspace (id, name, nodes, updated_at) VALUES (?, ?, ?, 1)')
  ins.run('ws-a', 'A', JSON.stringify([{ id: 'n1', kind: 'terminal', agentId: 'claude' }, { id: 'n2', kind: 'terminal' }]))
  ins.run('ws-b', 'B', JSON.stringify([{ id: 'n3', kind: 'browser' }]))
  ins.run('ws-c', 'C', 'not json') // corrupt blob: counted as a workspace with no nodes
  close(w)
  const l = openLedgerDb(paths.ledger)
  const proj = l.query('INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
  proj.run('p-a', 'ws-a', 'A', '/a')
  proj.run('p-gone', 'ws-deleted', 'Gone', '/g')
  l.query("INSERT INTO agent (id, project_id, created_at) VALUES ('ag1', 'p-a', 1), ('ag2', 'p-gone', 1)").run()
  const task = l.query('INSERT INTO task (id, project_id, spec, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
  task.run('t1', 'p-a', 's', 'pending')
  task.run('t2', 'p-a', 's', 'verified')
  task.run('t3', 'p-a', 's', 'blocked')
  task.run('t4', 'p-gone', 's', 'pending')
  close(l)
}

test('without a ledger file only canvas counts are reported', () => {
  const w = openDb(paths.webterm)
  close(w)
  expect(worldCounts(paths)).toEqual({ workspaces: 0, nodes: 0, agentNodes: 0, ledger: null })
})

test('counts both DBs, excluding ledger rows of deleted workspaces', () => {
  seed()
  expect(worldCounts(paths)).toEqual({
    workspaces: 3, nodes: 3, agentNodes: 1,
    ledger: { projects: 1, orphanProjects: 1, agents: 1, tasks: { total: 3, open: 2, byStatus: { pending: 1, verified: 1, blocked: 1 } } },
  })
})

test('a missing webterm.db is an error with the path, not silent zeros', () => {
  let message = ''
  try { worldCounts({ webterm: join(dir, 'absent.db'), ledger: paths.ledger }) } catch (err) { message = (err as Error).message }
  expect(message).toContain('absent.db')
})
