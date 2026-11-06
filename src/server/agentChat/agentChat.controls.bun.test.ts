import { describe, expect, test } from 'bun:test'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import { configOptions, mergeConfig, parseConfigPatch, sessionSummaries, toCommand, toModel, withTimeout } from './agentChat.controls'
import { FakeQuery, fx } from './agentChat.fakeQuery'
import type { AgentChatOpenInput } from './agentChat.options'
import { AgentChatSession } from './agentChat.session'

/** Message of what `p` rejects with ('' if it resolves). */
const rejection = (p: Promise<unknown>): Promise<string> => p.then(() => '', (err: unknown) => (err instanceof Error ? err.message : String(err)))

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

function setup(idleMs?: number) {
  const opens: Array<{ resume?: string; input: AgentChatOpenInput; fq: FakeQuery }> = []
  const sessionIds: string[] = []
  const events: AgentChatEvent[] = []
  const s = new AgentChatSession({
    nodeId: 'node-1',
    open: (resume, _canUseTool, _abort, input) => { const fq = new FakeQuery(input.prompt); opens.push({ resume, input, fq }); return fq.asQuery() },
    gate: { request: async () => ({ behavior: 'allow' }) },
    onSessionId: (id) => sessionIds.push(id),
    ...(idleMs ? { idleMs } : {}),
  }, 's-0')
  s.subscribe((e) => events.push(e))
  const of = <T extends AgentChatEvent['t']>(t: T) => events.filter((e): e is Extract<AgentChatEvent, { t: T }> => e.t === t)
  return { s, opens, sessionIds, events, of }
}

describe('agent chat controls: pure mapping', () => {
  test('SDK commands and models map to the wire shapes', () => {
    expect(toCommand({ name: 'deploy', description: 'Ship', argumentHint: '<env>', aliases: ['ship'] })).toEqual({ name: 'deploy', description: 'Ship', argumentHint: '<env>', aliases: ['ship'], builtin: false })
    expect(toCommand({ name: 'clear', description: 'Clear', argumentHint: '', builtin: true })).toEqual({ name: 'clear', description: 'Clear', builtin: true })
    expect(toModel({ value: 'opus', displayName: 'Opus', description: 'Best', supportsEffort: true, supportedEffortLevels: ['low', 'max'] })).toEqual({ value: 'opus', displayName: 'Opus', description: 'Best', efforts: ['low', 'max'] })
    expect(toModel({ value: 'haiku', displayName: '', description: '', supportsEffort: false, supportedEffortLevels: ['low'] })).toEqual({ value: 'haiku', displayName: 'haiku' })
  })

  test('config patches parse, merge (null = default) and become query options', () => {
    expect(parseConfigPatch({ model: 'opus', effort: 'high', thinking: false })).toEqual({ patch: { model: 'opus', effort: 'high', thinking: false } })
    expect(parseConfigPatch({ model: null, effort: '' })).toEqual({ patch: { model: null, effort: null } })
    expect('reason' in parseConfigPatch({ effort: 'extreme' })).toBe(true)
    expect('reason' in parseConfigPatch({ thinking: 'yes' })).toBe(true)
    expect('reason' in parseConfigPatch({ model: 7 })).toBe(true)
    expect('reason' in parseConfigPatch({})).toBe(true)
    const c = mergeConfig({ thinking: true }, { model: 'opus', effort: 'high' })
    expect(c).toEqual({ model: 'opus', effort: 'high', thinking: true })
    expect(mergeConfig(c, { model: null, thinking: false })).toEqual({ effort: 'high', thinking: false })
    expect(configOptions({ thinking: true })).toEqual({})
    expect(configOptions({ model: 'opus', effort: 'low', thinking: false })).toEqual({ model: 'opus', effort: 'low', thinking: { type: 'disabled' } })
  })

  test('session summaries: newest first, title fallbacks, current marked', () => {
    const out = sessionSummaries([
      { sessionId: 'a', summary: 'Old', lastModified: 1 },
      { sessionId: 'b', summary: '', firstPrompt: 'fix the bug', customTitle: 'Bug hunt', lastModified: 3 },
      { sessionId: 'c', summary: '', lastModified: 2 },
    ], 'a')
    expect(out).toEqual([
      { sessionId: 'b', title: 'Bug hunt', updatedAt: 3, current: false },
      { sessionId: 'c', title: 'Untitled conversation', updatedAt: 2, current: false },
      { sessionId: 'a', title: 'Old', updatedAt: 1, current: true },
    ])
  })

  test('withTimeout rejects with the operation named', async () => {
    expect(await rejection(withTimeout(new Promise(() => {}), 10, 'Claude'))).toBe('Claude did not answer within 0s')
    expect(await withTimeout(Promise.resolve(4), 10, 'x')).toBe(4)
  })
})

describe('AgentChatSession controls', () => {
  test('config set before the Query opens is passed as open options, and re-emitted after init', async () => {
    const { s, opens, of } = setup()
    await s.setConfig({ model: 'opus', thinking: false })
    expect(of('config').at(-1)?.config).toEqual({ model: 'opus', thinking: false })
    s.send('hi')
    expect(opens[0]?.input.config).toEqual({ model: 'opus', thinking: false })
    expect(opens[0]?.fq.controls).toEqual([]) // nothing applied live
    opens[0]?.fq.emit(fx.init('s-0'))
    await tick()
    const last = of('config').at(-1) as AgentChatEvent
    expect(last.seq).toBeGreaterThan(of('init')[0]?.seq as number)
  })

  test('config on an open Query is applied live, only the changed fields', async () => {
    const { s, opens, of } = setup()
    s.send('hi')
    const fq = opens[0]?.fq as FakeQuery
    await s.setConfig({ model: 'opus', effort: 'high' })
    await s.setConfig({ thinking: false })
    await s.setConfig({ effort: null, thinking: true })
    expect(fq.controls).toEqual(['setModel:opus', 'effort:high', 'thinking:0', 'effort:default', 'thinking:default'])
    expect(of('config').at(-1)?.config).toEqual({ model: 'opus', thinking: true })
  })

  test('a failing live control rejects with context and leaves the config unchanged', async () => {
    const { s, opens, of } = setup()
    s.send('hi')
    ;(opens[0]?.fq as FakeQuery).controlError = new Error('unknown model')
    expect(await rejection(s.setConfig({ model: 'nope' }))).toBe('Setting the model to nope failed: unknown model')
    expect(of('config')).toHaveLength(0)
  })

  test('a send while a turn runs is queued, then picked up when Claude stamps it', async () => {
    const { s, opens, of } = setup()
    s.send('first')
    const fq = opens[0]?.fq as FakeQuery
    s.send('second')
    const second = of('message')[1]?.messageId as string
    expect(of('queued')).toHaveLength(1)
    expect(of('queued')[0]).toMatchObject({ messageId: second, queued: true })
    fq.emit(fx.reply('a-1', 'ok', { stamp: second }))
    await tick()
    expect(of('queued').at(-1)).toMatchObject({ messageId: second, queued: false })
  })

  test('an idle send is never queued; queued messages are released when the Query closes', async () => {
    const { s, of } = setup()
    s.send('first')
    expect(of('queued')).toHaveLength(0)
    s.send('second')
    s.close('test')
    expect(of('queued').map((e) => e.queued)).toEqual([true, false])
  })

  test('warm opens a turnless Query for control requests and closes it on idle', async () => {
    const { s, opens } = setup(30)
    s.warm()
    expect(opens).toHaveLength(1)
    expect(opens[0]?.resume).toBe('s-0')
    expect(s.busy()).toBe(false)
    expect((await s.control((q) => q.supportedCommands())).map((c) => c.name)).toEqual(['compact', 'deploy'])
    s.warm() // already open: no second Query
    expect(opens).toHaveLength(1)
    await tick(60)
    expect(opens[0]?.fq.closed).toBe(true)
    expect(await rejection(s.control((q) => q.supportedModels()))).toContain('no open Query')
  })

  test('switchTo closes the Query, emits reset and resumes the new id on the next send', async () => {
    const { s, opens, of } = setup()
    s.send('hi')
    expect(await rejection((async () => s.switchTo('s-9'))())).toContain('running a turn')
    opens[0]?.fq.emit(fx.result())
    await tick()
    s.switchTo('s-9')
    expect(opens[0]?.fq.closed).toBe(true)
    expect(of('reset').at(-1)).toMatchObject({ sessionId: 's-9' })
    s.send('again')
    expect(opens[1]?.resume).toBe('s-9')
    opens[1]?.fq.emit(fx.result())
    await tick()
    s.switchTo(undefined)
    expect(of('reset').at(-1)).toMatchObject({ sessionId: '' })
    s.send('fresh')
    expect(opens[2]?.resume).toBe(undefined)
  })

  test('an SDK conversation_reset (/clear) makes the node follow the new session id', async () => {
    const { s, opens, of, sessionIds } = setup()
    s.send('/clear')
    opens[0]?.fq.emit(fx.reset('s-new'))
    await tick()
    expect(of('reset')).toHaveLength(1)
    expect(of('reset')[0]).toMatchObject({ sessionId: 's-new' })
    expect(sessionIds).toEqual(['s-new'])
  })
})
