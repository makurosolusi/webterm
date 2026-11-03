import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from './centralRuntime'
import { applyClaudeEvent, parseClaudeLine } from './claudeEvents'
import { MAX_LINE_BYTES, createLineReader } from './claudeOptions'
import { newTurnState } from './claudeSession'
import { createTurnEmitter } from './runtimeEvents'
import { assistantRecord, deltaRecord, initRecord, resultRecord } from './claude.fakeBin'

const parse = (record: unknown) => parseClaudeLine(JSON.stringify(record))

describe('parseClaudeLine', () => {
  it('parses init with the tool and MCP server count', () => {
    expect(parse(initRecord())).toEqual({ type: 'init', sessionId: 'sess-1', toolCount: 0 })
    expect(parse(initRecord({ tools: ['Bash'], mcp_servers: [{ name: 'x' }] }))).toMatchObject({ toolCount: 2 })
  })

  it('parses text deltas and ignores other stream events', () => {
    expect(parse(deltaRecord('hi'))).toEqual({ type: 'delta', text: 'hi' })
    expect(parse({ type: 'stream_event', event: { type: 'message_start' } })).toBeNull()
  })

  it('parses assistant text, tool use, error and usage', () => {
    expect(parse(assistantRecord('m1', 'abc', {}, { cache_read_input_tokens: 4 }))).toEqual({
      type: 'assistant', messageId: 'm1', text: 'abc', toolUse: false, error: null,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 0 },
    })
    const withTool = { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', name: 'Bash' }] } }
    expect(parse(withTool)).toMatchObject({ toolUse: true, text: '' })
    expect(parse(assistantRecord('m3', 'x', { error: 'rate_limit' }))).toMatchObject({ error: 'rate_limit' })
  })

  it('parses result fields and maps api_retry', () => {
    expect(parse(resultRecord())).toEqual({
      type: 'result', subtype: 'success', isError: false, sessionId: 'sess-1', costUsd: 0.00025, durationMs: 1200,
      usage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1 },
    })
    expect(parse({ type: 'system', subtype: 'api_retry' })).toEqual({ type: 'retry' })
  })

  it('returns null for junk, non-objects and unknown types', () => {
    for (const line of ['not json', '{"broken":', '42', 'null', '[]', '{"type":"mystery"}']) {
      expect(parseClaudeLine(line)).toBeNull()
    }
  })
})

describe('createLineReader', () => {
  it('joins lines split across chunks and flushes an unterminated tail on end', () => {
    const reader = createLineReader()
    expect(reader.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(reader.push(':2}\n\n{"c":3}')).toEqual(['{"b":2}'])
    expect(reader.end()).toEqual(['{"c":3}'])
  })

  it('drops an over-long line (even when it spans chunks) and resumes at the next line', () => {
    const reader = createLineReader()
    const half = 'x'.repeat(MAX_LINE_BYTES)
    expect(reader.push(half)).toEqual([])
    expect(reader.push(`${half}\nok\n`)).toEqual(['ok'])
    expect(reader.push('x'.repeat(MAX_LINE_BYTES + 1) + '\nnext\n')).toEqual(['next'])
  })
})

describe('applyClaudeEvent', () => {
  function setup(maxTurns = 4, maxTokens?: number) {
    const events: RuntimeEvent[] = []
    const emitter = createTurnEmitter({ turnId: 't', emit: (e) => events.push(e) })
    const state = newTurnState()
    const kills: number[] = []
    const ctx = { emitter, state, maxTurns, ...(maxTokens === undefined ? {} : { maxTokens }), kill: () => kills.push(1) }
    return { events, state, kills, apply: (record: unknown) => applyClaudeEvent(parse(record)!, ctx) }
  }

  it('does not duplicate text already streamed as deltas', () => {
    const { events, apply } = setup()
    apply(deltaRecord('Hel'))
    apply(deltaRecord('lo'))
    apply(assistantRecord('m1', 'Hello'))
    expect(events.map((e) => e.type === 'text.delta' && e.text)).toEqual(['Hel', 'lo'])
  })

  it('uses the full assistant text when no delta was seen', () => {
    const { events, apply } = setup()
    apply(assistantRecord('m1', 'Whole'))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'text.delta', text: 'Whole' })
  })

  it('counts a repeated message id once and keeps its latest usage', () => {
    const { state, apply } = setup()
    apply(assistantRecord('m1', 'a', {}, { output_tokens: 1 }))
    apply(assistantRecord('m1', 'a', {}, { output_tokens: 9 }))
    expect(state.messages.size).toBe(1)
    expect(state.messages.get('m1')?.outputTokens).toBe(9)
  })

  it('does not turn an assistant error into reply text', () => {
    const { events, state, kills, apply } = setup()
    apply(assistantRecord('m1', 'API Error: overloaded', { error: 'overloaded' }))
    expect(events.map((e) => e.type)).toEqual(['error'])
    expect(events[0]).toMatchObject({ code: 'runtime_error', retryable: true })
    expect(state.failure?.code).toBe('runtime_error')
    expect(kills).toHaveLength(0)
  })

  it('maps authentication_failed to runtime_unavailable with the login message', () => {
    const { events, apply } = setup()
    apply(assistantRecord('m1', 'x', { error: 'authentication_failed' }))
    expect(events[0]).toMatchObject({ type: 'error', code: 'runtime_unavailable', retryable: false })
    expect((events[0] as { message: string }).message).toContain('claude auth login')
  })

  it('emits only the first error of a turn', () => {
    const { events, apply } = setup()
    apply(assistantRecord('m1', 'x', { error: 'rate_limit' }))
    apply(assistantRecord('m2', 'x', { error: 'authentication_failed' }))
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
  })

  it('kills on more unique assistant messages than maxTurns', () => {
    const { state, kills, apply } = setup(2)
    apply(assistantRecord('a', 'x'))
    apply(assistantRecord('b', 'x'))
    expect(kills).toHaveLength(0)
    apply(assistantRecord('c', 'x'))
    expect(state.failure?.code).toBe('max_turns')
    expect(kills).toHaveLength(1)
  })

  it('kills when summed input+output tokens pass maxTokens, ignoring cache tokens', () => {
    const { state, kills, apply } = setup(10, 20)
    apply(assistantRecord('a', 'x', {}, { cache_read_input_tokens: 1_000_000 }))
    expect(kills).toHaveLength(0)
    apply(assistantRecord('b', 'x'))
    expect(state.failure?.code).toBe('budget_exhausted')
    expect(kills).toHaveLength(1)
  })

  it('fails closed on init with tools and on any tool_use', () => {
    const a = setup()
    a.apply(initRecord({ tools: ['Read'] }))
    expect(a.state.failure?.code).toBe('runtime_error')
    expect(a.kills).toHaveLength(1)
    const b = setup()
    b.apply({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', name: 'Bash' }] } })
    expect(b.state.failure?.code).toBe('unknown_tool')
    expect(b.kills).toHaveLength(1)
  })
})
