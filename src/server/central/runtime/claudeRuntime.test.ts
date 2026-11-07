import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeRuntime } from './claudeRuntime'
import type { ClaudeRuntimeOptions } from './claudeOptions'
import {
  assistantRecord, deltaRecord, initRecord, recorder, resultRecord, successRecords, turnInput, waitFor,
} from './claude.fakeBin'
import { type FakePlay, fakeQuery, hang } from './claude.fakeQuery'
import { createCentralMcpLink } from './claudeMcp'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-runtime-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function runtime(play: FakePlay, extra: Partial<ClaudeRuntimeOptions> = {}) {
  const fake = fakeQuery(play)
  const rt = new ClaudeRuntime({
    query: fake.query,
    workDir: join(dir, 'work'),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    newSessionId: () => 'new-session-id',
    // test-only token: keeps the process capability store (and its import graph) out of these tests
    mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }),
    ...extra,
  })
  return Object.assign(rt, { calls: fake.calls })
}

const typesOf = (events: { type: string }[]) => events.map((e) => e.type)

describe('ClaudeRuntime success', () => {
  it('streams deltas once, reports usage and the session ref', async () => {
    const { events, emit } = recorder()
    const result = await runtime(successRecords()).turn(turnInput(), emit)

    expect(result.outcome).toBe('success')
    expect(result.text).toBe('Hello world')
    expect(result.sessionRef).toBe('sess-1')
    expect(result.usage).toMatchObject({
      inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1, costMicros: 250, durationMs: 1200,
    })
    expect(typesOf(events)).toEqual(['text.delta', 'text.delta', 'usage', 'turn.result'])
  })

  it('falls back to the full assistant text when no deltas arrived', async () => {
    const result = await runtime([initRecord(), assistantRecord('m1', 'Whole text'), resultRecord()]).turn(turnInput(), recorder().emit)
    expect(result.text).toBe('Whole text')
    expect(result.outcome).toBe('success')
  })

  it('ignores messages of unknown shape', async () => {
    const result = await runtime(['not an object', { type: 'rate_limit_event' }, { type: 'system', subtype: 'status' }, ...successRecords()])
      .turn(turnInput(), recorder().emit)
    expect(result.outcome).toBe('success')
    expect(result.text).toBe('Hello world')
  })

  it('starts a session on the first turn and resumes with the stored ref afterwards', async () => {
    const records = [initRecord({ session_id: 'sess-2' }), resultRecord({ session_id: 'sess-2' })]
    const first = runtime(records)
    const r1 = await first.turn(turnInput(), recorder().emit)
    expect(first.calls[0]?.options.sessionId).toBe('new-session-id')
    expect(first.calls[0]?.options.resume).toBeUndefined()
    expect(r1.sessionRef).toBe('sess-2')

    const second = runtime(records)
    await second.turn(turnInput({ turnId: 't2', sessionRef: r1.sessionRef ?? undefined }), recorder().emit)
    expect(second.calls[0]?.options.resume).toBe('sess-2')
    expect(second.calls[0]?.options.sessionId).toBeUndefined()
  })

  it('returns no sessionRef when a resumed turn fails', async () => {
    const { events, emit } = recorder()
    const result = await runtime([resultRecord({ subtype: 'error_during_execution', is_error: true })]).turn(turnInput({ sessionRef: 'stale' }), emit)
    expect(result.outcome).toBe('error')
    expect(result.sessionRef).toBeNull()
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
  })
})

describe('ClaudeRuntime failures', () => {
  it.each([
    ['error_max_turns', 'max_turns'],
    ['error_max_budget_usd', 'budget_exhausted'],
    ['error_during_execution', 'runtime_error'],
  ])('maps result %s to %s with exactly one error event', async (subtype, code) => {
    const { events, emit } = recorder()
    const result = await runtime([initRecord(), resultRecord({ subtype, is_error: true })]).turn(turnInput(), emit)
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe(code)
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn.result', outcome: 'error' })
  })

  it('treats success with is_error:true as a runtime error', async () => {
    const result = await runtime([initRecord(), resultRecord({ is_error: true })]).turn(turnInput(), recorder().emit)
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_error')
  })

  it('reports a single error for an auth failure, with the login message', async () => {
    const play = [initRecord(), assistantRecord('m1', 'Invalid API key', { error: 'authentication_failed' }), resultRecord({ is_error: true })]
    const { events, emit } = recorder()
    const result = await runtime(play).turn(turnInput(), emit)
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'runtime_unavailable', retryable: false })
    expect((errors[0] as { message: string }).message).toContain('claude auth login')
    expect(result.errorCode).toBe('runtime_unavailable')
    expect(result.text).toBe('')
  })

  it('marks a rate limit retryable', async () => {
    const { events, emit } = recorder()
    await runtime([assistantRecord('m1', 'slow down', { error: 'rate_limit' }), resultRecord({ is_error: true })]).turn(turnInput(), emit)
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'runtime_error', retryable: true })
  })

  it('fails closed and stops the query when init lists tools', async () => {
    const rt = runtime(hang([initRecord({ tools: ['Bash'] })]))
    const { events, emit } = recorder()
    const result = await rt.turn(turnInput(), emit)
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_error')
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
    expect(rt.calls[0]?.closed).toBe(true)
    expect(rt.calls[0]?.options.abortController?.signal.aborted).toBe(true)
  })

  it('fails with unknown_tool when the assistant tries to use a tool', async () => {
    const tool = { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }
    const result = await runtime(hang([initRecord(), tool])).turn(turnInput(), recorder().emit)
    expect(result.errorCode).toBe('unknown_tool')
  })

  it('stops the query when unique assistant messages exceed maxTurns', async () => {
    const records = ['a', 'b', 'c'].map((id) => assistantRecord(id, 'x'))
    const result = await runtime(hang(records)).turn(turnInput({ limits: { maxTurns: 2 } }), recorder().emit)
    expect(result.errorCode).toBe('max_turns')
  })

  it('stops the query when tokens pass the configured cap', async () => {
    const result = await runtime(hang([assistantRecord('a', 'x'), assistantRecord('b', 'x')]), { maxTokens: 20 }).turn(turnInput(), recorder().emit)
    expect(result.errorCode).toBe('budget_exhausted')
  })

  it('maps an SDK error without a result to runtime_error, its message as the cause', async () => {
    const play = async function* () { yield* []; throw new Error('Claude Code process exited with code 143') }
    const { events, emit } = recorder()
    const result = await runtime(play).turn(turnInput(), emit)
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_error')
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'Claude ended without a result before starting: Claude Code process exited with code 143' })
  })

  it('maps a query that ends without a result to runtime_error', async () => {
    const result = await runtime([initRecord()]).turn(turnInput(), recorder().emit)
    expect(result).toMatchObject({ outcome: 'error', errorCode: 'runtime_error' })
  })

  it('honors maxTurns < 1 without starting a query', async () => {
    const rt = runtime(successRecords())
    const result = await rt.turn(turnInput({ limits: { maxTurns: 0 } }), recorder().emit)
    expect(result.errorCode).toBe('max_turns')
    expect(rt.calls).toHaveLength(0)
  })

  it('refuses a duplicate active turn id', async () => {
    const rt = runtime(hang())
    const first = rt.turn(turnInput(), recorder().emit)
    await expect(rt.turn(turnInput(), recorder().emit)).rejects.toThrow('already active')
    rt.cancel('t1')
    await first
  })
})

describe('ClaudeRuntime cancel, timeout and close', () => {
  it('cancel aborts and closes the query; the partial text stays', async () => {
    const { events, emit } = recorder()
    const rt = runtime(hang([initRecord(), deltaRecord('partial')]))
    const pending = rt.turn(turnInput(), emit)
    await waitFor(() => events.some((e) => e.type === 'text.delta'), 5_000)
    expect(rt.cancel('t1')).toBe(true)

    const result = await pending
    expect(result.outcome).toBe('cancelled')
    expect(result.errorCode).toBe('cancelled')
    expect(result.text).toBe('partial')
    expect(rt.calls[0]?.closed).toBe(true)
    expect(rt.calls[0]?.options.abortController?.signal.aborted).toBe(true)
  })

  it('an abort signal cancels like cancel(); cancel is false for unknown turns', async () => {
    const controller = new AbortController()
    const { events, emit } = recorder()
    const rt = runtime(hang([initRecord(), deltaRecord('x')]))
    const pending = rt.turn(turnInput(), emit, controller.signal)
    await waitFor(() => events.some((e) => e.type === 'text.delta'), 5_000)
    controller.abort()
    expect((await pending).outcome).toBe('cancelled')
    expect(rt.cancel('nope')).toBe(false)
  })

  it('stops a hung query at the wall deadline and reports timeout', async () => {
    const { events, emit } = recorder()
    const started = Date.now()
    const rt = runtime(hang())
    const result = await rt.turn(turnInput({ limits: { maxWallMs: 200 } }), emit)
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('timeout')
    expect(events.some((e) => e.type === 'error' && e.code === 'timeout')).toBe(true)
    expect(rt.calls[0]?.closed).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('close() cancels every active turn', async () => {
    const rt = runtime(hang())
    const pending = rt.turn(turnInput(), recorder().emit)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rt.close()
    expect((await pending).outcome).toBe('cancelled')
  })
})
