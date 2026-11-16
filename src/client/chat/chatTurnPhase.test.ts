import { describe, expect, it } from 'vitest'
import { announceState, announcement, turnPhase } from './chatTurnPhase'
import type { ChatMessage, ChatPart } from './chatTypes'

const human: ChatMessage = { id: 'h', role: 'human', seq: 1, state: 'complete', parts: [{ type: 'text', text: 'hi' }] } // test-only
const reply = (parts: ChatPart[]): ChatMessage => ({ id: 'a', role: 'assistant', seq: null, state: 'streaming', parts }) // test-only
const tool = (state: 'requested' | 'running' | 'succeeded' | 'awaiting_approval'): ChatPart => ({ type: 'tool', toolCallId: 'c', name: 'node.list', state })

describe('turnPhase (lock: one phase per situation)', () => {
  it('shows nothing when idle, also after a finished reply', () => {
    expect(turnPhase({ stream: 'open', busy: false, messages: [human, reply([{ type: 'text', text: 'done' }])] })).toEqual({ phase: 'idle' })
  })
  it('waiting: the turn runs but no reply token or tool exists yet', () => {
    expect(turnPhase({ stream: 'open', busy: true, messages: [human] }).phase).toBe('waiting')
    expect(turnPhase({ stream: 'open', busy: true, messages: [human, reply([])] }).phase).toBe('waiting')
  })
  it('streaming: reply text is growing', () => {
    expect(turnPhase({ stream: 'open', busy: true, messages: [human, reply([{ type: 'text', text: 'Hel' }])] }).phase).toBe('streaming')
  })
  it('tool: a running tool wins over earlier text and carries the friendly title', () => {
    const info = turnPhase({ stream: 'open', busy: true, messages: [human, reply([{ type: 'text', text: 'Let me look' }, tool('running')])] })
    expect(info).toEqual({ phase: 'tool', tool: 'List nodes' })
  })
  it('a finished tool falls back to streaming; a pending approval is its own phase', () => {
    expect(turnPhase({ stream: 'open', busy: true, messages: [human, reply([{ type: 'text', text: 'x' }, tool('succeeded')])] }).phase).toBe('streaming')
    expect(turnPhase({ stream: 'open', busy: true, messages: [human, reply([tool('awaiting_approval')])] }).phase).toBe('approval')
  })
  it('does not read the previous turn: a human message ends the scan', () => {
    expect(turnPhase({ stream: 'open', busy: true, messages: [reply([tool('running')]), human] }).phase).toBe('waiting')
  })
  it('reconnecting beats every other phase, busy or not', () => {
    expect(turnPhase({ stream: 'reconnecting', busy: true, messages: [human] }).phase).toBe('reconnecting')
    expect(turnPhase({ stream: 'reconnecting', busy: false, messages: [] }).phase).toBe('reconnecting')
  })
})

describe('announcement (lock: once per coarse change, never per token)', () => {
  it('maps phases to coarse states; the error state only exists while idle', () => {
    expect(announceState('waiting', false)).toBe('working')
    expect(announceState('streaming', false)).toBe('working')
    expect(announceState('tool', false)).toBe('working')
    expect(announceState('idle', true)).toBe('failed')
    expect(announceState('idle', false)).toBe('idle')
    expect(announceState('reconnecting', true)).toBe('reconnecting')
  })
  it('speaks on start, finish, failure and reconnect; stays silent otherwise', () => {
    expect(announcement('idle', 'working')).toBe('Responding…')
    expect(announcement('working', 'working')).toBeNull()
    expect(announcement('working', 'idle')).toBe('Response complete.')
    expect(announcement('working', 'failed')).toBe('Something went wrong.')
    expect(announcement('working', 'reconnecting')).toBe('Connection lost. Reconnecting…')
    expect(announcement('failed', 'idle')).toBeNull()
  })
})
