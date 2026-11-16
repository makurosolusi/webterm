// Root-lock: the only road out of a terminal state is the typed revive, and only from orphaned / session_exited.
// The general transition table stays closed (a resume never loosens it).
import { expect, test } from 'bun:test'
import { AGENT_TERMINAL_STATES, type AgentState } from '../contracts'
import { addAgent, freshDb } from '../guard/controlGuard.testutil'
import { RESUMABLE_STATES, canTransition } from './agentStateMachine'
import { createAgentStore } from './agentStore'

/** Message thrown by fn, or '' (the bun:test typings here have no toThrow). */
const thrown = (fn: () => unknown): string => { try { fn(); return '' } catch (err) { return err instanceof Error ? err.message : String(err) } }

const ALL = [...AGENT_TERMINAL_STATES, 'working', 'waiting_input', 'starting'] as AgentState[]

test('revive: orphaned and session_exited go back to working, ended_at and end_reason cleared', () => {
  for (const from of RESUMABLE_STATES) {
    const db = freshDb()
    addAgent(db, 'a1', 'p1', from)
    db.query("UPDATE central_agents SET ended_at = 5, end_reason = 'pty_exit' WHERE id = 'a1'").run()
    const moved = createAgentStore(db, () => 100).revive('a1')
    expect(moved).toMatchObject({ state: 'working', endedAt: null, endReason: null, lastEventAt: 100 })
  }
})

test('revive refuses every other state, and the general table still has no edge out of a terminal state', () => {
  for (const from of ALL.filter((s) => !RESUMABLE_STATES.includes(s))) {
    const db = freshDb()
    addAgent(db, 'a1', 'p1', from)
    const store = createAgentStore(db, () => 100)
    expect([from, thrown(() => store.revive('a1'))]).toEqual([from, `agent a1: illegal_transition (${from} -> working)`])
    expect(store.get('a1')?.state).toBe(from)
  }
  for (const from of RESUMABLE_STATES) {
    expect(canTransition(from, 'working')).toBe(false)
    const db = freshDb()
    addAgent(db, 'a1', 'p1', from)
    expect(thrown(() => createAgentStore(db, () => 100).transition('a1', 'working'))).toContain('illegal_transition')
  }
})

test('revive of an unknown agent, or one that moved meanwhile, is a typed error', () => {
  const db = freshDb()
  const store = createAgentStore(db, () => 100)
  expect(thrown(() => store.revive('nope'))).toContain('agent_not_found')
  addAgent(db, 'a1', 'p1', 'orphaned')
  store.revive('a1')
  expect(thrown(() => store.revive('a1'))).toContain('illegal_transition')
})
