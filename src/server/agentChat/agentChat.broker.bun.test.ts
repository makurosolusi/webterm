import { describe, expect, test } from 'bun:test'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import { FakeQuery } from './agentChat.fakeQuery'
import { AgentChatBroker, type AgentChatPermissionRequest } from './agentChat.broker'
import { AgentChatSession } from './agentChat.session'

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))
const SUGGESTION = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'session' }

const req = (requestId: string, o: Partial<AgentChatPermissionRequest> = {}): AgentChatPermissionRequest => ({
  requestId, toolName: 'Bash', toolUseId: `tu-${requestId}`, input: { command: 'ls' }, signal: new AbortController().signal, ...o,
})

/** A real session wired to the broker; canUseTool is the one the SDK would call. */
function sessionRig() {
  const broker = new AgentChatBroker()
  let canUseTool: CanUseTool | undefined
  const s = new AgentChatSession({
    nodeId: 'n1', gate: broker, onSessionId: () => {},
    open: (_resume, cut, _abort, input) => { canUseTool = cut; return new FakeQuery(input.prompt).asQuery() },
  })
  const events: AgentChatEvent[] = []
  s.subscribe((e) => events.push(e))
  s.send('go')
  const ask = (id: string, signal = new AbortController().signal): Promise<PermissionResult | null> =>
    (canUseTool as CanUseTool)('Bash', { command: 'rm x' }, { signal, toolUseID: `tu-${id}`, requestId: id })
  const resolved = () => events.filter((e) => e.t === 'permissionResolved')
  return { broker, s, ask, resolved }
}

describe('AgentChatBroker', () => {
  test('allow echoes the request input when the answer has no updatedInput', async () => {
    const b = new AgentChatBroker()
    const p = b.request('n1', req('r1'))
    expect(b.answer('n1', { requestId: 'r1', behavior: 'allow' })).toEqual({ ok: true })
    expect(await p).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  test('allow uses the edited input; always adds the request suggestions as updatedPermissions', async () => {
    const b = new AgentChatBroker()
    const p = b.request('n1', req('r1', { suggestions: [SUGGESTION] }))
    b.answer('n1', { requestId: 'r1', behavior: 'allow', updatedInput: { command: 'ls -la' }, always: true })
    expect(await p).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' }, updatedPermissions: [SUGGESTION] } as PermissionResult)
    const q = b.request('n1', req('r2', { suggestions: [SUGGESTION] }))
    b.answer('n1', { requestId: 'r2', behavior: 'allow' })
    expect(await q).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  test('deny passes the message', async () => {
    const b = new AgentChatBroker()
    const p = b.request('n1', req('r1'))
    b.answer('n1', { requestId: 'r1', behavior: 'deny', message: 'not that' })
    expect(await p).toEqual({ behavior: 'deny', message: 'not that' })
  })

  test('an unknown, answered or other-node request id is a 409 with a reason, never a throw', async () => {
    const b = new AgentChatBroker()
    const p = b.request('n1', req('r1'))
    expect(b.answer('n2', { requestId: 'r1', behavior: 'allow' })).toMatchObject({ ok: false, status: 409 })
    const unknown = b.answer('n1', { requestId: 'nope', behavior: 'deny', message: 'x' })
    expect(unknown).toMatchObject({ ok: false, status: 409 })
    expect(unknown.ok ? '' : unknown.reason).toContain('nope')
    b.answer('n1', { requestId: 'r1', behavior: 'allow' })
    await p
    const twice = b.answer('n1', { requestId: 'r1', behavior: 'allow' })
    expect(twice).toMatchObject({ ok: false, status: 409 })
    expect(twice.ok ? '' : twice.reason).toContain('already answered')
  })

  test('pending lists the open requests per node without the signal, oldest first', () => {
    const b = new AgentChatBroker()
    void b.request('n1', req('r1'))
    void b.request('n1', req('r2'))
    void b.request('n2', req('r3'))
    expect(b.pending('n1').map((r) => r.requestId)).toEqual(['r1', 'r2'])
    expect('signal' in (b.pending('n1')[0] ?? {})).toBe(false)
    b.answer('n1', { requestId: 'r1', behavior: 'allow' })
    expect(b.pending('n1').map((r) => r.requestId)).toEqual(['r2'])
    expect(b.pending('nx')).toEqual([])
  })

  test('an SDK abort settles the request: the session records cancelled and answers deny, never null', async () => {
    const { broker, ask, resolved, s } = sessionRig()
    const ctl = new AbortController()
    const p = ask('r1', ctl.signal)
    await tick()
    expect(broker.pending('n1').map((r) => r.requestId)).toEqual(['r1'])
    ctl.abort()
    const res = await p
    expect(res).toMatchObject({ behavior: 'deny', message: expect.any(String) })
    expect(resolved()).toMatchObject([{ requestId: 'r1', outcome: 'cancelled' }])
    expect(broker.pending('n1')).toEqual([])
    expect(broker.answer('n1', { requestId: 'r1', behavior: 'allow' })).toMatchObject({ ok: false, status: 409 })
    s.close()
  })

  test('an answer through the session reaches the SDK and resolves allow', async () => {
    const { broker, ask, resolved, s } = sessionRig()
    const p = ask('r1')
    await tick()
    broker.answer('n1', { requestId: 'r1', behavior: 'allow' })
    expect(await p).toEqual({ behavior: 'allow', updatedInput: { command: 'rm x' } })
    expect(resolved()).toMatchObject([{ outcome: 'allow' }])
    s.close()
  })

  test('session close expires every pending request exactly once and empties the broker', async () => {
    const { broker, ask, resolved, s } = sessionRig()
    const p1 = ask('r1')
    const p2 = ask('r2')
    await tick()
    s.close('node removed')
    expect(await p1).toMatchObject({ behavior: 'deny' })
    expect(await p2).toMatchObject({ behavior: 'deny' })
    expect(resolved()).toMatchObject([{ requestId: 'r1', outcome: 'expired' }, { requestId: 'r2', outcome: 'expired' }])
    expect(broker.pending('n1')).toEqual([])
  })
})
