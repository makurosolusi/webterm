import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import { READ_TOOLS_FLAG } from './read.shared'
import { TASK_READ_DEFS } from './read.task'

let f: Fixture
beforeEach(() => { f = openFixture(); seedPortfolio(f.db) })
afterEach(() => f.close())

function ctx(): ToolCtx {
  const registry = createRegistry()
  TASK_READ_DEFS.forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R0', conversationId: 'central:global', now: () => 1, env: { [READ_TOOLS_FLAG]: 'on' } }
}

describe('task.status', () => {
  it('summarizes counts and the latest tasks of the project only', async () => {
    const data = (await execTool(ctx(), 'task.status', { projectId: 'p1' })).data as { counts: Record<string, number>; total: number; recent: Array<{ id: string }> }
    expect(data.counts).toEqual({ verified: 2, failed: 1, pending: 1, claimed_done: 1 })
    expect(data.total).toBe(5)
    expect(data.recent.map((t) => t.id)).toEqual(['t-verified-new', 't-failed', 't-verified-old', 't-done', 't-pending'])
    expect(JSON.stringify(data)).not.toContain('t-p2')
  })

  it('returns one task with clipped spec and evidence, and hides other projects tasks', async () => {
    f.db.query('UPDATE task SET spec = ?, evidence_json = ? WHERE id = ?').run('s'.repeat(500), JSON.stringify({ log: 'e'.repeat(3000) }), 't-failed')
    const task = (await execTool(ctx(), 'task.status', { projectId: 'p1', taskId: 't-failed' })).data?.task as { status: string; spec: string; evidence: string }
    expect(task.status).toBe('failed')
    expect(task.spec.length).toBe(200)
    expect(task.evidence.length).toBe(1500)
    expect(await execTool(ctx(), 'task.status', { projectId: 'p1', taskId: 't-p2-failed' })).toMatchObject({ ok: false, code: 'task_not_found' })
    expect(await execTool(ctx(), 'task.status', { projectId: 'p1', taskId: 'bad id!' })).toMatchObject({ ok: false, code: 'invalid_shape' })
  })
})

describe('run.result', () => {
  beforeEach(() => {
    f.db.query("UPDATE run SET task_id = 't-failed', outcome = 'failed', failure_label = 'tests_red', evidence_json = ? WHERE id = 'r1'").run(JSON.stringify({ out: 'x'.repeat(4000) }))
    f.db.query("INSERT INTO run (id, project_id, task_id, outcome, started_at) VALUES ('r-new', 'p1', 't-failed', 'ok', ?)").run(2_000_000_000_000)
  })

  it('returns the latest run of a task, or a run by id, scoped to the project', async () => {
    expect((await execTool(ctx(), 'run.result', { projectId: 'p1', taskId: 't-failed' })).data).toMatchObject({ runId: 'r-new', outcome: 'ok' })
    const byId = (await execTool(ctx(), 'run.result', { projectId: 'p1', runId: 'r1' })).data as { failureLabel: string; evidence: string }
    expect(byId.failureLabel).toBe('tests_red')
    expect(byId.evidence.length).toBe(1500)
    expect(await execTool(ctx(), 'run.result', { projectId: 'p1', runId: 'r3' })).toMatchObject({ ok: false, code: 'run_not_found' })
    expect(await execTool(ctx(), 'run.result', { projectId: 'p1', taskId: 't-pending' })).toMatchObject({ ok: false, code: 'run_not_found' })
  })

  it('requires exactly one of taskId/runId and an existing task', async () => {
    expect(await execTool(ctx(), 'run.result', { projectId: 'p1' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await execTool(ctx(), 'run.result', { projectId: 'p1', taskId: 't-failed', runId: 'r1' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await execTool(ctx(), 'run.result', { projectId: 'p1', taskId: 'nope' })).toMatchObject({ ok: false, code: 'task_not_found' })
  })
})
