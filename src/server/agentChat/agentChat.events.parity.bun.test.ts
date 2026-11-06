import { describe, expect, test } from 'bun:test'
import { createAgentChatMapper } from './agentChat.events'
import { fx } from './agentChat.fakeQuery'

const types = (es: Array<{ t: string }>): string[] => es.map((e) => e.t)

describe('createAgentChatMapper: commands, compaction, reset, context, queue', () => {
  test('local_command_output becomes commandOutput and suppresses the result text of that turn', () => {
    const m = createAgentChatMapper()
    expect(m.map(fx.localOutput('u-1', 'Total cost: $0.01'))).toEqual([{ t: 'commandOutput', id: 'u-1', text: 'Total cost: $0.01' }])
    expect(types(m.map(fx.result({ text: 'Total cost: $0.01' })))).toEqual(['result', 'status'])
  })

  test('result.result becomes commandOutput only when the turn produced no assistant text', () => {
    const m = createAgentChatMapper()
    const out = m.map(fx.result({ text: 'Compacted.' }))
    expect(out[0]).toEqual({ t: 'commandOutput', id: 'r-1', text: 'Compacted.' })
    m.map(fx.reply('a-1', 'Hello'))
    expect(types(m.map(fx.result({ text: 'Hello' })))).toEqual(['result', 'status'])
    // Blank or failed results never become output.
    expect(types(m.map(fx.result({ text: '   ' })))).toEqual(['result', 'status'])
    expect(types(m.map(fx.result({ subtype: 'error_max_turns', isError: true })))).toEqual(['result', 'status'])
  })

  test('compact_boundary, commands_changed and conversation_reset map to their events', () => {
    const m = createAgentChatMapper()
    expect(m.map(fx.compact('u-c', 'auto', 150_000))).toEqual([{ t: 'compact', id: 'u-c', trigger: 'auto', preTokens: 150_000 }])
    expect(m.map(fx.compact('u-d', 'manual'))).toEqual([{ t: 'compact', id: 'u-d', trigger: 'manual' }])
    expect(m.map(fx.commandsChanged())).toEqual([{ t: 'commandsChanged' }])
    expect(m.map(fx.reset('s-2'))).toEqual([{ t: 'reset', sessionId: 's-2' }])
  })

  test('context = last top-level call input + cache + output tokens over the model context window', () => {
    const m = createAgentChatMapper()
    m.map(fx.reply('a-1', 'Hi', { model: 'opus', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90, output_tokens: 50 } }))
    const out = m.map(fx.result({ modelUsage: { opus: { contextWindow: 200_000 }, haiku: { contextWindow: 100_000 } } }))
    expect(out.find((e) => e.t === 'context')).toEqual({ t: 'context', context: { used: 1150, window: 200_000 } })
    // Unknown model key: the largest window; no usage at all: no context event.
    m.map(fx.reply('a-2', 'Hi', { model: 'other', usage: { input_tokens: 5 } }))
    expect(m.map(fx.result({ modelUsage: { opus: { contextWindow: 200_000 } } })).find((e) => e.t === 'context')).toEqual({ t: 'context', context: { used: 5, window: 200_000 } })
    expect(types(createAgentChatMapper().map(fx.result({ modelUsage: { opus: { contextWindow: 200_000 } } })))).toEqual(['result', 'status'])
  })

  test('a queued message is picked up when a reply frame stamps its uuid, before the message event', () => {
    const m = createAgentChatMapper()
    m.queue('q-1')
    m.queue('q-2')
    expect(m.map(fx.reply('a-1', 'x'))[0]?.t).toBe('message')
    const out = m.map(fx.reply('a-1', 'y', { stamps: ['q-1'], stamp: 'q-1' }))
    expect(out[0]).toEqual({ t: 'queued', messageId: 'q-1', queued: false })
    expect(out.filter((e) => e.t === 'queued')).toHaveLength(1)
    expect(m.dropQueued()).toEqual(['q-2'])
    expect(m.dropQueued()).toEqual([])
  })

  test('without stamps, the first message_start after a result picks up every queued message', () => {
    const m = createAgentChatMapper()
    m.queue('q-1')
    expect(m.map(fx.messageStart('msg-1'))).toEqual([]) // the running turn, not the queued one
    m.map(fx.result())
    expect(m.map(fx.messageStart('msg-2'))).toEqual([{ t: 'queued', messageId: 'q-1', queued: false }])
    expect(m.dropQueued()).toEqual([])
  })
})
