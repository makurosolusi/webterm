// No registered tool can move a task to `done`: agents report, only the user or the verifier accepts.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../../../ledger/migration'
import { WorkError } from '../../work/workModel'
import { createWorkStore } from '../../work/workStore'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { registerCa2Tools } from '../registerAll'
import { createRegistry } from '../toolRegistry'
import { CORE_DEFS } from './core.defs'

const stub = {} as never // test-only: builders capture deps, they never call them at registration
const env = new Proxy({} as Record<string, string>, { get: (_t, k: string) => (k === 'WEBTERM_CENTRAL_AGENTS' ? 'auto' : 'on') })

function everyTool() {
  const registry = createRegistry()
  for (const def of CORE_DEFS) registry.register(def)
  registerCa2Tools(registry, { executor: stub, deliver: stub, openKb: stub, skills: stub, userStore: stub, bots: stub, browser: stub }, env)
  return registry
}

function reviewTask() {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  const store = createWorkStore(db, () => 1)
  store.createTask({ id: 't', projectId: 'p', title: 't', objective: 'o', actor: { kind: 'central' } })
  db.query("UPDATE central_task SET status = 'needs_review' WHERE id = 't'").run()
  return { db, store }
}

test('the registered board tools are exactly the planned ones', () => {
  const names = everyTool().list().map((d) => d.name).filter((n) => n.startsWith('task.')).sort()
  expect(names).toEqual(['task.assign', 'task.cancel', 'task.create', 'task.get', 'task.list', 'task.run', 'task.status', 'task.update'])
})

test('no registered tool sets a done status through its input', async () => {
  const registry = everyTool()
  for (const def of registry.list()) {
    const { db, store } = reviewTask()
    const ctx = { db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R3' as const, conversationId: 'central:global', now: () => 1, env }
    await execTool(ctx, def.name, { projectId: 'p', taskId: 't', status: 'done', fields: { status: 'done' } })
    if (store.getTask('t')?.status !== 'needs_review') throw new Error(`${def.name} moved the task`)
  }
})

test('tool code only moves tasks along non-done edges', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const sources = [...readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.')).map((f) => join(dir, f)), join(dir, '../../work/workDelegation.ts')]
  const targets = sources.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/moveTask\(\s*[^,]+,\s*([^,]+),/g)].map((m) => m[1]))
  expect(targets.sort()).toEqual(["'cancelled'", "'reported'", "'running'", "'todo'", 'restore'])
  expect(sources.filter((file) => readFileSync(file, 'utf8').includes('autoDone'))).toEqual([])
})

test('the store refuses done from Central whatever a tool tries', () => {
  const { store } = reviewTask()
  let code = ''
  try { store.moveTask('t', 'done', { actor: { kind: 'central' } }) } catch (err) { code = err instanceof WorkError ? err.code : 'other' }
  expect(code).toBe('done_forbidden')
})
