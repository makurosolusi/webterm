import { describe, expect, it } from 'vitest'
import type { BrowserState } from '../../shared/browser.contract'
import { type AgentOfNode, type IdlePorts, type IdleReason, classifyBrowserNode, isInUse } from './browser.idle'

const st = (id: string, patch: Partial<BrowserState> = {}): BrowserState => ({ id, url: 'about:blank', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live', ...patch })

interface World {
  states?: Record<string, BrowserState | undefined>
  cables?: Array<[string, string]>
  /** node id -> agent state; nodes not listed but in `onBoard` are non-agent nodes. */
  agents?: Record<string, string>
  onBoard?: string[]
  focus?: string
}
const ACTIVE_NOT = ['candidate_done', 'closed', 'failed', 'timed_out', 'lease_expired', 'session_exited', 'cancelled', 'killed', 'orphaned']

function ports(w: World): IdlePorts {
  return {
    stateOf: (id) => w.states?.[id],
    bridgesOf: () => (w.cables ?? []).map(([source, target]) => ({ source, target })),
    hasNode: (_ws, id) => (w.onBoard ?? []).includes(id) || id in (w.agents ?? {}),
    agentOfNode: (id): AgentOfNode | null => {
      const state = w.agents?.[id]
      return state === undefined ? null : { id: `ag-${id}`, state, active: !ACTIVE_NOT.includes(state) }
    },
    focusedNode: () => w.focus ?? null,
  }
}

const IDLE_STATE = { 'br-1': st('br-1') }
const cases: Array<[string, string, World, IdleReason, boolean]> = [
  ['central node, no cable, human lease', 'br-1', { states: IDLE_STATE }, 'idle', true],
  ['cabled to a candidate_done agent (screenshot case)', 'br-1', { states: IDLE_STATE, cables: [['c-a', 'br-1']], agents: { 'c-a': 'candidate_done' } }, 'idle', true],
  ['cabled to a closed agent', 'br-1', { states: IDLE_STATE, cables: [['c-a', 'br-1']], agents: { 'c-a': 'closed' } }, 'idle', true],
  ['cabled to an orphaned agent', 'br-1', { states: IDLE_STATE, cables: [['br-1', 'c-a']], agents: { 'c-a': 'orphaned' } }, 'idle', true],
  ['cabled to a node that left the board', 'br-1', { states: IDLE_STATE, cables: [['gone', 'br-1']] }, 'idle', true],
  ['cabled to a working agent', 'br-1', { states: IDLE_STATE, cables: [['c-a', 'br-1']], agents: { 'c-a': 'working' } }, 'cabled_active_agent', false],
  ['cabled to a waiting_input agent', 'br-1', { states: IDLE_STATE, cables: [['c-a', 'br-1']], agents: { 'c-a': 'waiting_input' } }, 'cabled_active_agent', false],
  ['cabled to a finished and a working agent', 'br-1', { states: IDLE_STATE, cables: [['c-a', 'br-1'], ['c-b', 'br-1']], agents: { 'c-a': 'candidate_done', 'c-b': 'working' } }, 'cabled_active_agent', false],
  ['cabled to a non-agent node still on the board', 'br-1', { states: IDLE_STATE, cables: [['chat', 'br-1']], onBoard: ['chat'] }, 'cabled_unknown_node', false],
  ['agent lease', 'br-1', { states: { 'br-1': st('br-1', { lease: 'agent' }) } }, 'lease_agent', false],
  ['focused by the user', 'br-1', { states: IDLE_STATE, focus: 'br-1' }, 'focused', false],
  ['loading', 'br-1', { states: { 'br-1': st('br-1', { loading: true }) } }, 'loading', false],
  ['state unknown', 'br-1', { states: {} }, 'state_unknown', false],
  ['discarded page', 'br-1', { states: { 'br-1': st('br-1', { live: 'discarded' }) } }, 'discarded', false],
  ['user-owned node, otherwise idle', 'ub', { states: { ub: st('ub') } }, 'user_owned', false],
]

describe('classifyBrowserNode: one row per situation', () => {
  it.each(cases)('%s', (_name, nodeId, world, reason, idle) => {
    const v = classifyBrowserNode(ports(world), 'w', nodeId)
    expect({ reason, idle }).toEqual({ reason: v.reason, idle: v.idle })
    expect(v.owner).toBe(nodeId.startsWith('br-') ? 'central' : 'user')
  })

  it('reports the blocking agent in cabledTo, else the first cable', () => {
    const busy = classifyBrowserNode(ports({ states: IDLE_STATE, cables: [['c-a', 'br-1'], ['c-b', 'br-1']], agents: { 'c-a': 'candidate_done', 'c-b': 'working' } }), 'w', 'br-1')
    expect(busy.cabledTo).toEqual({ nodeId: 'c-b', agentId: 'ag-c-b', agentState: 'working' })
    const done = classifyBrowserNode(ports({ states: IDLE_STATE, cables: [['c-a', 'br-1']], agents: { 'c-a': 'candidate_done' } }), 'w', 'br-1')
    expect(done.cabledTo).toEqual({ nodeId: 'c-a', agentId: 'ag-c-a', agentState: 'candidate_done' })
    expect(classifyBrowserNode(ports({ states: IDLE_STATE }), 'w', 'br-1').cabledTo).toBeUndefined()
  })

  it('isInUse separates "someone is using it" from "not ours" and "not live"', () => {
    const of = (w: World, id = 'br-1') => isInUse(classifyBrowserNode(ports(w), 'w', id))
    expect(of({ states: { 'br-1': st('br-1', { lease: 'agent' }) } })).toBe(true)
    expect(of({ states: IDLE_STATE, focus: 'br-1' })).toBe(true)
    expect(of({ states: IDLE_STATE })).toBe(false)
    expect(of({ states: { ub: st('ub') } }, 'ub')).toBe(false)
    expect(of({ states: {} })).toBe(false)
  })
})
