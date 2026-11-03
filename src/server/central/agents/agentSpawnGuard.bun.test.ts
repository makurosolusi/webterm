// Bun-only. Real control guard + real central_agents rows: caps hold under concurrent spawns and a
// denied spawn leaves no row (the check and the insert are one exclusive step).
import { expect, test } from 'bun:test'
import { createControlGuard, MAX_WORKERS_PER_PROJECT } from '../guard/controlGuard'
import { setLevel } from '../guard/levelStore'
import { freshDb, HUMAN, rows, T0 } from '../guard/controlGuard.testutil'
import { type AgentHost, createAgentExecutor, type SpawnInput } from './agentExecutor'
import { agentReqId } from './agentStore'

const AUTO = { WEBTERM_CENTRAL_AGENTS: 'auto' }

function setup(level: 'propose' | 'act_envelope') {
  const db = freshDb()
  expect(setLevel(db, { scope: 'global', level, actor: HUMAN, now: () => T0 }).ok).toBe(true)
  const guard = createControlGuard({ db, now: () => T0, env: AUTO, random: () => 0 })
  const sessions = new Set<string>()
  const host: AgentHost = {
    runnerFor: () => 'pty', spawnTier: () => 'R2', worktree: async (a) => `/tmp/wt/${a.id}`, initialPrompt: async () => 'do it',
    openPty: async (_a, _cwd, nodeId) => { await Promise.resolve(); sessions.add(nodeId) },
    headlessArgv: () => null, send: async () => undefined, scrollback: async () => [],
    closePty: async () => undefined, hasSession: (n) => sessions.has(n),
  }
  const ex = createAgentExecutor({ db, guard, host, now: () => T0 })
  const input = (n: number): SpawnInput => ({ projectId: 'p1', kind: 'opencode', role: 'worker', title: `t${n}`, reqId: agentReqId('p1', `r${n}`), owner: 'central:c1', requireApproval: false })
  const count = () => rows(db, 'SELECT id FROM central_agents WHERE project_id = ?', 'p1').length
  return { ex, input, count }
}

test('concurrent spawns never exceed the per-project cap', async () => {
  const { ex, input, count } = setup('act_envelope')
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => ex.spawn(input(n))))
  expect(results.filter((r) => r.ok)).toHaveLength(MAX_WORKERS_PER_PROJECT)
  expect(results.filter((r) => !r.ok).map((r) => r.code)).toEqual(Array(3).fill('cap_project'))
  expect(count()).toBe(MAX_WORKERS_PER_PROJECT)
})

test('a spawn denied by the level inserts no row', async () => {
  const { ex, input, count } = setup('propose')
  const res = await ex.spawn(input(1))
  expect([res.ok, res.code]).toEqual([false, 'level_denied'])
  expect(count()).toBe(0)
})
