import { describe, expect, it } from 'vitest'
import {
  ConversationError,
  GLOBAL_CONVERSATION_ID,
  MAX_MESSAGE_CHARS,
  assertTurnTransition,
  conversationIdForScope,
  isActiveTurnStatus,
  normalizeClientMessageId,
  parseScope,
  scopeFromConversationId,
  validateEventType,
  validateMessageRole,
  validateMessageState,
  validateMessageText,
  validateParts,
  validateTurnStatus,
} from './conversationModel'

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return err instanceof ConversationError ? err.code : `unexpected:${String(err)}`
  }
  return 'no-throw'
}

describe('scope mapping', () => {
  it('maps global and project scopes to canonical conversation ids', () => {
    expect(parseScope('global')).toEqual({ kind: 'global' })
    expect(parseScope('project:p1')).toEqual({ kind: 'project', projectId: 'p1' })
    expect(conversationIdForScope({ kind: 'global' })).toBe(GLOBAL_CONVERSATION_ID)
    expect(conversationIdForScope({ kind: 'project', projectId: 'p1' })).toBe('central:project:p1')
  })

  it('round-trips a canonical id and rejects unknown ids', () => {
    const scope = scopeFromConversationId('central:project:p1')
    expect(scope).toEqual({ kind: 'project', projectId: 'p1' })
    expect(conversationIdForScope(scope)).toBe('central:project:p1')
    expect(code(() => scopeFromConversationId('central:task:t1'))).toBe('invalid_conversation')
    expect(code(() => scopeFromConversationId('central:project:'))).toBe('invalid_conversation')
    expect(code(() => parseScope('project:'))).toBe('invalid_conversation')
    expect(code(() => parseScope('team:p1'))).toBe('invalid_scope')
  })
})

describe('message validation', () => {
  it('accepts only known roles and states', () => {
    expect(validateMessageRole('human')).toBe('human')
    expect(validateMessageState('streaming')).toBe('streaming')
    expect(code(() => validateMessageRole('robot'))).toBe('invalid_role')
    expect(code(() => validateMessageState('done'))).toBe('invalid_state')
  })

  it('trims text and enforces the message cap', () => {
    expect(validateMessageText('  hi  ')).toBe('hi')
    expect(code(() => validateMessageText('   '))).toBe('invalid_message')
    expect(code(() => validateMessageText('x'.repeat(MAX_MESSAGE_CHARS + 1)))).toBe('invalid_message')
  })

  it('normalizes client ids and rejects empty/control values', () => {
    expect(normalizeClientMessageId(undefined)).toBe(null)
    expect(normalizeClientMessageId(null)).toBe(null)
    expect(normalizeClientMessageId('  abc  ')).toBe('abc')
    expect(code(() => normalizeClientMessageId('   '))).toBe('invalid_message')
    expect(code(() => normalizeClientMessageId('bad\u0000id'))).toBe('invalid_message')
  })
})

describe('parts schema', () => {
  it('accepts text, tool, approval, and error parts', () => {
    const parts = validateParts([
      { type: 'text', text: 'hello' },
      { type: 'tool', toolCallId: 'call-1', name: 'mcp__webterm__portfolio.read', state: 'running', risk: 'R0', result: { ok: true } },
      { type: 'approval', approvalId: 'a1', state: 'awaiting_approval', expiresAt: 10 },
      { type: 'error', code: 'runtime_off', message: 'runtime is off' },
    ])
    expect(parts.length).toBe(4)
    expect(parts[1]?.type).toBe('tool')
    expect(parts[2]?.type).toBe('approval')
  })

  it('rejects unknown types, states, risks, and non-JSON args', () => {
    expect(code(() => validateParts([{ type: 'image' }]))).toBe('invalid_parts')
    expect(code(() => validateParts([{ type: 'tool', toolCallId: 'c', name: 'n', state: 'bogus' }]))).toBe('invalid_parts')
    expect(code(() => validateParts([{ type: 'tool', toolCallId: 'c', name: 'n', state: 'running', risk: 'R9' }]))).toBe('invalid_parts')
    expect(code(() => validateParts([{ type: 'text', text: '' }]))).toBe('invalid_parts')
    expect(code(() => validateParts([{ type: 'tool', toolCallId: 'c', name: 'n', state: 'running', args: 10n }]))).toBe('invalid_parts')
    expect(code(() => validateParts('nope'))).toBe('invalid_parts')
    expect(code(() => validateParts(new Array(101).fill({ type: 'text', text: 'x' })))).toBe('invalid_parts')
  })
})

describe('turn state machine', () => {
  it('classifies active and terminal statuses', () => {
    expect(isActiveTurnStatus('queued')).toBe(true)
    expect(isActiveTurnStatus('running')).toBe(true)
    expect(isActiveTurnStatus('awaiting_approval')).toBe(true)
    expect(isActiveTurnStatus('succeeded')).toBe(false)
    expect(isActiveTurnStatus('failed')).toBe(false)
    expect(isActiveTurnStatus('cancelled')).toBe(false)
    expect(validateTurnStatus('cancelled')).toBe('cancelled')
    expect(code(() => validateTurnStatus('done'))).toBe('invalid_turn_status')
  })

  it('allows forward transitions and the same-status no-op', () => {
    expect(() => assertTurnTransition('queued', 'running')).not.toThrow()
    expect(() => assertTurnTransition('running', 'awaiting_approval')).not.toThrow()
    expect(() => assertTurnTransition('awaiting_approval', 'running')).not.toThrow()
    expect(() => assertTurnTransition('running', 'cancelled')).not.toThrow()
    expect(() => assertTurnTransition('cancelled', 'cancelled')).not.toThrow()
  })

  it('rejects resurrection and skipping terminal states', () => {
    expect(code(() => assertTurnTransition('succeeded', 'running'))).toBe('invalid_transition')
    expect(code(() => assertTurnTransition('cancelled', 'failed'))).toBe('invalid_transition')
    expect(code(() => assertTurnTransition('failed', 'succeeded'))).toBe('invalid_transition')
  })
})

describe('event types', () => {
  it('accepts the documented SSE types only', () => {
    expect(validateEventType('part.delta')).toBe('part.delta')
    expect(validateEventType('done')).toBe('done')
    expect(code(() => validateEventType('turn.done'))).toBe('invalid_event')
  })
})
