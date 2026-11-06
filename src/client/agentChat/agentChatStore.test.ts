import { describe, expect, it } from 'vitest'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import { agentChatReducer, initialAgentChatState, isBusyStatus, nodeMode, runningToolName, type AgentChatState, type HistoryItem } from './agentChatStore'

const run = (events: AgentChatEvent[], s: AgentChatState = initialAgentChatState('n1')): AgentChatState =>
  agentChatReducer(s, { type: 'events', events })

const init = (seq: number, sessionId = 'sess-1', mode = 'default'): AgentChatEvent =>
  ({ seq, t: 'init', sessionId, model: 'claude-x', mode, commands: [], capabilities: [], cliVersion: '1.0.0' })
const perm = (seq: number, requestId = 'r1'): AgentChatEvent =>
  ({ seq, t: 'permission', requestId, kind: 'tool', toolName: 'Bash', toolUseId: 'tu1', input: { command: 'ls' } })
const result = (seq: number, costUsd: number): AgentChatEvent =>
  ({ seq, t: 'result', costUsd, durationMs: 1, isError: false, interrupted: false, denials: 0, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } })

describe('agentChatReducer', () => {
  it('drops replayed duplicates but re-applies an old init / permission without lowering the cursor', () => {
    let s = run([init(1), { seq: 2, t: 'status', status: 'thinking' }, perm(3), { seq: 4, t: 'notice', level: 'info', text: 'hi' }])
    expect(s.lastSeq).toBe(4)
    // Reconnect: the server re-sends init + the open permission with their old seq, then replays.
    s = run([init(1, 'sess-2'), perm(3), { seq: 2, t: 'status', status: 'idle' }, { seq: 4, t: 'notice', level: 'info', text: 'hi' }], s)
    expect(s.lastSeq).toBe(4)
    expect(s.session?.sessionId).toBe('sess-2')
    expect(s.status).toBe('thinking')
    expect(s.order.filter((k) => k === 'p:r1')).toHaveLength(1)
    expect(Object.keys(s.notices)).toHaveLength(1)
  })

  it('keeps the LAST result cost instead of summing', () => {
    const s = run([result(1, 0.01), result(2, 0.03)])
    expect(s.costUsd).toBe(0.03)
    expect(s.tokens).toEqual({ input: 15, output: 7 })
  })

  it('streams deltas into a draft and replaces it with the final message', () => {
    let s = run([
      { seq: 1, t: 'delta', messageId: 'm1', kind: 'thinking', text: 'hm' },
      { seq: 2, t: 'delta', messageId: 'm1', kind: 'text', text: 'Hel' },
      { seq: 3, t: 'delta', messageId: 'm1', kind: 'text', text: 'lo' },
    ])
    expect(s.messages.m1?.draft).toEqual([{ kind: 'thinking', text: 'hm' }, { kind: 'text', text: 'Hello' }])
    s = run([{ seq: 4, t: 'message', messageId: 'm1', role: 'assistant', parts: [{ k: 'text', text: 'Hello' }] }], s)
    expect(s.messages.m1?.parts).toEqual([{ k: 'text', text: 'Hello' }])
    expect(s.messages.m1?.draft).toEqual([])
    expect(s.order).toEqual(['m:m1'])
  })

  it('updates a tool by id and names the running one', () => {
    let s = run([{ seq: 1, t: 'tool', id: 't1', name: 'Read', input: {}, state: 'running' }])
    expect(runningToolName(s)).toBe('Read')
    s = run([{ seq: 2, t: 'tool', id: 't1', name: 'Read', input: {}, state: 'done', result: 'ok' }], s)
    expect(s.tools.t1).toMatchObject({ state: 'done', result: 'ok' })
    expect(runningToolName(s)).toBeUndefined()
  })

  it('resolves a known permission and ignores an unknown one', () => {
    let s = run([perm(1)])
    expect(s.permissions.r1?.outcome).toBe('open')
    s = run([{ seq: 2, t: 'permissionResolved', requestId: 'r1', outcome: 'allow' }, { seq: 3, t: 'permissionResolved', requestId: 'zz', outcome: 'deny' }], s)
    expect(s.permissions.r1?.outcome).toBe('allow')
    expect(s.permissions.zz).toBeUndefined()
  })

  it('maps SDK modes to node modes', () => {
    expect(run([init(1, 's', 'default')]).mode).toBe('manual')
    expect(run([{ seq: 1, t: 'mode', mode: 'plan' }]).mode).toBe('plan')
    expect(nodeMode('dontAsk')).toBeUndefined()
    expect(isBusyStatus('tool')).toBe(true)
    expect(isBusyStatus('idle')).toBe(false)
  })

  it('prepends history without duplicating live messages, tools or the live user echo', () => {
    const live = run([
      { seq: 1, t: 'message', messageId: 'u-live', role: 'user', parts: [{ k: 'text', text: 'second' }] },
      { seq: 2, t: 'message', messageId: 'a2', role: 'assistant', parts: [{ k: 'text', text: 'answer 2' }] },
      { seq: 3, t: 'tool', id: 't2', name: 'Bash', input: {}, state: 'running' },
    ])
    const items: HistoryItem[] = [
      { cursor: 0, t: 'message', messageId: 'u-old', role: 'user', parts: [{ k: 'text', text: 'first' }] },
      { cursor: 1, t: 'message', messageId: 'a1', role: 'assistant', parts: [{ k: 'text', text: 'answer 1' }] },
      { cursor: 2, t: 'message', messageId: 'u-transcript', role: 'user', parts: [{ k: 'text', text: 'second' }] },
      { cursor: 3, t: 'message', messageId: 'a2', role: 'assistant', parts: [{ k: 'text', text: 'answer 2' }] },
      { cursor: 4, t: 'tool', id: 't2', name: 'Bash', input: {}, state: 'done' },
    ]
    const s = agentChatReducer(live, { type: 'history', items, next: 7 })
    expect(s.order).toEqual(['m:u-old', 'm:a1', 'm:u-live', 'm:a2'])
    expect(s.tools.t2?.state).toBe('running') // the live copy wins
    expect(s.historyNext).toBe(7)
    // The same page again adds nothing.
    expect(agentChatReducer(s, { type: 'history', items, next: null }).order).toEqual(s.order)
  })

  it('keeps two node states independent', () => {
    const a = run([init(1, 'A')], initialAgentChatState('a'))
    const b = initialAgentChatState('b')
    expect(a.session?.sessionId).toBe('A')
    expect(b.session).toBeUndefined()
  })
})
