// Bun-only control-plane test: REAL ledger DB (bun:sqlite) so transactions, unique indexes and
// the plan store behave exactly as in production. Vitest covers parsing/gating and the HTTP mount.
import { afterAll, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLedger } from './ledger/ledger'
import { openLedgerDb } from './ledger/migration'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { createPlanStore, type PlanStore } from './orchestrator/plan'
import { orchestratorAssignRoute, orchestratorBootstrapRoute, parseBootstrapBody } from './orchestratorControlApi'

const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'orch-control-'))
/** Bootstrap only accepts a git worktree root, so every test repo needs a `.git` marker. */
const repo = join(root, 'repo')
mkdirSync(join(repo, '.git'), { recursive: true })
const open: Database[] = []
afterAll(() => {
  for (const db of open) (db as unknown as { close(): void }).close()
  rmSync(root, { recursive: true, force: true })
})

let seq = 0
function runtime(): LedgerRuntime {
  const path = join(root, `ledger-${seq++}.sqlite`)
  const db = openLedgerDb(path)
  open.push(db)
  return { mode: 'on', path, db, ledger: createLedger(db), close: () => {} }
}

function count(db: Database, table: string): number {
  const row = db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }
  return Number(row.c)
}

function body(result: { body: unknown }): Record<string, unknown> {
  return result.body as Record<string, unknown>
}

function items(result: { body: unknown }): { id: string; title: string; scope: string[] }[] {
  const plan = body(result)['plan'] as { items: { id: string; title: string; scope: string[] }[] }
  return plan.items
}

const bootstrapBody = (overrides: Record<string, unknown> = {}) => ({
  projectId: 'p1',
  name: 'Project One',
  path: repo,
  items: [{ title: 'build api', scope: ['src/server'] }, { title: 'write docs', scope: ['README.md'] }],
  ...overrides,
})

test('bootstrap creates project + orchestrator + worker + plan in one unit', async () => {
  const rt = runtime()
  const result = await orchestratorBootstrapRoute(bootstrapBody(), { ledger: rt, enabled: true })

  expect(result.status).toBe(200)
  expect(body(result)['ok']).toBe(true)
  expect(body(result)['orchestratorAgentId']).toBe('orch:p1')
  expect(body(result)['workerAgentId']).toBe('worker:p1')
  expect((body(result)['project'] as { workspaceId: string }).workspaceId).toBe('bootstrap:p1')
  expect((body(result)['plan'] as { version: number }).version).toBe(1)
  expect(items(result).length).toBe(2)
  expect(items(result)[1]?.scope.join(',')).toBe('README.md')

  expect(count(rt.db, 'project')).toBe(1)
  expect(count(rt.db, 'agent')).toBe(2)
  const worker = rt.db
    .query("SELECT parent_agent_id, role, depth FROM agent WHERE id = 'worker:p1'")
    .get() as Record<string, unknown>
  expect(worker['parent_agent_id']).toBe('orch:p1')
  expect(worker['role']).toBe('worker')
  expect(Number(worker['depth'])).toBe(2)
  expect(createPlanStore(rt.db).get('p1')?.items.length).toBe(2)
})

test('bootstrap is idempotent-safe: a duplicate project answers 409 and changes nothing', async () => {
  const rt = runtime()
  expect((await orchestratorBootstrapRoute(bootstrapBody(), { ledger: rt, enabled: true })).status).toBe(200)
  const again = await orchestratorBootstrapRoute(bootstrapBody(), { ledger: rt, enabled: true })
  expect(again.status).toBe(409)
  expect(body(again)['error']).toBe('project_exists')
  expect(count(rt.db, 'project')).toBe(1)
  expect(count(rt.db, 'agent')).toBe(2)
  expect(count(rt.db, 'plan')).toBe(1)
})

test('assign creates a ledger task and marks the plan item assigned', async () => {
  const rt = runtime()
  const boot = await orchestratorBootstrapRoute(bootstrapBody(), { ledger: rt, enabled: true })
  const itemId = items(boot)[0]!.id

  const assigned = await orchestratorAssignRoute(
    { projectId: 'p1', itemId, expectedVersion: 1 },
    { ledger: rt, enabled: true }
  )
  expect(assigned.status).toBe(200)
  expect(body(assigned)['ok']).toBe(true)
  expect(body(assigned)['planVersion']).toBe(2)
  const taskId = body(assigned)['taskId'] as string

  const task = rt.db
    .query('SELECT project_id, agent_id, spec FROM task WHERE id = ?')
    .get(taskId) as Record<string, unknown>
  expect(task['project_id']).toBe('p1')
  expect(task['agent_id']).toBe('worker:p1')
  expect(String(task['spec']).includes('build api')).toBe(true)
  expect(String(task['spec']).includes('src/server')).toBe(true)

  const row = rt.db
    .query("SELECT status, task_id, assignee FROM plan_item WHERE id = ?")
    .get(itemId) as Record<string, unknown>
  expect(row['status']).toBe('assigned')
  expect(row['task_id']).toBe(taskId)
  expect(row['assignee']).toBe('worker:p1')
})

test('assign rejects a missing plan, a missing item, and an already-assigned item', async () => {
  const rt = runtime()
  const missing = await orchestratorAssignRoute(
    { projectId: 'nope', itemId: 'x', expectedVersion: 1 },
    { ledger: rt, enabled: true }
  )
  expect(missing.status).toBe(409)
  expect(body(missing)['error']).toBe('plan_missing')

  const boot = await orchestratorBootstrapRoute(bootstrapBody(), { ledger: rt, enabled: true })
  const unknown = await orchestratorAssignRoute(
    { projectId: 'p1', itemId: 'nope', expectedVersion: 1 },
    { ledger: rt, enabled: true }
  )
  expect(unknown.status).toBe(409)
  expect(body(unknown)['error']).toBe('item_not_found')

  const itemId = items(boot)[0]!.id
  expect(
    (await orchestratorAssignRoute({ projectId: 'p1', itemId, expectedVersion: 1 }, { ledger: rt, enabled: true }))
      .status
  ).toBe(200)
  const twice = await orchestratorAssignRoute(
    { projectId: 'p1', itemId, expectedVersion: 2 },
    { ledger: rt, enabled: true }
  )
  expect(twice.status).toBe(409)
  expect(body(twice)['error']).toBe('invalid_state')
  expect(count(rt.db, 'task')).toBe(1)
})

test('both routes answer 503 when the flag or the ledger is off', async () => {
  const rt = runtime()
  const off = { ledger: rt, enabled: false }
  expect((await orchestratorBootstrapRoute(bootstrapBody(), off)).status).toBe(503)
  expect(body(await orchestratorBootstrapRoute(bootstrapBody(), off))['error']).toBe('orchestrator_off')
  expect((await orchestratorAssignRoute({ projectId: 'p1', itemId: 'x', expectedVersion: 1 }, off)).status).toBe(503)
  const noLedger = { ledger: null, enabled: true }
  expect((await orchestratorBootstrapRoute(bootstrapBody(), noLedger)).status).toBe(503)
  expect(body(await orchestratorBootstrapRoute(bootstrapBody(), noLedger))['error']).toBe('ledger_off')
  expect(count(rt.db, 'project')).toBe(0)
})

test('bootstrap validates path and items before touching the ledger', async () => {
  const rt = runtime()
  const cases: [Record<string, unknown>, string][] = [
    [{ path: '/does/not/exist' }, 'invalid_path'],
    [{ path: 'relative/dir' }, 'invalid_path'],
    // A plain directory without a `.git` marker is not a worktree root.
    [{ path: root }, 'invalid_path'],
    [{ items: [] }, 'invalid_items'],
    [{ items: Array.from({ length: 21 }, (_, i) => ({ title: `t${i}` })) }, 'invalid_items'],
    [{ items: [{ title: '' }] }, 'invalid_item_title'],
    // Scope is mandatory: no silent `src` default that mis-scopes a repo without src.
    [{ items: [{ title: 'x' }] }, 'invalid_scope'],
    [{ items: [{ title: 'x', scope: [] }] }, 'invalid_scope'],
    [{ items: [{ title: 'x', scope: ['/etc'] }] }, 'invalid_scope'],
    [{ items: [{ title: 'x', scope: ['..'] }] }, 'invalid_scope'],
  ]
  for (const [patch, code] of cases) {
    const result = await orchestratorBootstrapRoute(bootstrapBody(patch), { ledger: rt, enabled: true })
    expect(result.status).toBe(400)
    expect(body(result)['error']).toBe(code)
  }
  expect(count(rt.db, 'project')).toBe(0)
  expect(count(rt.db, 'agent')).toBe(0)
})

test('a `.git` file (linked worktree pointer) also marks a valid root', () => {
  const linked = join(root, 'linked')
  mkdirSync(linked, { recursive: true })
  writeFileSync(join(linked, '.git'), 'gitdir: /elsewhere\n')
  expect(parseBootstrapBody({ ...bootstrapBody(), path: linked }).ok).toBe(true)
})

test('a plan failure rolls back the project and both agents', async () => {
  const rt = runtime()
  const failing: Pick<PlanStore, 'get' | 'create' | 'assign'> = {
    get: () => null,
    create: () => {
      throw new Error('plan write failed')
    },
    assign: () => {
      throw new Error('unused')
    },
  }
  const result = await orchestratorBootstrapRoute(bootstrapBody(), { ledger: rt, enabled: true, plan: failing })
  expect(result.status).toBe(500)
  expect(body(result)['error']).toBe('internal')
  expect(count(rt.db, 'project')).toBe(0)
  expect(count(rt.db, 'agent')).toBe(0)
  expect(count(rt.db, 'plan')).toBe(0)
})
