import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from './centralRuntime'
import {
  assembleText,
  createTurnEmitter,
  normalizeUsage,
} from './runtimeEvents'
import { REDACTED } from '../../redactSecrets'

function recorder(): { events: RuntimeEvent[]; emit: (event: RuntimeEvent) => void } {
  const events: RuntimeEvent[] = []
  return { events, emit: (event) => events.push(event) }
}

describe('runtime event ordering', () => {
  it('assigns monotonic per-turn seq and assembles text in order', () => {
    const { events, emit } = recorder()
    const emitter = createTurnEmitter({ turnId: 't1', emit, now: () => 1_000 })
    emitter.textDelta('Hel')
    emitter.textDelta('lo')
    emitter.emit({ type: 'usage', usage: { inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 8, durationMs: 5 } })
    const result = emitter.result('success')

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(events.every((event) => event.turnId === 't1' && event.at === 1_000)).toBe(true)
    expect(result.text).toBe('Hello')
    expect(emitter.text).toBe('Hello')
    expect(assembleText([...events].reverse())).toBe('Hello')
  })

  it('emits the terminal result exactly once and closes the emitter', () => {
    const { events, emit } = recorder()
    const emitter = createTurnEmitter({ turnId: 't1', emit })
    emitter.textDelta('partial')
    const first = emitter.result('cancelled', { errorCode: 'cancelled' })
    const second = emitter.result('success')

    expect(second).toBe(first)
    expect(events.filter((event) => event.type === 'turn.result')).toHaveLength(1)
    expect(first).toMatchObject({ outcome: 'cancelled', text: 'partial', errorCode: 'cancelled' })
    expect(emitter.closed).toBe(true)
    expect(emitter.emit({ type: 'text.delta', text: 'late' })).toBe(false)
    expect(emitter.textDelta('late')).toBe(false)
    expect(events).toHaveLength(2)
  })

  it('drops duplicate or unknown tool events', () => {
    const { events, emit } = recorder()
    const emitter = createTurnEmitter({ turnId: 't1', emit })
    expect(emitter.emit({ type: 'tool.completed', toolCallId: 'c1', name: 'portfolio.read', ok: true, durationMs: 1 })).toBe(false)
    expect(emitter.emit({ type: 'tool.requested', toolCallId: 'c1', name: 'portfolio.read', input: {} })).toBe(true)
    expect(emitter.emit({ type: 'tool.requested', toolCallId: 'c1', name: 'portfolio.read', input: {} })).toBe(false)
    expect(emitter.emit({ type: 'tool.completed', toolCallId: 'c1', name: 'portfolio.read', ok: true, output: { projects: 2 }, durationMs: 3 })).toBe(true)
    expect(emitter.emit({ type: 'tool.completed', toolCallId: 'c1', name: 'portfolio.read', ok: true, durationMs: 4 })).toBe(false)
    emitter.result('success')

    expect(events.map((event) => event.type)).toEqual(['tool.requested', 'tool.completed', 'turn.result'])
  })

  it('normalizes malformed usage numbers', () => {
    const { events, emit } = recorder()
    const emitter = createTurnEmitter({ turnId: 't1', emit })
    emitter.emit({
      type: 'usage',
      usage: { inputTokens: -3, outputTokens: Number.NaN, cacheReadTokens: 1.6, cacheWriteTokens: Infinity, costMicros: 2.4, durationMs: 9.9 },
    })
    emitter.result('success')

    const usage = events.find((event) => event.type === 'usage')
    expect(usage).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 0, costMicros: 2, durationMs: 10 },
    })
    expect(normalizeUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, durationMs: 0 })
  })

  it('marks error events non-retryable unless asked', () => {
    const { events, emit } = recorder()
    const emitter = createTurnEmitter({ turnId: 't1', emit })
    emitter.emit({ type: 'error', code: 'tool_failed', message: 'tool failed' })
    emitter.emit({ type: 'error', code: 'runtime_error', message: 'retry me', retryable: true })
    emitter.result('error', { errorCode: 'runtime_error' })

    const errors = events.filter((event) => event.type === 'error')
    expect(errors.map((event) => (event.type === 'error' ? event.retryable : null))).toEqual([false, true])
  })
})

describe('runtime event redaction', () => {
  it('redacts text and tool payloads before emitting', () => {
    const { events, emit } = recorder()
    const emitter = createTurnEmitter({ turnId: 't1', emit })
    emitter.textDelta('token=supersecretvalue')
    emitter.emit({ type: 'tool.requested', toolCallId: 'c1', name: 'portfolio.read', input: { apiKey: 'sk-abcdefghijklmnopqrstuvwx' } })
    emitter.emit({ type: 'tool.completed', toolCallId: 'c1', name: 'portfolio.read', ok: true, output: { secret: 'leak-me-now' }, durationMs: 1 })
    emitter.result('success')

    const json = JSON.stringify(events)
    expect(json).not.toContain('supersecretvalue')
    expect(json).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(json).not.toContain('leak-me-now')
    expect(json).toContain(REDACTED)
  })
})
