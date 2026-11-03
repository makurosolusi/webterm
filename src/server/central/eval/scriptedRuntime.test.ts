import { describe, expect, it } from 'vitest'
import type { RuntimeEvent, TurnInput, TurnLimits } from '../runtime/centralRuntime'
import {
  createVirtualClock, opencodeRecording, ScriptedRuntime, type RecordedStep, type ScriptedTurn,
} from './scriptedRuntime'

const START = 1_000 // test-only

function input(limits: TurnLimits & { maxTokens?: number } = {}): TurnInput {
  return { conversationId: 'c1', turnId: 't1', text: 'hi', history: [], tools: [], limits }
}

async function play(steps: RecordedStep[], limits?: TurnLimits & { maxTokens?: number }, extra: Partial<ScriptedTurn> = {}, lineMs?: number) {
  const clock = createVirtualClock(START)
  const runtime = new ScriptedRuntime({ turns: [{ jsonl: opencodeRecording(steps), ...extra }], clock, ...(lineMs === undefined ? {} : { lineMs }) })
  const events: RuntimeEvent[] = []
  const result = await runtime.turn(input(limits), (event) => events.push(event))
  return { result, events, clock, runtime }
}

const ROUND: RecordedStep[] = [
  { kind: 'step' }, { kind: 'text', text: 'hello ' }, { kind: 'text', text: 'world' },
  { kind: 'tool', name: 'portfolio.read', input: { a: 1 }, output: 'ok' },
  { kind: 'usage', input: 100, output: 20, cacheRead: 300, costMicros: 50 },
]

describe('opencodeRecording', () => {
  it('renders valid JSONL records in the opencode shape', () => {
    const lines = opencodeRecording(ROUND)
    expect(lines).toHaveLength(ROUND.length)
    const types = lines.map((line) => (JSON.parse(line) as { type: string }).type)
    expect(types).toEqual(['step_start', 'text', 'text', 'tool_use', 'step_finish'])
  })
})

describe('ScriptedRuntime', () => {
  it('replays text, tool and usage through the real parser and ends in success', async () => {
    const { result, events, runtime } = await play(ROUND)
    expect(result.outcome).toBe('success')
    expect(result.text).toBe('hello world')
    expect(result.sessionRef).toBe('ses_scripted')
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, costMicros: 50 })
    expect(events.filter((e) => e.type === 'tool.requested')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'turn.result')).toHaveLength(1)
    expect(runtime.calls).toBe(1)
  })

  it('advances virtual time per line without sleeping', async () => {
    const { result, clock } = await play(ROUND, undefined, {}, 7)
    expect(clock.now()).toBe(START + 7 * ROUND.length)
    expect(result.usage.durationMs).toBe(7 * ROUND.length)
  })

  it('fails with max_turns when the step cap is exceeded, before the extra step emits', async () => {
    const steps: RecordedStep[] = [...ROUND, { kind: 'step' }, { kind: 'text', text: 'too far' }]
    const { result } = await play(steps, { maxTurns: 1 })
    expect(result).toMatchObject({ outcome: 'error', errorCode: 'max_turns', text: 'hello world' })
  })

  it('fails with budget_exhausted on token and cost caps, and passes just under them', async () => {
    expect((await play(ROUND, { maxTokens: 119 })).result.errorCode).toBe('budget_exhausted')
    expect((await play(ROUND, { maxCostMicros: 49 })).result.errorCode).toBe('budget_exhausted')
    expect((await play(ROUND, { maxTokens: 120, maxCostMicros: 50 })).result.outcome).toBe('success')
  })

  it('fails with timeout once virtual wall time passes the cap', async () => {
    const { result } = await play(ROUND, { maxWallMs: 25 }, {}, 10)
    expect(result).toMatchObject({ outcome: 'error', errorCode: 'timeout' })
  })

  it('maps an error record to a single runtime_error', async () => {
    const { result, events } = await play([{ kind: 'step' }, { kind: 'error', message: 'provider 429' }])
    expect(result).toMatchObject({ outcome: 'error', errorCode: 'runtime_error' })
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
  })

  it('hangs after the requested line and cancels with the partial text', async () => {
    const clock = createVirtualClock(START)
    const runtime = new ScriptedRuntime({ turns: [{ jsonl: opencodeRecording(ROUND), hangAfterLine: 2 }], clock })
    const pending = runtime.turn(input(), () => undefined)
    await runtime.hung
    expect(runtime.cancel('t1')).toBe(true)
    const result = await pending
    expect(result).toMatchObject({ outcome: 'cancelled', errorCode: 'cancelled', text: 'hello ' })
    expect(runtime.cancel('t1')).toBe(false)
  })

  it('throws with context when more turns run than were scripted', async () => {
    const { runtime } = await play(ROUND)
    await expect(runtime.turn(input(), () => undefined)).rejects.toThrow('no scripted turn for call 2')
  })
})
