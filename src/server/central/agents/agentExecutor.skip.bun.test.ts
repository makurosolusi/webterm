// Bun-only. Skip approvals on agent.spawn: mode `propose` spawns without a card, an agent parked on an
// open card launches on its next spawn, a rejected card stays rejected. Real ledger; guard/host are fakes.
import { expect, test } from 'bun:test'
import type { ControlGuard } from '../contracts'
import { freshDb, T0 } from '../guard/controlGuard.testutil'
import { decideApproval, getApproval } from '../../ledger/ledgerApproval'
import { getRow } from '../../ledger/ledgerCore'
import { type AgentHost, type SpawnInput, createAgentExecutor } from './agentExecutor'

function setup() {
  const db = freshDb()
  const now = () => T0
  const flag = { on: false }
  // Mirrors the real guard: an ask becomes allow while the switch is on.
  const guard: ControlGuard = {
    check: () => (flag.on ? { verdict: 'allow', level: 'act_gated' } : { verdict: 'needs_approval', level: 'act_gated', tier: 'R2' }),
    effectiveLevel: () => 'act_gated', recordUsage: () => undefined, skipsApprovals: () => flag.on,
    breaker: { allow: () => ({ allowed: true, state: 'closed' }), trip: () => 'closed', recordSuccess: () => undefined },
  }
  const sessions = new Set<string>()
  const host: AgentHost = {
    runnerFor: () => 'pty', spawnTier: () => 'R2', worktree: async (a) => `/tmp/wt/${a.id}`, initialPrompt: async () => 'go',
    openPty: async (_a, _cwd, nodeId) => { sessions.add(nodeId) }, headlessArgv: () => null,
    send: async () => undefined, scrollback: async () => [], closePty: async () => undefined, hasSession: (n) => sessions.has(n),
  }
  const ex = createAgentExecutor({ db, guard, host, now })
  const input: SpawnInput = { projectId: 'p1', kind: 'opencode', role: 'worker', title: 'Fix it', reqId: 'r1', owner: 'central:global', requireApproval: true }
  const reject = (id: string) => {
    const d = getRow(db, 'SELECT d.action_digest, d.nonce FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?', id)!
    decideApproval({ db, now }, id, { actor: 'human:test', approve: false, digest: String(d['action_digest']), nonce: String(d['nonce']) })
  }
  return { db, now, flag, ex, input, reject }
}

test('skip on: a propose-mode spawn launches without a card', async () => {
  const s = setup()
  s.flag.on = true
  const r = await s.ex.spawn(s.input)
  expect(r).toMatchObject({ ok: true, data: { state: 'working' } })
  expect(getApproval({ db: s.db, now: s.now }, `agent-${String(r.data?.agentId)}`)).toBeNull()
  expect(await s.ex.gate('p1', 'agent.close', 'R2', true)).toBeNull()
})

test('skip off asks; turning it on launches the parked agent on its next spawn', async () => {
  const s = setup()
  const first = await s.ex.spawn(s.input)
  expect(first).toMatchObject({ ok: false, code: 'approval_required', data: { approvalStatus: 'pending' } })
  expect(await s.ex.gate('p1', 'agent.close', 'R2', true)).toMatchObject({ code: 'approval_required' })
  s.flag.on = true
  const again = await s.ex.spawn(s.input)
  expect(again).toMatchObject({ ok: true, data: { agentId: first.data?.agentId, state: 'working' } })
})

test('skip on still respects a rejected card', async () => {
  const s = setup()
  const first = await s.ex.spawn(s.input)
  s.reject(String(first.data?.approvalId))
  s.flag.on = true
  expect(await s.ex.spawn(s.input)).toMatchObject({ ok: false, code: 'approval_rejected' })
})
