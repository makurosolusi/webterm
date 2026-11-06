import { describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import type { AgentChatOpenInput } from './agentChat.options'
import { FakeQuery, fx } from './agentChat.fakeQuery'
import { AGENT_CHAT_EVENT_LOG_MAX, AgentChatSession, type PermissionGate } from './agentChat.session'

interface Opened { resume?: string; canUseTool: CanUseTool; abort: AbortController; input: AgentChatOpenInput; fq: FakeQuery }

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

function setup(o: { gate?: PermissionGate['request']; idleMs?: number; onOpen?: (x: Opened) => void } = {}) {
  const opens: Opened[] = []
  const sessionIds: string[] = []
  const events: AgentChatEvent[] = []
  const s = new AgentChatSession({
    nodeId: 'node-1',
    open: (resume, canUseTool, abort, input) => {
      const x = { resume, canUseTool, abort, input, fq: new FakeQuery(input.prompt) }
      opens.push(x)
      o.onOpen?.(x)
      return x.fq.asQuery()
    },
    gate: { request: o.gate ?? (async () => ({ behavior: 'allow' })) },
    onSessionId: (id) => sessionIds.push(id),
    ...(o.idleMs ? { idleMs: o.idleMs } : {}),
  })
  s.subscribe((e) => events.push(e))
  const of = <T extends AgentChatEvent['t']>(t: T) => events.filter((e): e is Extract<AgentChatEvent, { t: T }> => e.t === t)
  return { s, opens, sessionIds, events, of }
}

const ask = (x: Opened, toolName: string, input: Record<string, unknown>, signal = new AbortController().signal) =>
  x.canUseTool(toolName, input, { signal, toolUseID: `tu-${toolName}`, requestId: `req-${toolName}` })

describe('AgentChatSession', () => {
  test('opens the Query lazily on the first send and persists the first session id once', async () => {
    const { s, opens, sessionIds, of } = setup()
    expect(opens).toHaveLength(0)
    s.send('hello')
    expect(opens).toHaveLength(1)
    expect(opens[0]?.resume).toBe(undefined)
    expect(s.status()).toBe('starting')
    expect(s.busy()).toBe(true)
    expect(of('message')[0]).toMatchObject({ role: 'user', parts: [{ k: 'text', text: 'hello' }] })
    const fq = opens[0]?.fq as FakeQuery
    fq.emit(fx.init('s-1'), fx.init('s-1'))
    await tick()
    expect(fq.prompts).toEqual([{ type: 'user', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null }])
    expect(sessionIds).toEqual(['s-1'])
    fq.emit(fx.result())
    await tick()
    expect(s.busy()).toBe(false)
    expect(s.status()).toBe('idle')
  })

  test('sends while a turn runs are queued as next, in order, on the same Query', async () => {
    const { s, opens } = setup()
    s.send('a')
    s.send('b')
    s.send('c', 'now')
    await tick()
    expect(opens).toHaveLength(1)
    expect(opens[0]?.fq.prompts.map((p) => [p.message.content, p.priority])).toEqual([['a', undefined], ['b', 'next'], ['c', 'now']])
  })

  test('permission allow echoes the input when the gate omits updatedInput', async () => {
    const seen: string[] = []
    const { s, opens, of } = setup({ gate: async (nodeId, req) => { seen.push(`${nodeId}:${req.requestId}`); return { behavior: 'allow' } } })
    s.send('go')
    const res = await ask(opens[0] as Opened, 'Bash', { command: 'rm x' })
    expect(res).toEqual({ behavior: 'allow', updatedInput: { command: 'rm x' } })
    expect(seen).toEqual(['node-1:req-Bash'])
    expect(of('permission')[0]).toMatchObject({ requestId: 'req-Bash', kind: 'tool', toolName: 'Bash', toolUseId: 'tu-Bash', input: { command: 'rm x' } })
    expect(of('permissionResolved')).toMatchObject([{ requestId: 'req-Bash', outcome: 'allow' }])
    expect(of('status').map((e) => e.status)).toEqual(['starting', 'awaiting', 'tool'])
  })

  test('question and plan prompts get their own kind', async () => {
    const { s, opens, of } = setup()
    s.send('go')
    await ask(opens[0] as Opened, 'AskUserQuestion', {})
    await ask(opens[0] as Opened, 'ExitPlanMode', {})
    expect(of('permission').map((e) => e.kind)).toEqual(['question', 'plan'])
  })

  test('a gate deny is passed through and the tool card renders denied', async () => {
    const { s, opens, of } = setup({ gate: async (): Promise<PermissionResult> => ({ behavior: 'deny', message: 'no' }) })
    s.send('go')
    const x = opens[0] as Opened
    expect(await ask(x, 'Write', { file_path: '/x' })).toEqual({ behavior: 'deny', message: 'no' })
    x.fq.emit(fx.assistant('m1', [{ type: 'tool_use', id: 'tu-Write', name: 'Write', input: {} }]), fx.toolResult('tu-Write', 'denied', true))
    await tick()
    expect(of('permissionResolved')[0]?.outcome).toBe('deny')
    expect(of('tool').at(-1)?.state).toBe('denied')
  })

  test('an aborted request resolves as cancelled with a deny, never null', async () => {
    const { s, opens, of } = setup({ gate: () => new Promise(() => {}) })
    s.send('go')
    const ctl = new AbortController()
    const pending = ask(opens[0] as Opened, 'Bash', {}, ctl.signal)
    ctl.abort()
    expect(await pending).toMatchObject({ behavior: 'deny' })
    expect(of('permissionResolved')[0]?.outcome).toBe('cancelled')
  })

  test('close expires pending permissions, aborts the Query and reports closed', async () => {
    const { s, opens, of } = setup({ gate: () => new Promise(() => {}) })
    s.send('go')
    const x = opens[0] as Opened
    const pending = ask(x, 'Bash', {})
    await tick()
    s.close('node deleted')
    expect(await pending).toMatchObject({ behavior: 'deny' })
    expect(of('permissionResolved')).toMatchObject([{ outcome: 'expired' }])
    expect(of('permissionResolved')).toHaveLength(1)
    expect(x.abort.signal.aborted).toBe(true)
    expect(x.fq.closed).toBe(true)
    expect(s.status()).toBe('closed')
    expect(of('status').at(-1)).toMatchObject({ status: 'closed', detail: 'node deleted' })
    let thrown = ''
    try {
      s.send('again')
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err)
    }
    expect(thrown).toMatch(/node-1 is closed/)
  })

  test('close leaves no child process behind', async () => {
    let child: ChildProcess | undefined
    const { s } = setup({ onOpen: (x) => { child = spawn('sleep', ['30'], { stdio: 'ignore', signal: x.abort.signal }) } })
    s.send('go')
    const exited = new Promise<string | null>((r) => child?.once('exit', (_c, sig) => r(sig)))
    const errors: string[] = []
    child?.once('error', (e) => errors.push(e.name))
    s.close()
    expect(await exited).toBe('SIGTERM')
    expect(errors).toEqual(['AbortError'])
    expect(child?.exitCode === null && child?.signalCode === 'SIGTERM').toBe(true)
  })

  test('an idle Query closes with status idle and the next send resumes the session', async () => {
    const { s, opens } = setup({ idleMs: 20 })
    s.send('one')
    const first = opens[0] as Opened
    first.fq.emit(fx.init('s-1'), fx.result())
    await tick(60)
    expect(first.fq.closed).toBe(true)
    expect(s.status()).toBe('idle')
    s.send('two')
    expect(opens).toHaveLength(2)
    expect(opens[1]?.resume).toBe('s-1')
  })

  test('an iterator error reports status error with context, then the next send reopens with resume', async () => {
    const { s, opens, of } = setup()
    s.send('one')
    const first = opens[0] as Opened
    first.input.stderr('child said: overloaded\n')
    first.fq.emit(fx.init('s-1'))
    await tick()
    first.fq.fail(new Error('process exited with code 1'))
    await tick()
    expect(s.status()).toBe('error')
    const notice = of('notice').at(-1)
    expect(notice?.level).toBe('error')
    expect(notice?.text).toContain('node-1')
    expect(notice?.text).toContain('process exited with code 1')
    expect(notice?.text).toContain('child said: overloaded')
    s.send('two')
    expect(opens).toHaveLength(2)
    expect(opens[1]?.resume).toBe('s-1')
  })

  test('the opener notice reaches the log as a warning', () => {
    const { s, of } = setup({ onOpen: (x) => x.input.notice('Profile "Gone" was removed; using Default.') })
    s.send('go')
    expect(of('notice')[0]?.level).toBe('warn')
    expect(of('notice')[0]?.text).toContain('Gone')
  })

  test('interrupt ends the turn as interrupted, not error', async () => {
    const { s, opens } = setup()
    s.send('long job')
    const x = opens[0] as Opened
    x.fq.emit(fx.init('s-1'))
    await tick()
    await s.interrupt()
    expect(x.fq.interrupts).toBe(1)
    x.fq.emit(fx.result({ subtype: 'error_during_execution', isError: true }))
    await tick()
    expect(s.status()).toBe('interrupted')
  })

  test('setMode maps manual, reaches an open Query and the next open', async () => {
    const { s, opens, of } = setup()
    await s.setMode('manual')
    expect(of('mode')).toMatchObject([{ mode: 'default' }])
    s.send('go')
    expect(opens[0]?.input.mode).toBe('manual')
    await s.setMode('plan')
    expect(opens[0]?.fq.modes).toEqual(['plan'])
  })

  test('the event log has monotonic seq from 1, is capped, and replays after a seq', async () => {
    const { s, opens } = setup()
    s.send('go')
    expect(s.events(0)[0]?.seq).toBe(1)
    const fq = opens[0]?.fq as FakeQuery
    fq.emit(fx.messageStart('m1'), ...Array.from({ length: AGENT_CHAT_EVENT_LOG_MAX + 50 }, (_, n) => fx.textDelta(`t${n}`)))
    await tick()
    const all = s.events(0)
    expect(all).toHaveLength(AGENT_CHAT_EVENT_LOG_MAX)
    expect(all[0]?.seq).toBeGreaterThan(1)
    expect(all.every((e, n) => n === 0 || e.seq === (all[n - 1]?.seq ?? 0) + 1)).toBe(true)
    const last = all.at(-1)?.seq ?? 0
    expect(s.events(last - 3).map((e) => e.seq)).toEqual([last - 2, last - 1, last])
  })
})
