import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AGENT_TERMINAL_STATES,
  AGENT_TRANSITIONS,
  CONTROL_LEVELS,
  type AgentRecord,
  type AgentState,
  type ChannelAdapter,
  type ContextAssembler,
  type ControlGuard,
  type ControlLevel,
  type GuardDecision,
  type InboundEvent,
  type KnowledgePort,
  type MemoryBlockProvider,
  type SkillStore,
  type Tier,
  type ToolExecResult,
} from './index'

const STATES = Object.keys(AGENT_TRANSITIONS) as AgentState[]

describe('control level ladder', () => {
  it('lists the five persisted levels in ascending authority', () => {
    expect([...CONTROL_LEVELS]).toEqual(['off', 'observe', 'propose', 'act_gated', 'act_envelope'])
    expectTypeOf<ControlLevel>().toEqualTypeOf<'off' | 'observe' | 'propose' | 'act_gated' | 'act_envelope'>()
    expectTypeOf<Tier>().toEqualTypeOf<'R0' | 'R1' | 'R2' | 'R3'>()
  })
})

describe('agent state machine table', () => {
  it('has an entry for every state and only known targets', () => {
    for (const from of STATES) {
      for (const to of AGENT_TRANSITIONS[from]) expect(STATES).toContain(to)
    }
    expect(STATES).toHaveLength(19)
  })

  it('terminal states have no outgoing edge and nothing else is terminal', () => {
    for (const s of STATES) {
      const terminal = (AGENT_TERMINAL_STATES as readonly AgentState[]).includes(s)
      expect(AGENT_TRANSITIONS[s].length === 0).toBe(terminal)
    }
  })

  it('allows the documented happy path and the bounded retry', () => {
    const path: AgentState[] = [
      'requested', 'approval_pending', 'provisioning', 'starting', 'working', 'waiting_input',
      'working', 'candidate_done', 'verifying', 'accepted', 'closing', 'closed',
    ]
    for (let i = 0; i < path.length - 1; i++) expect(AGENT_TRANSITIONS[path[i]]).toContain(path[i + 1])
    expect(AGENT_TRANSITIONS.verifying).toContain('rejected')
    expect(AGENT_TRANSITIONS.rejected).toEqual(expect.arrayContaining(['working', 'failed']))
  })

  it('rejects skipping verification and leaving a terminal state', () => {
    expect(AGENT_TRANSITIONS.working).not.toContain('accepted')
    expect(AGENT_TRANSITIONS.candidate_done).not.toContain('accepted')
    expect(AGENT_TRANSITIONS.closed).not.toContain('working')
  })
})

describe('contract shapes', () => {
  it('fixes the port signatures', () => {
    expectTypeOf<ControlGuard['effectiveLevel']>().parameter(0).toEqualTypeOf<string | null>()
    expectTypeOf<ControlGuard['breaker']['allow']>().toBeFunction()
    expectTypeOf<GuardDecision['verdict']>().toEqualTypeOf<'allow' | 'needs_approval' | 'deny'>()
    expectTypeOf<ToolExecResult>().toHaveProperty('ok')
    expectTypeOf<AgentRecord['state']>().toEqualTypeOf<AgentState>()
    expectTypeOf<ChannelAdapter['verify']>().returns.toEqualTypeOf<InboundEvent | null>()
    expectTypeOf<MemoryBlockProvider['block']>().toBeFunction()
    expectTypeOf<SkillStore['load']>().toBeFunction()
    expectTypeOf<KnowledgePort['brief']>().toBeFunction()
    expectTypeOf<ContextAssembler['build']>().toBeFunction()
  })

  it('lets a mock satisfy the context seam shape', async () => {
    const assembler: ContextAssembler = {
      build: (input) => ({ prompt: input.text, history: [] }),
    }
    const out = await assembler.build({ conversationId: 'c', turnId: 't', projectId: null, text: 'hi' })
    expect(out).toEqual({ prompt: 'hi', history: [] })
  })
})
