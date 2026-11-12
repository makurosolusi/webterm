import { describe, expect, it } from 'vitest'
import type { ChatEvent, ChatMessage } from './chatTypes'
import {
  buildOptimisticMessage, chatReducer, initialChatState, orderedMessages,
} from './chatStore'

function event(seq: number, type: string, extras: Partial<ChatEvent> = {}): ChatEvent {
  return { seq, type, conversationId: 'central:global', createdAt: seq, ...extras }
}

function reduce(actions: Parameters<typeof chatReducer>[1][]) {
  return actions.reduce(chatReducer, initialChatState('central:global'))
}

describe('chatStore optimistic echo', () => {
  it('replaces the optimistic row when message.created carries the same clientMessageId', () => {
    let state = chatReducer(initialChatState('central:global'), {
      type: 'optimistic',
      message: buildOptimisticMessage('cm-1', 'deploy main'),
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].optimistic).toBe(true)

    state = chatReducer(state, {
      type: 'event',
      event: event(1, 'message.created', {
        payload: {
          messageId: 'm-human',
          seq: 10,
          role: 'human',
          state: 'complete',
          clientMessageId: 'cm-1',
          parts: [{ type: 'text', text: 'deploy main' }],
        },
      }),
    })

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({ id: 'm-human', seq: 10 })
    expect(state.messages[0].optimistic).toBeFalsy()
    expect(state.lastEventSeq).toBe(1)
  })

  it('keeps a failed optimistic row and reports the error', () => {
    let state = chatReducer(initialChatState('central:global'), {
      type: 'optimistic',
      message: buildOptimisticMessage('cm-2', 'hi'),
    })
    state = chatReducer(state, { type: 'send-failed', clientMessageId: 'cm-2', error: 'offline' })

    expect(state.error).toBe('offline')
    expect(state.messages[0].state).toBe('failed')
  })

  it('drops the optimistic echo when message.created already added the server row', () => {
    let state = chatReducer(initialChatState('central:global'), {
      type: 'optimistic',
      message: buildOptimisticMessage('cm-3', 'hi'),
    })
    state = chatReducer(state, {
      type: 'event',
      event: event(1, 'message.created', {
        payload: { messageId: 'm-real', seq: 7, role: 'human', parts: [{ type: 'text', text: 'hi' }] },
      }),
    })
    state = chatReducer(state, {
      type: 'send-ok', clientMessageId: 'cm-3', messageId: 'm-real', seq: 7, turnId: 't1', status: 'running',
    })

    expect(state.messages.map((message) => message.id)).toEqual(['m-real'])
    expect(state.activeTurnId).toBe('t1')
  })
})

describe('chatStore dedupe', () => {
  it('ignores any frame at or below the last applied seq', () => {
    let state = reduce([
      { type: 'event', event: event(3, 'part.delta', { messageId: 'a1', payload: { text: 'Hel' } }) },
      { type: 'event', event: event(3, 'part.delta', { messageId: 'a1', payload: { text: 'lo' } }) },
      { type: 'event', event: event(2, 'part.delta', { messageId: 'a1', payload: { text: '!' } }) },
      { type: 'event', event: event(4, 'part.delta', { messageId: 'a1', payload: { text: '!' } }) },
    ])

    expect(state.messages[0].parts).toEqual([{ type: 'text', text: 'Hel!' }])
    expect(state.lastEventSeq).toBe(4)
  })
})

describe('chatStore streaming parts', () => {
  it('creates the assistant row from deltas and completes it with final parts', () => {
    let state = reduce([
      // Server wire shape: `{delta}` (not `{text}`), messageId on the event.
      { type: 'event', event: event(1, 'part.delta', { turnId: 't1', messageId: 'a1', payload: { delta: 'Hello', part: 'text' } }) },
      { type: 'event', event: event(2, 'part.delta', { turnId: 't1', messageId: 'a1', payload: { delta: ' world', part: 'text' } }) },
    ])
    expect(state.messages[0]).toMatchObject({ id: 'a1', role: 'assistant', state: 'streaming' })

    state = chatReducer(state, {
      type: 'event',
      event: event(3, 'part.completed', { messageId: 'a1', payload: { text: 'Hello world.' } }),
    })
    expect(state.messages[0].state).toBe('complete')
    expect(state.messages[0].parts).toEqual([{ type: 'text', text: 'Hello world.' }])
  })

  it('updates one tool card through requested -> succeeded', () => {
    let state = chatReducer(initialChatState('central:global'), {
      type: 'event',
      event: event(1, 'tool.requested', {
        turnId: 't1',
        messageId: 'a1',
        payload: { toolCallId: 'call-1', name: 'portfolio.read', input: { scope: 'all' } },
      }),
    })
    expect(state.messages[0].parts).toMatchObject([
      { type: 'tool', toolCallId: 'call-1', name: 'portfolio.read', state: 'requested' },
    ])

    state = chatReducer(state, {
      type: 'event',
      event: event(2, 'tool.completed', {
        messageId: 'a1',
        payload: { toolCallId: 'call-1', name: 'portfolio.read', ok: true, output: { projects: 2 } },
      }),
    })

    const parts = state.messages[0].parts
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: 'tool', state: 'succeeded', result: { projects: 2 } })
  })
})

describe('chatStore turn lifecycle', () => {
  it('tracks one active turn and frees it on done', () => {
    let state = chatReducer(initialChatState('central:global'), {
      type: 'send-ok',
      clientMessageId: 'cm-1',
      messageId: 'm1',
      seq: 5,
      turnId: 't1',
      status: 'running',
    })
    expect(state.activeTurnId).toBe('t1')

    state = chatReducer(state, { type: 'event', event: event(1, 'turn.status', { turnId: 't1', payload: { status: 'succeeded' } }) })
    expect(state.turnStatus).toBe('succeeded')
    expect(state.activeTurnId).toBeNull()

    // A later delta cannot resurrect the lock.
    state = chatReducer(state, { type: 'event', event: event(2, 'part.delta', { messageId: 'a1', payload: { text: 'x' } }) })
    expect(state.activeTurnId).toBeNull()
  })

  it('records a 409 busy turn so Stop is available', () => {
    const state = chatReducer(initialChatState('central:global'), {
      type: 'busy',
      activeTurnId: 't-other-tab',
      error: 'Another turn is running.',
    })
    expect(state.activeTurnId).toBe('t-other-tab')
    expect(state.error).toContain('Another turn')
  })

  it('marks streaming text cancelled on cancel-ok', () => {
    let state = reduce([
      { type: 'event', event: event(1, 'part.delta', { messageId: 'a1', payload: { text: 'partial' } }) },
    ])
    state = chatReducer(state, { type: 'cancel-ok' })
    expect(state.turnStatus).toBe('cancelled')
    expect(state.messages[0].state).toBe('cancelled')
    expect(state.activeTurnId).toBeNull()
  })
})

describe('chatStore hydrate', () => {
  it('merges history, keeps optimistic rows, and orders by seq', () => {
    const optimistic = buildOptimisticMessage('cm-live', 'just sent')
    let state = chatReducer(initialChatState('central:global'), {
      type: 'optimistic',
      message: optimistic,
    })

    const history: ChatMessage[] = [
      { id: 'm2', role: 'assistant', seq: 2, state: 'complete', parts: [{ type: 'text', text: 'b' }] },
      { id: 'm1', role: 'human', seq: 1, state: 'complete', parts: [{ type: 'text', text: 'a' }] },
    ]
    state = chatReducer(state, { type: 'hydrate', messages: history, activeTurnId: null })

    expect(state.hydrated).toBe(true)
    expect(orderedMessages(state).map((message) => message.id)).toEqual(['m1', 'm2', optimistic.id])
  })
})

describe('chatStore failed turn', () => {
  it('puts the error reason on the failed reply, and done does not settle it as complete', () => {
    const state = reduce([
      { type: 'event', event: event(1, 'part.delta', { turnId: 't1', messageId: 'a1', payload: { text: 'Partial' } }) },
      { type: 'event', event: event(2, 'error', { turnId: 't1', messageId: 'a1', payload: { code: 'timeout', message: 'claude timed out' } }) },
      { type: 'event', event: event(3, 'turn.status', { turnId: 't1', payload: { status: 'failed', errorCode: 'timeout' } }) },
      { type: 'event', event: event(4, 'done', { turnId: 't1', payload: { status: 'failed' } }) },
    ])
    expect(state.error).toBe(null)
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].state).toBe('failed')
    expect(state.messages[0].parts).toEqual([
      { type: 'text', text: 'Partial' },
      { type: 'error', code: 'timeout', message: 'claude timed out' },
    ])
  })

  it('a failed turn without an error frame still marks its streaming reply failed', () => {
    const state = reduce([
      { type: 'event', event: event(1, 'part.delta', { turnId: 't1', messageId: 'a1', payload: { text: 'x' } }) },
      { type: 'event', event: event(2, 'turn.status', { turnId: 't1', payload: { status: 'failed' } }) },
      { type: 'event', event: event(3, 'done', { turnId: 't1' }) },
    ])
    expect(state.messages[0].state).toBe('failed')
  })
  it('shows a runtime notice once, ahead of the reply text', () => {
    const note = 'Started a fresh Claude session; the previous one was no longer available.'
    const state = reduce([
      { type: 'event', event: event(1, 'notice', { turnId: 't1', messageId: 'a1', payload: { messageId: 'a1', text: note } }) },
      { type: 'event', event: event(2, 'part.delta', { turnId: 't1', messageId: 'a1', payload: { text: 'hi' } }) },
      { type: 'event', event: event(3, 'notice', { turnId: 't1', messageId: 'a1', payload: { messageId: 'a1', text: note } }) },
    ])
    expect(state.messages[0].parts).toEqual([{ type: 'notice', text: note }, { type: 'text', text: 'hi' }])
  })

})

describe('chatStore text around tool calls', () => {
  it('keeps text before and after a tool run as separate parts, in event order', () => {
    const ids = { turnId: 't1', messageId: 'm-a' }
    const state = reduce([
      { type: 'event', event: event(1, 'part.delta', { ...ids, payload: { delta: 'I will close it' } }) },
      { type: 'event', event: event(2, 'part.delta', { ...ids, payload: { delta: ' now.' } }) },
      { type: 'event', event: event(3, 'tool.requested', { ...ids, payload: { toolCallId: 'c1', name: 'node_close' } }) },
      { type: 'event', event: event(4, 'tool.completed', { ...ids, payload: { toolCallId: 'c1', name: 'node_close', ok: false } }) },
      { type: 'event', event: event(5, 'part.delta', { ...ids, payload: { delta: 'Canvas is empty.' } }) },
    ])
    const parts = state.messages[0]!.parts
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool', 'text'])
    expect(parts[0]).toEqual({ type: 'text', text: 'I will close it now.' })
    expect(parts[1]).toMatchObject({ toolCallId: 'c1', state: 'failed' })
    expect(parts[2]).toEqual({ type: 'text', text: 'Canvas is empty.' })
  })
})
