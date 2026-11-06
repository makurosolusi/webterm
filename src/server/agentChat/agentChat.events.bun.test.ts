import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CHAT_TOOL_RESULT_MAX } from '../../shared/agentChat.wire'
import { createAgentChatMapper } from './agentChat.events'
import { fx } from './agentChat.fakeQuery'

describe('createAgentChatMapper', () => {
  test('init is emitted only when session, model or mode changes', () => {
    const m = createAgentChatMapper()
    expect(m.map(fx.init())).toEqual([{
      t: 'init', sessionId: 's-1', model: 'claude-test', mode: 'default', commands: ['compact'], capabilities: ['interrupt'], cliVersion: '2.1.300',
    }])
    expect(m.map(fx.init())).toEqual([])
    expect(m.map(fx.init('s-1', 'claude-test', 'plan'))).toHaveLength(1)
  })

  test('status maps permission mode, requesting, compacting and api retry', () => {
    const m = createAgentChatMapper()
    expect(m.map(fx.status({ permissionMode: 'acceptEdits' }))).toEqual([{ t: 'mode', mode: 'acceptEdits' }])
    expect(m.map(fx.status({ status: 'requesting' }))).toEqual([{ t: 'status', status: 'thinking' }])
    expect(m.map(fx.status({ status: 'compacting' }))).toEqual([{ t: 'status', status: 'thinking', detail: 'compacting' }])
    expect(m.map(fx.retry(2, 1500))).toEqual([{ t: 'status', status: 'retry', detail: 'attempt 2, retrying in 2s' }])
  })

  test('deltas are keyed by the message_start id and carry parentId', () => {
    const m = createAgentChatMapper()
    expect(m.map(fx.textDelta('lost'))).toEqual([])
    m.map(fx.messageStart('msg-1'))
    expect(m.map(fx.textDelta('Hel'))).toEqual([{ t: 'delta', messageId: 'msg-1', kind: 'text', text: 'Hel' }])
    expect(m.map(fx.thinkingDelta('hmm'))).toEqual([{ t: 'delta', messageId: 'msg-1', kind: 'thinking', text: 'hmm' }])
    expect(m.map(fx.textDelta('sub', 'tu-parent'))[0]).toMatchObject({ parentId: 'tu-parent' })
  })

  test('assistant blocks merge by message id and tool_use opens a running tool card', () => {
    const m = createAgentChatMapper()
    expect(m.map(fx.assistant('msg-1', [{ type: 'thinking', thinking: 'plan' }]))).toEqual([
      { t: 'message', messageId: 'msg-1', role: 'assistant', parts: [{ k: 'thinking', text: 'plan' }] },
    ])
    const out = m.map(fx.assistant('msg-1', [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }]))
    expect(out).toEqual([
      { t: 'message', messageId: 'msg-1', role: 'assistant', parts: [{ k: 'thinking', text: 'plan' }, { k: 'tool', id: 'tu-1' }] },
      { t: 'tool', id: 'tu-1', name: 'Bash', input: { command: 'ls' }, state: 'running' },
      { t: 'status', status: 'tool' },
    ])
    // The same tool block again does not duplicate the part or the card.
    expect(m.map(fx.assistant('msg-1', [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }]))).toHaveLength(1)
  })

  test('tool results map to done, error, denied and truncate long output', () => {
    const m = createAgentChatMapper()
    m.map(fx.assistant('msg-1', [
      { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } },
      { type: 'tool_use', id: 'b', name: 'Bash', input: {} },
      { type: 'tool_use', id: 'c', name: 'Write', input: {} },
    ]))
    expect(m.map(fx.toolResult('a', [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }]))).toEqual([
      { t: 'tool', id: 'a', name: 'Read', input: { file_path: '/x' }, state: 'done', result: 'one\ntwo' },
    ])
    expect(m.map(fx.toolResult('b', 'boom', true))[0]).toMatchObject({ state: 'error', result: 'boom' })
    m.denied('c')
    expect(m.map(fx.toolResult('c', 'denied by user', true))[0]).toMatchObject({ state: 'denied' })
    const long = m.map(fx.toolResult('a', 'x'.repeat(AGENT_CHAT_TOOL_RESULT_MAX + 5)))[0]
    expect(long).toMatchObject({ truncated: true })
    expect(long && 'result' in long ? long.result?.length : 0).toBe(AGENT_CHAT_TOOL_RESULT_MAX)
  })

  test('sub-agent tool results carry parentId', () => {
    const m = createAgentChatMapper()
    expect(m.map(fx.toolResult('z', 'ok', false, 'task-1'))[0]).toMatchObject({ parentId: 'task-1', state: 'done' })
  })

  test('cumulative cost passes through unchanged across two turns', () => {
    const m = createAgentChatMapper()
    expect(m.map(fx.result({ cost: 0.02, denials: 2 }))).toEqual([
      { t: 'result', costUsd: 0.02, durationMs: 1200, isError: false, interrupted: false, usage: { input_tokens: 10, output_tokens: 5 }, denials: 2 },
      { t: 'status', status: 'idle' },
    ])
    expect(m.map(fx.result({ cost: 0.05 }))[0]).toMatchObject({ costUsd: 0.05, denials: 0 })
  })

  test('error_during_execution after an interrupt is interrupted, otherwise an error', () => {
    const m = createAgentChatMapper()
    m.markInterrupt()
    const stopped = m.map(fx.result({ subtype: 'error_during_execution', isError: true }))
    expect(stopped[0]).toMatchObject({ interrupted: true })
    expect(stopped[1]).toEqual({ t: 'status', status: 'interrupted' })
    // The interrupt flag is per turn.
    expect(m.map(fx.result({ subtype: 'error_during_execution', isError: true }))[1]).toEqual({ t: 'status', status: 'error', detail: 'error_during_execution' })
    expect(m.map(fx.result({ subtype: 'error_max_turns', isError: true }))[1]).toEqual({ t: 'status', status: 'error', detail: 'error_max_turns' })
  })

  test('denial notices from the CLI mark the tool denied', () => {
    const m = createAgentChatMapper()
    m.map({ type: 'system', subtype: 'permission_denied', tool_use_id: 'q' } as unknown as SDKMessage)
    expect(m.map(fx.toolResult('q', 'no', true))[0]).toMatchObject({ state: 'denied' })
  })

  test('unknown message types are ignored without throwing', () => {
    const m = createAgentChatMapper()
    expect(m.map({ type: 'future_thing', payload: 1 } as unknown as SDKMessage)).toEqual([])
    expect(m.map({ type: 'system', subtype: 'hook_started' } as unknown as SDKMessage)).toEqual([])
  })
})
