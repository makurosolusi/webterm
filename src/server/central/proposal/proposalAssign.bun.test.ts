import { expect, test } from 'bun:test'
import { allRows } from '../../ledger/ledgerCore'
import { createLedger } from '../../ledger/ledger'
import { createPlanStore } from '../../orchestrator/plan'
import { memoryLedgerRuntime } from '../../approvalTestRuntime.testutil'
import type { Database } from 'bun:sqlite'
import { applyProposal } from './applyProposal'

interface Fixture { db: Database; close(): void }
function fixture(): Fixture {
  const base = memoryLedgerRuntime(1_000)
  const ledger = createLedger(base.runtime.db, { now: () => 1_000 })
  ledger.project.createProject({ id: 'assign-project', workspaceId: 'w-assign', name: 'Assign', path: '/tmp/assign' })
  ledger.agent.createAgent({ id: 'orch:assign-project', projectId: 'assign-project', name: 'orch', role: 'orchestrator', depth: 1 })
  ledger.agent.createAgent({ id: 'worker:assign-project', projectId: 'assign-project', name: 'worker', role: 'worker', depth: 2, parentAgentId: 'orch:assign-project' })
  return { db: base.runtime.db, close: base.runtime.close }
}
function plan(f: Fixture): { itemId: string; pendingItemId: string; version: number } {
  const created = createPlanStore(f.db, { now: () => 1_000 }).create({ projectId: 'assign-project', status: 'active', items: [{ title: 'Do it', scope: ['src'] }, { title: 'Do next', scope: ['src'] }] })
  return { itemId: created.items[0]!.id, pendingItemId: created.items[1]!.id, version: created.version }
}

test('task.assign off has no effect', async () => {
  const f = fixture(); const item = plan(f); const previous = process.env.WEBTERM_ORCHESTRATOR_RUN
  delete process.env.WEBTERM_ORCHESTRATOR_RUN
  try {
    const result = await applyProposal(f.db, { tool: 'task.assign', projectId: 'assign-project', input: { projectId: 'assign-project', itemId: item.itemId, expectedVersion: item.version } })
    expect(result.code).toBe('orchestrator_off')
    expect(result.ok).toBe(false)
    expect(allRows(f.db, 'SELECT * FROM task').length).toBe(0)
  } finally { if (previous === undefined) delete process.env.WEBTERM_ORCHESTRATOR_RUN; else process.env.WEBTERM_ORCHESTRATOR_RUN = previous; f.close() }
})

test('task.assign creates task, rejects stale version, and reports unknown item', async () => {
  const f = fixture(); const item = plan(f); const previous = process.env.WEBTERM_ORCHESTRATOR_RUN; const prevCentral = process.env.WEBTERM_CENTRAL
  process.env.WEBTERM_ORCHESTRATOR_RUN = 'on'; process.env.WEBTERM_CENTRAL = 'on' // workers butuh central (implies)
  try {
    const input = { projectId: 'assign-project', itemId: item.itemId, expectedVersion: item.version, assignee: 'worker:assign-project' }
    const success = await applyProposal(f.db, { tool: 'task.assign', projectId: 'assign-project', input })
    expect(success.ok).toBe(true)
    expect(allRows(f.db, 'SELECT * FROM task').length).toBe(1)
    const assigned = createPlanStore(f.db).get('assign-project')?.items[0]
    expect(assigned?.status).toBe('assigned')
    expect(assigned?.taskId).toBe(success.taskId)
    expect(allRows(f.db, "SELECT * FROM event WHERE kind = 'central.proposal'").length).toBe(1)
    const stale = await applyProposal(f.db, { tool: 'task.assign', projectId: 'assign-project', input: { ...input, itemId: item.pendingItemId } })
    expect(stale.code).toBe('plan_stale')
    expect(allRows(f.db, 'SELECT * FROM task').length).toBe(1)
    const missing = await applyProposal(f.db, { tool: 'task.assign', projectId: 'assign-project', input: { ...input, itemId: 'missing', expectedVersion: 2 } })
    expect(missing.code).toBe('item_not_found')
    expect(allRows(f.db, 'SELECT * FROM task').length).toBe(1)
  } finally { if (previous === undefined) delete process.env.WEBTERM_ORCHESTRATOR_RUN; else process.env.WEBTERM_ORCHESTRATOR_RUN = previous; if (prevCentral === undefined) delete process.env.WEBTERM_CENTRAL; else process.env.WEBTERM_CENTRAL = prevCentral; f.close() }
})
