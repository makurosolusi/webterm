import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent, TurnInput } from './centralRuntime'
import { MockRuntime, MOCK_TOOL_NAME, type MockToolRequest } from './mockRuntime'
import { REDACTED } from './runtimeEvents'

function input(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    conversationId: 'central:global',
    turnId: 't1',
    text: 'hello',
    history: [],
    tools: [],
    limits: {},
    ...overrides,
  }
}

function recorder(): { events: RuntimeEvent[]; emit: (event: RuntimeEvent) => void } {
  const events: RuntimeEvent[] = []
  return { events, emit: (event) => events.push(event) }
}

function types(events: RuntimeEvent[]): string[] {
  return events.map((event) => event.type)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('mock runtime success', () => {
  it('streams deterministic text deltas and reports usage', async () => {
    const { events, emit } = recorder()
    const runtime = new MockRuntime({ chunks: ['Hel', 'lo'], stepDelayMs: 0 })
    const result = await runtime.turn(input(), emit)

    expect(result.outcome).toBe('success')
    expect(result.text).toBe('Hello')
    expect(types(events)).toEqual(['text.delta', 'text.delta', 'usage', 'turn.result'])
    expect(events.filter((event) => event.type === 'turn.result')).toHaveLength(1)
    const final = events.at(-1)
    expect(final).toMatchObject({ type: 'turn.result', outcome: 'success', text: 'Hello' })
    expect(result.usage.outputTokens).toBe(2)
    expect(result.usage.inputTokens).toBe(2)
    expect(result.usage.costMicros).toBe(8)
    expect(result.sessionRef).toBe('mock:central:global')
  })

  it('is deterministic across runs', async () => {
    const first: RuntimeEvent[] = []
    const second: RuntimeEvent[] = []
    const runtime = new MockRuntime({ chunks: ['same'], stepDelayMs: 0, now: () => 42 })
    await runtime.turn(input(), (event) => first.push(event))
    await runtime.turn(input(), (event) => second.push(event))

    expect(first).toEqual(second)
    expect(first.map((event) => event.at)).toEqual([42, 42, 42])
  })

  it('calls the injected read-only tool once and emits tool events once', async () => {
    const { events, emit } = recorder()
    const calls: MockToolRequest[] = []
    const runtime = new MockRuntime({
      chunks: ['Checking. '],
      stepDelayMs: 0,
      toolInput: { scope: 'global' },
      toolExecutor: (request) => {
        calls.push(request)
        return { ok: true, output: { projects: 2 } }
      },
    })
    const result = await runtime.turn(input({ tools: [MOCK_TOOL_NAME] }), emit)

    expect(result.outcome).toBe('success')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ turnId: 't1', conversationId: 'central:global', name: MOCK_TOOL_NAME, input: { scope: 'global' } })
    expect(types(events)).toEqual(['text.delta', 'tool.requested', 'tool.completed', 'usage', 'turn.result'])
    expect(events.find((event) => event.type === 'tool.completed')).toMatchObject({ ok: true, output: { projects: 2 } })
  })

  it('does not call a tool outside the allowlist', async () => {
    const { events, emit } = recorder()
    let called = false
    const runtime = new MockRuntime({ chunks: ['ok'], stepDelayMs: 0, toolExecutor: () => { called = true; return { ok: true } } })
    await runtime.turn(input({ tools: [] }), emit)

    expect(called).toBe(false)
    expect(types(events)).toEqual(['text.delta', 'usage', 'turn.result'])
  })

  it('treats a failing tool as a turn error with one error event', async () => {
    const { events, emit } = recorder()
    const runtime = new MockRuntime({
      chunks: ['before '],
      stepDelayMs: 0,
      toolExecutor: () => ({ ok: false, errorCode: 'unavailable' }),
    })
    const result = await runtime.turn(input({ tools: [MOCK_TOOL_NAME] }), emit)

    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('tool_failed')
    expect(types(events).filter((type) => type === 'tool.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.result')).toHaveLength(1)
  })

  it('redacts a tool error message returned by a throwing executor', async () => {
    const { events, emit } = recorder()
    const runtime = new MockRuntime({
      chunks: [],
      stepDelayMs: 0,
      toolExecutor: () => {
        throw new Error('boom sk-abcdefghijklmnopqrstuvwx')
      },
    })
    await runtime.turn(input({ tools: [MOCK_TOOL_NAME] }), emit)

    const completed = events.find((event) => event.type === 'tool.completed')
    expect(JSON.stringify(completed)).toContain(REDACTED)
    expect(JSON.stringify(events)).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })
})

describe('mock runtime failure modes', () => {
  it('fails deterministically in error mode', async () => {
    const { events, emit } = recorder()
    const runtime = new MockRuntime({ mode: 'error', chunks: ['a', 'b'], stepDelayMs: 0 })
    const result = await runtime.turn(input(), emit)

    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_error')
    expect(result.text).toBe('ab')
    expect(types(events)).toEqual(['text.delta', 'text.delta', 'error', 'usage', 'turn.result'])
    expect(events.find((event) => event.type === 'error')).toMatchObject({ code: 'runtime_error', retryable: true })
  })

  it('self-cancels after the first delta in cancel mode', async () => {
    const { events, emit } = recorder()
    const runtime = new MockRuntime({ mode: 'cancel', chunks: ['a', 'b'], stepDelayMs: 0 })
    const result = await runtime.turn(input(), emit)

    expect(result.outcome).toBe('cancelled')
    expect(result.errorCode).toBe('cancelled')
    expect(result.text).toBe('a')
    expect(types(events)).toEqual(['text.delta', 'usage', 'turn.result'])
  })

  it('fails before emitting when maxTurns is exhausted', async () => {
    const { events, emit } = recorder()
    const runtime = new MockRuntime({ chunks: ['a'], stepDelayMs: 0 })
    const result = await runtime.turn(input({ limits: { maxTurns: 0 } }), emit)

    expect(result.errorCode).toBe('max_turns')
    expect(types(events)).toEqual(['error', 'usage', 'turn.result'])
  })

  it('fails before emitting when the budget is already exhausted', async () => {
    const { events, emit } = recorder()
    const runtime = new MockRuntime({ chunks: ['a'], stepDelayMs: 0 })
    const result = await runtime.turn(input({ limits: { maxCostMicros: 0 } }), emit)

    expect(result.errorCode).toBe('budget_exhausted')
    expect(types(events)).toEqual(['error', 'usage', 'turn.result'])
  })

  it('fails with timeout when the wall clock is past the deadline', async () => {
    let calls = 0
    const now = (): number => (++calls === 1 ? 0 : 100)
    const { events, emit } = recorder()
    const runtime = new MockRuntime({ chunks: ['a'], stepDelayMs: 0, now })
    const result = await runtime.turn(input({ limits: { maxWallMs: 50 } }), emit)

    expect(result.errorCode).toBe('timeout')
    expect(types(events)).toEqual(['error', 'usage', 'turn.result'])
  })
})

describe('mock runtime cancellation', () => {
  it('cancels mid-stream promptly with a fake clock and keeps partial text', async () => {
    vi.useFakeTimers()
    const { events, emit } = recorder()
    const runtime = new MockRuntime({ chunks: ['one', 'two', 'three'], stepDelayMs: 1_000 })
    const pending = runtime.turn(input(), emit)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(types(events)).toEqual(['text.delta'])

    const started = Date.now()
    expect(runtime.cancel('t1')).toBe(true)
    const result = await pending

    expect(Date.now() - started).toBeLessThan(100)
    expect(result.outcome).toBe('cancelled')
    expect(result.text).toBe('one')
    expect(types(events)).toEqual(['text.delta', 'usage', 'turn.result'])
    expect(runtime.cancel('t1')).toBe(false)
  })

  it('cancels while a tool is running and closes the tool card', async () => {
    const { events, emit } = recorder()
    let started!: () => void
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const runtime = new MockRuntime({
      chunks: [],
      stepDelayMs: 0,
      toolExecutor: (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ ok: false, errorCode: 'cancelled' }), { once: true })
          started()
        }),
    })
    const pending = runtime.turn(input({ tools: [MOCK_TOOL_NAME] }), emit)
    await toolStarted
    runtime.cancel('t1', 'user_stop')
    const result = await pending

    expect(result.outcome).toBe('cancelled')
    expect(types(events)).toEqual(['tool.requested', 'tool.completed', 'usage', 'turn.result'])
    expect(events.find((event) => event.type === 'tool.completed')).toMatchObject({ ok: false, errorCode: 'cancelled' })
  })

  it('honors an upstream AbortSignal and close()', async () => {
    const controller = new AbortController()
    controller.abort('upstream')
    const first = await new MockRuntime({ chunks: ['a'], stepDelayMs: 0 }).turn(input(), () => {}, controller.signal)
    expect(first.outcome).toBe('cancelled')

    const runtime = new MockRuntime({ chunks: ['a', 'b'], stepDelayMs: 1_000 })
    const pending = runtime.turn(input({ turnId: 't2' }), () => {})
    await runtime.close()
    const second = await pending
    expect(second.outcome).toBe('cancelled')
  })
})
