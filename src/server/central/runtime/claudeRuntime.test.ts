import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeRuntime } from './claudeRuntime'
import type { ClaudeRuntimeOptions } from './claudeOptions'
import {
  alive, assistantRecord, captureSource, deltaRecord, emitSource, initRecord, recorder, resultRecord,
  successRecords, turnInput, waitFor, writeFakeClaude,
} from './claude.fakeBin'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-runtime-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function runtime(executable: string, extra: Partial<ClaudeRuntimeOptions> = {}) {
  return new ClaudeRuntime({
    executable,
    workDir: join(dir, 'work'),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    killGraceMs: 50,
    newSessionId: () => 'new-session-id',
    ...extra,
  })
}

const fake = (body: string) => writeFakeClaude(dir, body)
const typesOf = (events: { type: string }[]) => events.map((e) => e.type)

describe('ClaudeRuntime success', () => {
  it('streams deltas once, reports usage and the session ref', async () => {
    const { events, emit } = recorder()
    const result = await runtime(fake(`readStdin()\n${emitSource(successRecords())}`)).turn(turnInput(), emit)

    expect(result.outcome).toBe('success')
    expect(result.text).toBe('Hello world')
    expect(result.sessionRef).toBe('sess-1')
    expect(result.usage).toMatchObject({
      inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1, costMicros: 250, durationMs: 1200,
    })
    expect(typesOf(events)).toEqual(['text.delta', 'text.delta', 'usage', 'turn.result'])
  })

  it('falls back to the full assistant text when the CLI sent no deltas', async () => {
    const bin = fake(`readStdin()\n${emitSource([initRecord(), assistantRecord('m1', 'Whole text'), resultRecord()])}`)
    const result = await runtime(bin).turn(turnInput(), recorder().emit)
    expect(result.text).toBe('Whole text')
    expect(result.outcome).toBe('success')
  })

  it('ignores junk lines and over-long lines', async () => {
    const body = `readStdin()
process.stdout.write('banner that is not json\\n')
process.stdout.write('x'.repeat(300 * 1024) + '\\n')
${emitSource(successRecords())}`
    const result = await runtime(fake(body)).turn(turnInput(), recorder().emit)
    expect(result.outcome).toBe('success')
    expect(result.text).toBe('Hello world')
  })

  it('starts a session on the first turn and resumes with the stored ref afterwards', async () => {
    const first = join(dir, 'first.json')
    const second = join(dir, 'second.json')
    const run = (file: string) => fake(`${captureSource(file)}${emitSource([initRecord({ session_id: 'sess-2' }), resultRecord({ session_id: 'sess-2' })])}`)

    const r1 = await runtime(run(first)).turn(turnInput(), recorder().emit)
    const a1 = JSON.parse(readFileSync(first, 'utf8')).argv as string[]
    expect(a1[a1.indexOf('--session-id') + 1]).toBe('new-session-id')
    expect(a1).not.toContain('--resume')
    expect(r1.sessionRef).toBe('sess-2')

    await runtime(run(second)).turn(turnInput({ turnId: 't2', sessionRef: r1.sessionRef ?? undefined }), recorder().emit)
    const a2 = JSON.parse(readFileSync(second, 'utf8')).argv as string[]
    expect(a2[a2.indexOf('--resume') + 1]).toBe('sess-2')
    expect(a2).not.toContain('--session-id')
  })

  it('returns no sessionRef when a resumed turn fails', async () => {
    const bin = fake(`readStdin()\n${emitSource([resultRecord({ subtype: 'error_during_execution', is_error: true })])}\nprocess.exit(1)`)
    const { events, emit } = recorder()
    const result = await runtime(bin).turn(turnInput({ sessionRef: 'stale' }), emit)
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
    const bin = fake(`readStdin()\n${emitSource([initRecord(), resultRecord({ subtype, is_error: true })])}`)
    const { events, emit } = recorder()
    const result = await runtime(bin).turn(turnInput(), emit)
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe(code)
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn.result', outcome: 'error' })
  })

  it('treats success with is_error:true as a runtime error', async () => {
    const bin = fake(`readStdin()\n${emitSource([initRecord(), resultRecord({ is_error: true })])}`)
    const result = await runtime(bin).turn(turnInput(), recorder().emit)
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_error')
  })

  it('reports a single error for an auth failure, with the login message', async () => {
    const body = `readStdin()\n${emitSource([initRecord(), assistantRecord('m1', 'Invalid API key', { error: 'authentication_failed' }),
      resultRecord({ is_error: true })])}`
    const { events, emit } = recorder()
    const result = await runtime(fake(body)).turn(turnInput(), emit)
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'runtime_unavailable', retryable: false })
    expect((errors[0] as { message: string }).message).toContain('claude auth login')
    expect(result.errorCode).toBe('runtime_unavailable')
    expect(result.text).toBe('')
  })

  it('marks a rate limit retryable', async () => {
    const body = `readStdin()\n${emitSource([assistantRecord('m1', 'slow down', { error: 'rate_limit' }), resultRecord({ is_error: true })])}`
    const { events, emit } = recorder()
    await runtime(fake(body)).turn(turnInput(), emit)
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'runtime_error', retryable: true })
  })

  it('fails closed and kills the process when init lists tools', async () => {
    const pidFile = join(dir, 'pid')
    const body = `readStdin()
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
${emitSource([initRecord({ tools: ['Bash'] })])}
setInterval(() => {}, 1000)`
    const { events, emit } = recorder()
    const result = await runtime(fake(body)).turn(turnInput(), emit)
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_error')
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
    expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
  })

  it('fails with unknown_tool when the assistant tries to use a tool', async () => {
    const tool = { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }
    const body = `readStdin()\n${emitSource([initRecord(), tool])}\nsetInterval(() => {}, 1000)`
    const result = await runtime(fake(body)).turn(turnInput(), recorder().emit)
    expect(result.errorCode).toBe('unknown_tool')
  })

  it('stops the child when unique assistant messages exceed maxTurns', async () => {
    const records = ['a', 'b', 'c'].map((id) => assistantRecord(id, 'x'))
    const body = `readStdin()\n${emitSource(records)}\nsetInterval(() => {}, 1000)`
    const result = await runtime(fake(body)).turn(turnInput({ limits: { maxTurns: 2 } }), recorder().emit)
    expect(result.errorCode).toBe('max_turns')
  })

  it('stops the child when tokens pass the configured cap', async () => {
    const body = `readStdin()\n${emitSource([assistantRecord('a', 'x'), assistantRecord('b', 'x')])}\nsetInterval(() => {}, 1000)`
    const result = await runtime(fake(body), { maxTokens: 20 }).turn(turnInput(), recorder().emit)
    expect(result.errorCode).toBe('budget_exhausted')
  })

  it('maps an exit without a result (SIGTERM-style 143) to runtime_error', async () => {
    const result = await runtime(fake('readStdin()\nprocess.exit(143)')).turn(turnInput(), recorder().emit)
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_error')
  })

  it('reports a missing executable as runtime_unavailable (not installed)', async () => {
    const { events, emit } = recorder()
    const result = await runtime(join(dir, 'no-such-claude')).turn(turnInput(), emit)
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_unavailable')
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'Claude Code is not installed on the server PATH' })
  })

  it('honors maxTurns < 1 without spawning', async () => {
    const result = await runtime(join(dir, 'missing')).turn(turnInput({ limits: { maxTurns: 0 } }), recorder().emit)
    expect(result.errorCode).toBe('max_turns')
  })

  it('refuses a duplicate active turn id', async () => {
    const rt = runtime(fake('readStdin()\nsetInterval(() => {}, 1000)'))
    const first = rt.turn(turnInput(), recorder().emit)
    await expect(rt.turn(turnInput(), recorder().emit)).rejects.toThrow('already active')
    rt.cancel('t1')
    await first
  })
})

describe('ClaudeRuntime cancel, timeout and close', () => {
  it('cancel escalates SIGINT, SIGTERM, SIGKILL against a child that ignores signals', async () => {
    const sigFile = join(dir, 'signals')
    const pidFile = join(dir, 'pid')
    const body = `readStdin()
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => fs.appendFileSync(${JSON.stringify(sigFile)}, sig + ','))
${emitSource([initRecord(), deltaRecord('partial')])}
setInterval(() => {}, 1000)`
    const { events, emit } = recorder()
    const rt = runtime(fake(body))
    const pending = rt.turn(turnInput(), emit)
    await waitFor(() => events.some((e) => e.type === 'text.delta'), 5_000)
    expect(rt.cancel('t1')).toBe(true)

    const result = await pending
    expect(result.outcome).toBe('cancelled')
    expect(result.errorCode).toBe('cancelled')
    expect(result.text).toBe('partial')
    expect(readFileSync(sigFile, 'utf8')).toBe('SIGINT,SIGTERM,')
    await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8'))), 2_000)
  })

  it('an abort signal cancels like cancel(); cancel is false for unknown turns', async () => {
    const body = `readStdin()\n${emitSource([initRecord(), deltaRecord('x')])}\nsetInterval(() => {}, 1000)`
    const controller = new AbortController()
    const { events, emit } = recorder()
    const rt = runtime(fake(body))
    const pending = rt.turn(turnInput(), emit, controller.signal)
    await waitFor(() => events.some((e) => e.type === 'text.delta'), 5_000)
    controller.abort()
    expect((await pending).outcome).toBe('cancelled')
    expect(rt.cancel('nope')).toBe(false)
  })

  it('kills a hung child at the wall deadline and reports timeout', async () => {
    const { events, emit } = recorder()
    const started = Date.now()
    const result = await runtime(fake('readStdin()\nsetInterval(() => {}, 1000)')).turn(
      turnInput({ limits: { maxWallMs: 200 } }), emit
    )
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('timeout')
    expect(events.some((e) => e.type === 'error' && e.code === 'timeout')).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('close() cancels every active turn', async () => {
    const rt = runtime(fake('readStdin()\nsetInterval(() => {}, 1000)'))
    const pending = rt.turn(turnInput(), recorder().emit)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rt.close()
    expect((await pending).outcome).toBe('cancelled')
  })
})
