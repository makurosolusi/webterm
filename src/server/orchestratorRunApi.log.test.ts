import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import type { PlanStore } from './orchestrator/plan'
import { logBus } from './logs'
import { orchestratorRunRoute } from './orchestratorRunApi'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const ledger = { db: { query: () => ({ get: () => ({ path: '/srv/repos/p1', status: 'active' }) }) }, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
const plan = {
  get: () => ({ id: 'pl1', projectId: 'p1', version: 1, status: 'active', createdAt: 1, updatedAt: 1,
    items: [{ id: 'i1', planId: 'pl1', seq: 0, taskId: 't1', title: 'x', scope: [], status: 'assigned', assignee: 'ag1', assignedAt: 1, updatedAt: 1 }] }),
} as unknown as Pick<PlanStore, 'get'>

it('an unexpected run failure answers a context-free 500 but logs the cause with project and item', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'webterm-runlog-'))
  dirs.push(dataDir)
  const before = logBus.query({}).length
  const result = await orchestratorRunRoute({ projectId: 'p1', itemId: 'i1', expectedVersion: 1 }, {
    ledger, enabled: true, requireApproval: false, planStore: plan, dataDir: () => dataDir,
    settings: () => ({}), claudeOnPath: () => true,
    createRuntime: () => { throw new Error('pty spawn exhausted') },
  })
  expect(result).toEqual({ status: 500, body: { ok: false, error: { code: 'internal', message: 'orchestrator run failed' } } })
  const entry = logBus.query({}).slice(before).find((e) => e.event === 'orchestrator.run_failed')
  expect(entry?.level).toBe('error')
  expect(entry?.data).toMatchObject({ projectId: 'p1', itemId: 'i1', error: 'pty spawn exhausted' })
})
