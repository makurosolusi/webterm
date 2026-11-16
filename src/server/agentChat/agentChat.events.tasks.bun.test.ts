import { describe, expect, test } from 'bun:test'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import { processRateLimit, rateLimitResetAt } from '../central/work/workRateLimit'
import { createAgentChatMapper } from './agentChat.events'
import { FakeQuery, fx } from './agentChat.fakeQuery'
import { AgentChatSession } from './agentChat.session'

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('mapper: replayed user messages, rate limits, tasks', () => {
  test('a replayed user message (replay-user-messages) maps to nothing', () => {
    expect(createAgentChatMapper().map(fx.replay('u-1', 'hello'))).toEqual([])
  })

  test('rate_limit_event feeds the work-layer hold with ms (from seconds or ms) and holds until the reset', () => {
    const noted: { status: string; resetsAt?: number }[] = []
    const original = processRateLimit.note
    processRateLimit.note = (i) => { noted.push(i) }
    try {
      const m = createAgentChatMapper()
      m.map(fx.rateLimit('rejected', 1_800_000_000))
      m.map(fx.rateLimit('allowed_warning', 1_800_000_000_000, 'seven_day'))
      m.map(fx.rateLimit('bogus'))
      expect(noted).toEqual([{ status: 'rejected', resetsAt: 1_800_000_000_000 }, { status: 'allowed_warning', resetsAt: 1_800_000_000_000 }])
    } finally { processRateLimit.note = original }
    // Real hold: a rejection resetting in 5 s (given in seconds) is pending now, gone after the reset. test-only short horizon
    const now = Date.now()
    createAgentChatMapper().map(fx.rateLimit('rejected', Math.floor((now + 5_000) / 1_000) + 1))
    const at = rateLimitResetAt(now)
    expect(at).not.toBeNull()
    expect(rateLimitResetAt(at! + 1)).toBeNull()
  })

  test('rate_limit_event: seconds become ms, an unchanged state is dropped, allowed passes through', () => {
    const m = createAgentChatMapper()
    expect(m.map(fx.rateLimit('rejected', 1_800_000_000))).toEqual([{ t: 'rateLimit', status: 'rejected', resetsAt: 1_800_000_000_000, limit: 'five_hour' }])
    expect(m.map(fx.rateLimit('rejected', 1_800_000_000))).toEqual([])
    expect(m.map(fx.rateLimit('allowed_warning', 1_800_000_000_000, 'seven_day'))).toEqual([{ t: 'rateLimit', status: 'allowed_warning', resetsAt: 1_800_000_000_000, limit: 'seven_day' }])
    expect(m.map(fx.rateLimit('allowed'))).toEqual([{ t: 'rateLimit', status: 'allowed', limit: 'five_hour' }])
    expect(m.map(fx.rateLimit('bogus'))).toEqual([])
  })

  test('task_started / progress / updated / notification build one task; ambient tasks are hidden', () => {
    const m = createAgentChatMapper()
    expect(m.map(fx.task('task_started', 't1', { description: 'Explore auth', tool_use_id: 'tu-1' }))).toEqual([
      { t: 'task', task: { id: 't1', status: 'running', description: 'Explore auth', toolUseId: 'tu-1' } },
    ])
    expect(m.map(fx.task('task_progress', 't1', { description: 'Explore auth', summary: 'Reading login.ts', last_tool_name: 'Read', usage: {} }))).toEqual([
      { t: 'task', task: { id: 't1', status: 'running', description: 'Explore auth', toolUseId: 'tu-1', summary: 'Reading login.ts', lastTool: 'Read' } },
    ])
    expect(m.map(fx.task('task_updated', 't1', { patch: { status: 'killed' } }))[0]).toMatchObject({ task: { id: 't1', status: 'stopped' } })
    expect(m.map(fx.task('task_notification', 't1', { status: 'completed', summary: 'Done', output_file: '' }))[0]).toMatchObject({ task: { status: 'completed', summary: 'Done' } })
    // Housekeeping tasks never reach the list, whatever frames follow.
    expect(m.map(fx.task('task_started', 't2', { description: 'watch', ambient: true }))).toEqual([])
    expect(m.map(fx.task('task_progress', 't2', { description: 'watch', usage: {} }))).toEqual([])
    // A reset forgets the tasks: a late progress frame starts a fresh entry.
    m.map(fx.reset('s-2'))
    expect(m.map(fx.task('task_progress', 't1', { description: 'Again', usage: {} }))).toEqual([{ t: 'task', task: { id: 't1', status: 'running', description: 'Again' } }])
  })
})

describe('session: replay and rate-limit frames', () => {
  function setup() {
    const opens: FakeQuery[] = []
    const events: AgentChatEvent[] = []
    const s = new AgentChatSession({
      nodeId: 'n-1', gate: { request: async () => ({ behavior: 'allow' }) }, onSessionId: () => {},
      open: (_r, _c, _a, input) => { const fq = new FakeQuery(input.prompt); opens.push(fq); return fq.asQuery() },
    })
    s.subscribe((e) => events.push(e))
    return { s, opens, events }
  }

  test('the replay of a sent message does not add a second user message to the timeline', async () => {
    const { s, opens, events } = setup()
    s.send('hello')
    const id = events.find((e): e is Extract<AgentChatEvent, { t: 'message' }> => e.t === 'message')?.messageId ?? ''
    opens[0]?.emit(fx.init(), fx.replay(id, 'hello'), fx.reply('a-1', 'Hi'), fx.result())
    await tick()
    const users = events.filter((e) => e.t === 'message' && e.role === 'user')
    expect(users).toHaveLength(1)
    expect(s.busy()).toBe(false)
  })

  test('a replay or rate-limit frame after the result does not mark the chat busy', async () => {
    const { s, opens } = setup()
    s.send('hello')
    opens[0]?.emit(fx.init(), fx.result(), fx.replay('late', 'x'), fx.rateLimit('allowed_warning', 1_800_000_000))
    await tick()
    expect(s.busy()).toBe(false)
  })
})
