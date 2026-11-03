import { describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio } from '../centralTestFixture.testutil'
import type { AgentState } from '../contracts'
import { RECONCILE_REASON, reconcileAgents } from './agentReconciler'
import { AgentTransitionError, canTransition } from './agentStateMachine'
import { createAgentStore, type AgentStore } from './agentStore'

const PATH: AgentState[] = ['provisioning', 'starting', 'working', 'waiting_input']
let T = 1_700_000_000_000

function setup() {
  const f = openFixture()
  seedPortfolio(f.db)
  const store = createAgentStore(f.db, () => T++)
  const make = (id: string, upTo: AgentState | null) => {
    store.create({ id, projectId: 'p1', kind: 'opencode', role: 'worker', runner: 'exec', owner: 'human', reqId: `req-${id}` })
    for (const s of PATH) {
      if (upTo === null) break
      if (s === 'waiting_input' && upTo !== 'waiting_input') break
      store.transition(id, s)
      if (s === upTo) break
    }
  }
  return { store, make }
}

describe('agent reconciler', () => {
  it('orphans process-less working agents through a legal edge and leaves the rest alone', async () => {
    const { store, make } = setup()
    make('req', null)
    make('prov', 'provisioning')
    make('work', 'working')
    make('wait', 'waiting_input')
    make('live', 'working')
    expect(canTransition('working', 'orphaned')).toBe(true)

    const report = await reconcileAgents({ store, isAlive: (a) => a.id === 'live' })
    expect(report.examined).toBe(4)
    expect(report.orphaned.sort()).toEqual(['prov', 'wait', 'work'])
    expect(report.skipped).toEqual([])
    for (const id of ['prov', 'work', 'wait']) {
      const row = store.get(id)
      expect(row?.state).toBe('orphaned')
      expect(row?.endReason).toBe(RECONCILE_REASON)
      expect(row?.endedAt).not.toBeNull()
    }
    expect(store.get('live')?.state).toBe('working')
    expect(store.get('req')?.state).toBe('requested')
  })

  it('is idempotent: a second pass changes nothing', async () => {
    const { store, make } = setup()
    make('a', 'working')
    make('b', 'starting')
    const first = await reconcileAgents({ store, isAlive: () => false })
    expect(first.orphaned.sort()).toEqual(['a', 'b'])
    const stamp = store.get('a')?.lastEventAt
    const second = await reconcileAgents({ store, isAlive: () => false })
    expect(second).toEqual({ examined: 0, orphaned: [], skipped: [] })
    expect(store.get('a')?.lastEventAt).toBe(stamp)
  })

  it('skips an agent whose transition lost a race and rethrows other failures with context', async () => {
    const { store, make } = setup()
    make('a', 'working')
    const racing: AgentStore = { ...store, transition: (id) => { throw new AgentTransitionError('concurrent_update', id, 'working', 'orphaned') } }
    const report = await reconcileAgents({ store: racing, isAlive: () => false })
    expect(report.skipped).toEqual(['a'])
    expect(store.get('a')?.state).toBe('working')

    const broken: AgentStore = { ...store, transition: () => { throw new TypeError('disk') } }
    await expect(reconcileAgents({ store: broken, isAlive: () => false })).rejects.toThrow(/reconcile agent a \(working\)/)
  })
})
