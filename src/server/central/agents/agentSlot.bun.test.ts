// Bun-only. A finished (candidate_done) agent holds no worker slot; waking it claims one and is refused when full.
import { expect, test } from 'bun:test'
import { type AgentHost, createAgentExecutor } from './agentExecutor'
import { MAX_WORKERS_GLOBAL, MAX_WORKERS_PER_PROJECT, slotRefusal } from '../guard/controlGuard'
import { addAgent, freshDb, run, T0 } from '../guard/controlGuard.testutil'
import type { ControlGuard } from '../contracts'

function setup() {
  const db = freshDb()
  const now = () => T0
  const guard: ControlGuard = { check: () => ({ verdict: 'allow', level: 'act_gated' }), effectiveLevel: () => 'act_gated', recordUsage: () => undefined, skipsApprovals: () => false,
    breaker: { allow: () => ({ allowed: true, state: 'closed' }), trip: () => 'closed', recordSuccess: () => undefined } }
  const host: AgentHost = {
    runnerFor: () => 'pty', spawnTier: () => 'R2', worktree: async () => '/tmp/wt', initialPrompt: async () => 'go', openPty: async () => undefined, headlessArgv: () => null,
    send: async () => ({ ok: true as const, started: true as const }), scrollback: async () => [], closePty: async () => undefined, hasSession: () => true,
  }
  const ex = createAgentExecutor({ db, guard, host, now })
  const pty = (id: string, projectId: string, state: string) => { addAgent(db, id, projectId, state); run(db, "UPDATE central_agents SET runner = 'pty', node_id = ? WHERE id = ?", `n-${id}`, id) }
  return { db, ex, pty }
}

test('candidate_done does not count toward the caps; waiting_input still does', () => {
  const s = setup()
  for (let i = 0; i < MAX_WORKERS_PER_PROJECT; i++) s.pty(`d${i}`, 'p1', 'candidate_done')
  expect(slotRefusal(s.db, 'p1')).toBeNull()
  for (let i = 0; i < MAX_WORKERS_PER_PROJECT; i++) s.pty(`w${i}`, 'p2', 'waiting_input')
  expect(slotRefusal(s.db, 'p2')).toBe('cap_project')
})

test('waking a finished agent is refused at the project cap and at the global cap', async () => {
  const s = setup()
  s.pty('fin', 'p1', 'candidate_done')
  expect(await s.ex.prompt(s.ex.store.get('fin')!, 'more', 'followup')).toMatchObject({ ok: true })
  expect(s.ex.store.get('fin')?.state).toBe('working')
  s.pty('fin2', 'p1', 'candidate_done')
  s.pty('b', 'p1', 'working')
  s.pty('c', 'p1', 'working')
  expect(await s.ex.prompt(s.ex.store.get('fin2')!, 'more', 'followup')).toMatchObject({ ok: false, code: 'cap_project' })
  expect(s.ex.store.get('fin2')?.state).toBe('candidate_done')
  s.pty('fin3', 'p2', 'candidate_done')
  for (let i = 0; i < MAX_WORKERS_GLOBAL - 3; i++) s.pty(`g${i}`, 'p2', 'working')
  expect(await s.ex.prompt(s.ex.store.get('fin3')!, 'more', 'followup')).toMatchObject({ ok: false, code: 'cap_global' })
})
