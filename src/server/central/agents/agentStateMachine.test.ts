import { describe, expect, it } from 'vitest'
import { AGENT_TRANSITIONS, type AgentState } from '../contracts'
import { openFixture, seedPortfolio } from '../centralTestFixture.testutil'
import { AgentTransitionError, MAX_AGENT_ATTEMPTS, assertTransition, canTransition, isTerminalState } from './agentStateMachine'
import { agentReqId, createAgentStore } from './agentStore'

const STATES = Object.keys(AGENT_TRANSITIONS) as AgentState[]

describe('state machine', () => {
  it('accepts exactly the edges of the table and rejects every other pair', () => {
    for (const from of STATES) for (const to of STATES) {
      const legal = AGENT_TRANSITIONS[from].includes(to)
      expect(canTransition(from, to)).toBe(legal)
      if (legal) assertTransition('a', from, to)
      else expect(() => assertTransition('a', from, to)).toThrow(AgentTransitionError)
    }
  })
  it('terminal states have no way out; the happy path is legal end to end', () => {
    for (const s of STATES.filter(isTerminalState)) expect(AGENT_TRANSITIONS[s]).toEqual([])
    const path: AgentState[] = ['requested', 'approval_pending', 'provisioning', 'starting', 'working', 'candidate_done', 'verifying', 'accepted', 'closing', 'closed']
    path.slice(1).forEach((to, i) => expect(canTransition(path[i]!, to)).toBe(true))
  })
  it('limits the rejected -> working retry to MAX_AGENT_ATTEMPTS', () => {
    expect(MAX_AGENT_ATTEMPTS).toBe(3)
    assertTransition('a', 'rejected', 'working', 2)
    expect(() => assertTransition('a', 'rejected', 'working', 3)).toThrow(/illegal_transition/)
  })
})

describe('agent store', () => {
  const setup = () => {
    const f = openFixture(); seedPortfolio(f.db)
    let t = 1000
    const store = createAgentStore(f.db, () => ++t)
    const base = { projectId: 'p1', kind: 'opencode', role: 'worker', runner: 'exec', owner: 'central:c1' } as const
    return { store, base }
  }
  it('persists transitions, stamps end time/reason on terminal, and refuses illegal moves', () => {
    const { store, base } = setup()
    const a = store.create({ ...base, id: 'a1', reqId: agentReqId('p1', 'r1') })
    expect(a.state).toBe('requested')
    expect(store.transition('a1', 'provisioning').state).toBe('provisioning')
    expect(() => store.transition('a1', 'working')).toThrow(/illegal_transition/)
    const ended = store.transition('a1', 'failed', { reason: 'boom' })
    expect(ended.endReason).toBe('boom')
    expect(ended.endedAt).not.toBeNull()
    expect(() => store.transition('a1', 'working')).toThrow(AgentTransitionError)
    expect(store.get('a1')?.state).toBe('failed')
    expect(() => store.transition('nope', 'cancelled')).toThrow(/agent_not_found/)
  })
  it('enforces the fence and the unique req_id', () => {
    const { store, base } = setup()
    store.create({ ...base, id: 'a1', reqId: 'r1' })
    expect(() => store.create({ ...base, id: 'a2', reqId: 'r1' })).toThrow()
    expect(() => store.transition('a1', 'provisioning', { fence: 9 })).toThrow(/stale_fence/)
    expect(store.transition('a1', 'provisioning', { fence: 0 }).state).toBe('provisioning')
  })
  it('lists newest first with a page cap, filters by state, counts non-terminal only', () => {
    const { store, base } = setup()
    for (let i = 0; i < 5; i++) store.create({ ...base, id: `a${i}`, reqId: `r${i}` })
    store.transition('a0', 'cancelled', { reason: 'x' })
    expect(store.list({ projectId: 'p1', limit: 2 }).map((a) => a.id)).toEqual(['a4', 'a3'])
    expect(store.list({ projectId: 'p1', limit: 2, offset: 4 }).map((a) => a.id)).toEqual(['a0'])
    expect(store.list({ projectId: 'p1', states: ['cancelled'] }).map((a) => a.id)).toEqual(['a0'])
    expect(store.list({ projectId: 'p3' })).toEqual([])
    expect(store.countActive('p1')).toBe(4)
    expect(store.listActive().length).toBe(4)
  })
  it('req_id is a stable sha256 of its parts', () => {
    expect(agentReqId('p1', 'x')).toBe(agentReqId('p1', 'x'))
    expect(agentReqId('p1', 'x')).not.toBe(agentReqId('p1', 'y'))
    expect(agentReqId('p1', 'x')).toMatch(/^[0-9a-f]{64}$/)
  })
})
