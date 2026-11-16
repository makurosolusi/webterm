// Root-lock of the production adapters: resume goes through `resumeAgent` and ends in the typed revive (only from
// orphaned / session_exited), refusals come back as codes, permit is the real guard, spawn goes through the executor.
import { expect, test } from 'bun:test'
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import type { AgentExecutor, AgentHost } from '../agents/agentExecutor'
import { createAgentStore } from '../agents/agentStore'
import { createControlGuard } from '../guard/controlGuard'
import { freshDb, T0 } from '../guard/controlGuard.testutil'
import { PROJECT_PAUSED } from '../centralModel'
import { createRecoverPorts } from './workRecover.ports'
import type { WorkSupervisorPorts } from './workSupervisor'

function setup(state: 'orphaned' | 'session_exited' | 'failed', opts: { transcript?: number | null } = {}) {
  const db = freshDb()
  const now = () => T0
  const agents = createAgentStore(db, now)
  agents.create({ id: 'a1', projectId: 'p1', kind: 'claude', role: 'worker', runner: 'pty', owner: 'central:global', reqId: 'r1' })
  db.query("UPDATE central_agents SET state = ?, node_id = 'c-a1', ended_at = 1 WHERE id = 'a1'").run(state)
  const launches: string[] = []
  const host = { hasSession: () => false, worktreeOf: () => '/wt/a1', resumePty: async (_a: unknown, _c: string, node: string) => { launches.push(node) } } as unknown as AgentHost
  const spawned: unknown[] = []
  const prompts: string[] = []
  const executor = {
    store: agents,
    spawn: async (input: unknown) => { spawned.push(input); return { ok: true, data: { agentId: 'ag-new' } } },
    prompt: async (_a: unknown, text: string) => { prompts.push(text); return { ok: true } },
  } as unknown as AgentExecutor
  const guard = createControlGuard({ db, now, env: {} })
  const base = { isLive: () => false, submit: async () => ({ ok: true, started: true }), chatBusy: () => false, chatNodeGone: () => false, chatSend: async () => ({ ok: true }) } as unknown as WorkSupervisorPorts
  const ports = createRecoverPorts({
    db, now, base, sessions: { statusOf: () => undefined } as Pick<WorkerSessionPort, 'statusOf'>, runtime: () => ({ executor, host, guard, requireApproval: false }),
    probes: { transcript: () => (opts.transcript === undefined ? T0 : opts.transcript), dirExists: () => true },
  })
  return { db, agents, ports, launches, spawned, prompts }
}

test('resume launches the PTY and revives the row of an orphaned or exited agent', async () => {
  for (const state of ['orphaned', 'session_exited'] as const) {
    const s = setup(state)
    expect(await s.ports.resume('a1')).toEqual({ ok: true })
    expect(s.launches).toEqual(['c-a1'])
    expect(s.agents.get('a1')?.state).toBe('working')
  }
})

test('a refusal comes back as its code with nothing launched and the row untouched', async () => {
  const s = setup('orphaned', { transcript: null })
  expect(await s.ports.resume('a1')).toEqual({ ok: false, code: 'transcript_missing' })
  expect(s.launches.length).toBe(0)
  expect(s.agents.get('a1')?.state).toBe('orphaned')
  const old = setup('orphaned', { transcript: T0 - 2 * 60 * 60_000 })
  expect(await old.ports.resume('a1')).toEqual({ ok: false, code: 'too_old' })
})

test('a failed agent is relaunched but never revived: only the clean respawn replaces it', async () => {
  const s = setup('failed')
  expect(await s.ports.resume('a1')).toEqual({ ok: true })
  expect(s.agents.get('a1')?.state).toBe('failed')
})

test('permit is the real guard: a paused project is denied with its code', () => {
  const s = setup('orphaned')
  expect(s.ports.permit('p1', 'work.recover')).toEqual({ ok: true })
  s.db.query('UPDATE project SET status = ? WHERE id = ?').run(PROJECT_PAUSED, 'p1')
  expect(s.ports.permit('p1', 'work.recover')).toEqual({ ok: false, code: 'project_paused' })
})

test('respawn goes through the executor spawn with the approval mode, and the brief is steered in', async () => {
  const s = setup('orphaned')
  const r = await s.ports.respawn({ projectId: 'p1', kind: 'claude', role: 'worker', owner: 'central:global', title: 'Recover: x', taskId: 't1', reqId: 'rq' })
  expect(r).toEqual({ ok: true, agentId: 'ag-new', nodeId: 'c-ag-new' })
  expect(s.spawned[0]).toMatchObject({ taskId: 't1', reqId: 'rq', requireApproval: false })
  expect(await s.ports.brief('a1', 'go on')).toBe(true)
  expect(s.prompts).toEqual(['go on'])
})
