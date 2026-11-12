// Bun-only. A spawn parked on an approval card answers from the ledger on retry: an expired card is
// replaced (new id, receipt `approvalStatus`), a rejected one cancels the agent (also from the sweep),
// an approved one starts it. Real ledger + real tool receipt path; guard/host are fakes.
import { expect, test } from 'bun:test'
import type { ControlGuard } from '../contracts'
import { eventKinds, freshDb, T0 } from '../guard/controlGuard.testutil'
import { decideApproval, expireApprovals, getApproval } from '../../ledger/ledgerApproval'
import { getRow } from '../../ledger/ledgerCore'
import { createRegistry } from '../tools/toolRegistry'
import { ALLOW_ALL_GUARD, execToolReceipt } from '../tools/toolExec'
import { AGENTS_FLAG, createAgentDefs } from '../tools/defs/agent.defs'
import { type AgentHost, createAgentExecutor } from './agentExecutor'
import { resumeApprovedAgents } from './agentResume'

const TTL_MS = 15 * 60_000 // test-only: ledgerApproval DEFAULT_TTL_MS

function setup(skipApprovals = false) {
  const db = freshDb()
  const clock = { t: T0 }
  const now = () => clock.t
  const guard: ControlGuard = {
    check: () => ({ verdict: 'needs_approval', level: 'propose', tier: 'R2' }), effectiveLevel: () => 'propose', recordUsage: () => undefined, skipsApprovals: () => skipApprovals,
    breaker: { allow: () => ({ allowed: true, state: 'closed' }), trip: () => 'closed', recordSuccess: () => undefined },
  }
  const sessions = new Set<string>()
  const host: AgentHost = {
    runnerFor: () => 'pty', spawnTier: () => 'R2', worktree: async (a) => `/tmp/wt/${a.id}`, initialPrompt: async () => 'go',
    openPty: async (_a, _cwd, nodeId) => { sessions.add(nodeId) }, headlessArgv: () => null,
    send: async () => ({ ok: true as const, started: true as const }), scrollback: async () => [], closePty: async () => undefined, hasSession: (n) => sessions.has(n),
  }
  const ex = createAgentExecutor({ db, guard, host, now })
  const registry = createRegistry()
  createAgentDefs(ex).forEach((d) => registry.register(d))
  const spawn = () => execToolReceipt(
    { db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R3', conversationId: 'central:global', now, env: { [AGENTS_FLAG]: 'auto' } },
    'agent.spawn', { projectId: 'p1', requestId: 'r1', kind: 'opencode', role: 'worker', title: 'Fix it' },
  )
  const decide = (id: string, approve: boolean) => {
    const d = getRow(db, 'SELECT d.action_digest, d.nonce FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?', id)!
    decideApproval({ db, now }, id, { actor: 'human:test', approve, digest: String(d['action_digest']), nonce: String(d['nonce']) })
  }
  return { db, clock, now, ex, spawn, decide }
}

test('expired card: retry re-pends with a new card id and the receipt says pending', async () => {
  const s = setup()
  const first = await s.spawn()
  const agentId = String(first.result?.data?.agentId)
  expect(first.receipt).toMatchObject({ detail: 'approval_required', evidence: { approvalStatus: 'pending' } })
  expect(first.result?.data?.approvalId).toBe(`agent-${agentId}`)

  s.clock.t += TTL_MS + 1
  const retry = await s.spawn()
  expect(retry.result?.data).toMatchObject({ agentId, approvalId: `agent-${agentId}-2`, approvalStatus: 'pending' })
  expect(retry.receipt.evidence).toMatchObject({ approvalStatus: 'pending' })
  expect(getApproval({ db: s.db, now: s.now }, `agent-${agentId}-2`)?.status).toBe('pending')
  expect(s.ex.store.get(agentId)).toMatchObject({ state: 'approval_pending', approvalId: `agent-${agentId}-2` })

  s.clock.t += TTL_MS + 1
  expect((await s.spawn()).result?.data?.approvalId).toBe(`agent-${agentId}-3`)
})

test('pending card: retry returns the same live card', async () => {
  const s = setup()
  const first = await s.spawn()
  const again = await s.spawn()
  expect(again.result?.data?.approvalId).toBe(first.result?.data?.approvalId)
  expect(again.receipt.evidence).toMatchObject({ approvalStatus: 'pending' })
})

test('rejected card: retry cancels the agent with approval_rejected and keeps saying so', async () => {
  const s = setup()
  const first = await s.spawn()
  const agentId = String(first.result?.data?.agentId)
  s.decide(`agent-${agentId}`, false)
  const retry = await s.spawn()
  expect(retry.receipt).toMatchObject({ outcome: 'denied', detail: 'approval_rejected', evidence: { approvalStatus: 'rejected' } })
  expect(retry.receipt.next).toContain('do not retry')
  expect(s.ex.store.get(agentId)).toMatchObject({ state: 'cancelled', endReason: 'approval_rejected' })
  expect((await s.spawn()).receipt.detail).toBe('approval_rejected')
})

test('rejected card: the resume sweep cancels the agent', async () => {
  const s = setup()
  const agentId = String((await s.spawn()).result?.data?.agentId)
  s.decide(`agent-${agentId}`, false)
  expect(await resumeApprovedAgents(s.db, s.ex, s.now)).toBe(0)
  expect(s.ex.store.get(agentId)).toMatchObject({ state: 'cancelled', endReason: 'approval_rejected' })
})

test('approved card: the sweep resumes the agent once', async () => {
  const s = setup()
  const agentId = String((await s.spawn()).result?.data?.agentId)
  s.decide(`agent-${agentId}`, true)
  expect(await resumeApprovedAgents(s.db, s.ex, s.now)).toBe(1)
  expect(s.ex.store.get(agentId)?.state).toBe('working')
  expect(await resumeApprovedAgents(s.db, s.ex, s.now)).toBe(0)
})

test('approved card: a retry before the sweep starts the agent itself', async () => {
  const s = setup()
  const agentId = String((await s.spawn()).result?.data?.agentId)
  s.decide(`agent-${agentId}`, true)
  const retry = await s.spawn()
  expect(retry.receipt).toMatchObject({ outcome: 'ok', evidence: { approvalStatus: 'approved' } })
  expect(s.ex.store.get(agentId)?.state).toBe('working')
  expect(await resumeApprovedAgents(s.db, s.ex, s.now)).toBe(0)
})

test('approved card that lapsed unused: the sweep puts a fresh card up instead of leaving the agent stuck', async () => {
  const s = setup()
  const agentId = String((await s.spawn()).result?.data?.agentId)
  s.decide(`agent-${agentId}`, true)
  s.clock.t += TTL_MS + 1
  expect(await resumeApprovedAgents(s.db, s.ex, s.now)).toBe(0)
  expect(s.ex.store.get(agentId)).toMatchObject({ state: 'approval_pending', approvalId: `agent-${agentId}-2` })
  expect(getApproval({ db: s.db, now: s.now }, `agent-${agentId}-2`)?.status).toBe('pending')
  // The lapsed consent stays unspent: single use is never bypassed.
  expect(getRow(s.db, 'SELECT d.single_use FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?', `agent-${agentId}`)?.['single_use']).toBe(1)
  expect(await resumeApprovedAgents(s.db, s.ex, s.now)).toBe(0)
  expect(s.ex.store.get(agentId)?.approvalId).toBe(`agent-${agentId}-2`)
})

test('approved card that lapsed unused: a retry re-pends and says pending on the new card', async () => {
  const s = setup()
  const agentId = String((await s.spawn()).result?.data?.agentId)
  s.decide(`agent-${agentId}`, true)
  s.clock.t += TTL_MS + 1
  const retry = await s.spawn()
  expect(retry.receipt).toMatchObject({ detail: 'approval_required', evidence: { approvalStatus: 'pending' } })
  expect(retry.result?.data).toMatchObject({ approvalId: `agent-${agentId}-2`, approvalStatus: 'pending' })
  s.decide(`agent-${agentId}-2`, true)
  expect(await resumeApprovedAgents(s.db, s.ex, s.now)).toBe(1)
  expect(s.ex.store.get(agentId)?.state).toBe('working')
})

const expiredAgent = async (s: ReturnType<typeof setup>): Promise<string> => {
  const agentId = String((await s.spawn()).result?.data?.agentId)
  s.clock.t += TTL_MS + 1
  expect(expireApprovals({ db: s.db, now: s.now })).toBe(1)
  return agentId
}

test('expired card: the sweep cancels the agent and issues no new card', async () => {
  const s = setup()
  const agentId = await expiredAgent(s)
  expect(await resumeApprovedAgents(s.db, s.ex, s.now)).toBe(0)
  expect(s.ex.store.get(agentId)).toMatchObject({ state: 'cancelled', endReason: 'approval_expired' })
  expect(getApproval({ db: s.db, now: s.now }, `agent-${agentId}-2`)).toBeNull()
  expect(eventKinds(s.db, 'central.agent').filter((p) => p['phase'] === 'spawn.expired')).toHaveLength(1)
  expect(await resumeApprovedAgents(s.db, s.ex, s.now)).toBe(0)
  expect(eventKinds(s.db, 'central.agent').filter((p) => p['phase'] === 'spawn.expired')).toHaveLength(1)
})

test('expired card: skip-approvals does not launch it, nobody consented', async () => {
  const s = setup(true)
  const agentId = await expiredAgent(s)
  expect(await resumeApprovedAgents(s.db, s.ex, s.now)).toBe(0)
  expect(s.ex.store.get(agentId)).toMatchObject({ state: 'cancelled', endReason: 'approval_expired' })
})

test('expired card: a retry after the sweep says approval_expired and asks for a new requestId', async () => {
  const s = setup()
  const agentId = await expiredAgent(s)
  await resumeApprovedAgents(s.db, s.ex, s.now)
  const retry = await s.spawn()
  expect(retry.result).toMatchObject({ ok: false, code: 'approval_expired', data: { agentId, approvalStatus: 'expired' } })
  expect(String(retry.result?.data?.hint)).toContain('new requestId')
  expect(s.ex.store.get(agentId)?.state).toBe('cancelled')
  expect(getApproval({ db: s.db, now: s.now }, `agent-${agentId}-2`)).toBeNull()
})
