// Why a Claude turn failed must reach the chat (specific reason, right retryable flag) and the
// server log (`central.turn.failed`), with stderr secrets redacted. Fake `claude` executables only.
// Only toBe/toContain matchers are typed (see src/server/bun-test.d.ts).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeRuntime } from './claudeRuntime'
import { createCentralMcpLink } from './claudeMcp'
import { emitSource, initRecord, recorder, resultRecord, turnInput, writeFakeClaude } from './claude.fakeBin'
import { logBus } from '../../logs/logBus'

const FAKE_TOKEN = 'sk-ant-abcdefghijklmnopqrstuvwx' // test-only, must never surface

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-fail-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function run(executable: string, turnId: string) {
  const rt = new ClaudeRuntime({
    executable, workDir: join(dir, 'work'), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    killGraceMs: 50, newSessionId: () => 'new-session-id',
    mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }),
  })
  const before = logBus.query({}).length
  const { events, emit } = recorder()
  const result = await rt.turn(turnInput({ turnId, text: 'PROMPT-MARKER' }), emit)
  const errors = events.filter((e) => e.type === 'error') as Array<{ code: string; message: string; retryable: boolean }>
  const logged = logBus.query({}).slice(before).filter((e) => e.event === 'central.turn.failed')
  expect(errors.length).toBe(1)
  expect(logged.length).toBe(1)
  expect(logged[0]?.level).toBe('error')
  const data = (logged[0]?.data ?? {}) as Record<string, unknown>
  expect(data.turnId).toBe(turnId)
  expect(data.conversationId).toBe('central:global')
  const all = JSON.stringify({ events, logged })
  expect(all.includes(FAKE_TOKEN)).toBe(false)
  expect(all.includes('PROMPT-MARKER')).toBe(false)
  return { result, error: errors[0]!, data }
}

const fake = (body: string) => writeFakeClaude(dir, body)

test('missing executable: not installed, not retryable, ENOENT logged', async () => {
  const { result, error, data } = await run(join(dir, 'no-such-claude'), 't-enoent')
  expect(result.errorCode).toBe('runtime_unavailable')
  expect(error.message).toBe('Claude Code is not installed on the server PATH')
  expect(error.retryable).toBe(false)
  expect(data.spawnErrorCode).toBe('ENOENT')
  expect(data.argv0).toBe('no-such-claude')
})

test('not executable: EACCES names the launch profile', async () => {
  const file = join(dir, 'claude-noexec')
  writeFileSync(file, '#!/bin/sh\n')
  chmodSync(file, 0o644)
  const { error, data } = await run(file, 't-eacces')
  expect(error.code).toBe('runtime_error')
  expect(error.message).toBe('Claude could not be started (EACCES): check the Claude launch profile in Settings')
  expect(data.spawnErrorCode).toBe('EACCES')
})

test('exit 1 with a stderr line: says so, redacts the token, not retryable', async () => {
  const { error, data } = await run(fake(`readStdin(); process.stderr.write('Error: wrapper broke ${FAKE_TOKEN}\\n'); process.exit(1)`), 't-exit1')
  expect(error.code).toBe('runtime_error')
  expect(error.message).toBe('Claude exited with code 1 before starting: Error: wrapper broke [redacted]')
  expect(error.retryable).toBe(false)
  expect(data.exitCode).toBe(1)
  expect(data.sawInit).toBe(false)
  expect(data.stderrFirstLine).toBe('Error: wrapper broke [redacted]')
  expect(Number(data.stderrChars) > 0).toBe(true)
})

test('auth error on stderr: not signed in', async () => {
  const { result, error } = await run(fake(`readStdin(); process.stderr.write('Not logged in · Please run /login\\n'); process.exit(1)`), 't-auth')
  expect(result.errorCode).toBe('runtime_unavailable')
  expect(error.message).toContain('not signed in')
  expect(error.retryable).toBe(false)
})

test('unknown option: the CLI may be too old', async () => {
  const { error } = await run(fake(`readStdin(); process.stderr.write("error: unknown option '--permission-prompts'\\n"); process.exit(1)`), 't-opt')
  expect(error.message).toContain("unknown option '--permission-prompts'")
  expect(error.message).toContain('your Claude CLI may be too old')
})

test('exit after init: no "before starting"; transient stderr is retryable', async () => {
  const { error, data } = await run(fake(`readStdin()\n${emitSource([initRecord()])}\nprocess.stderr.write('API Error: 529 overloaded\\n'); process.exit(2)`), 't-init')
  expect(error.message).toBe('Claude exited with code 2: API Error: 529 overloaded')
  expect(error.retryable).toBe(true)
  expect(data.sawInit).toBe(true)
})

test('killed by a signal: transient, retryable', async () => {
  const { error, data } = await run(fake(`readStdin(); process.kill(process.pid, 'SIGKILL')`), 't-sig')
  expect(error.message).toBe('Claude was stopped by SIGKILL before starting')
  expect(error.retryable).toBe(true)
  expect(data.signal).toBe('SIGKILL')
})

test('failed result with errors[] (unknown resume session) is shown, not dropped', async () => {
  const records = [resultRecord({ subtype: 'error_during_execution', is_error: true, duration_ms: 0, errors: ['No conversation found with session ID: ses_x'] })]
  const { error, data } = await run(fake(`readStdin()\n${emitSource(records)}\nprocess.exit(1)`), 't-resume')
  expect(error.message).toBe('Claude could not find the saved session for this chat; start a new chat to continue')
  expect(data.reason).toBe(error.message)
})

test('failed result with plain error text', async () => {
  const records = [initRecord(), resultRecord({ is_error: true, result: 'API Error: 400 bad request' })]
  const { error } = await run(fake(`readStdin()\n${emitSource(records)}`), 't-result')
  expect(error.message).toBe('Claude reported an error: API Error: 400 bad request')
  expect(error.retryable).toBe(false)
})

/** Fake that fails `--resume <id>` with the CLI's real message; `fresh` is its body without `--resume`. */
function resumeFake(fresh: string): { exe: string; spawns: () => string[][] } {
  const log = join(dir, 'spawns.jsonl')
  const exe = fake(`fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')
readStdin()
const at = process.argv.indexOf('--resume')
if (at >= 0) {
  emit({ ...${JSON.stringify(resultRecord({ subtype: 'error_during_execution', is_error: true, duration_ms: 0 }))}, errors: ['No conversation found with session ID: ' + process.argv[at + 1]] })
  process.exit(1)
}
${fresh}`)
  const spawns = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])
  return { exe, spawns }
}

function plainRuntime(executable: string) {
  return new ClaudeRuntime({
    executable, workDir: join(dir, 'work'), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    killGraceMs: 50, newSessionId: () => 'fresh-session-id',
    mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }),
  })
}

test('missing resumed session: one retry in a fresh session, notice, new id, logged without the full id', async () => {
  const sid = `process.argv[process.argv.indexOf('--session-id') + 1]`
  const { exe, spawns } = resumeFake(`for (const r of ${JSON.stringify([initRecord(), resultRecord()])}) emit({ ...r, session_id: ${sid} })
emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } })`)
  const before = logBus.query({}).length
  const { events, emit } = recorder()
  const result = await plainRuntime(exe).turn(turnInput({ turnId: 't-reset', sessionRef: 'stale-session-1234567890' }), emit)
  expect(result.outcome).toBe('success')
  expect(result.sessionRef).toBe('fresh-session-id')
  expect(events.filter((e) => e.type === 'error').length).toBe(0)
  const notices = events.filter((e) => e.type === 'notice') as Array<{ text: string }>
  expect(notices.length).toBe(1)
  expect(notices[0]!.text).toBe('Started a fresh Claude session; the previous one was no longer available.')
  const runs = spawns()
  expect(runs.length).toBe(2)
  expect(runs[0]!.includes('--resume')).toBe(true)
  expect(runs[1]!.includes('--resume')).toBe(false)
  expect(runs[1]![runs[1]!.indexOf('--session-id') + 1]).toBe('fresh-session-id')
  const reset = logBus.query({}).slice(before).filter((e) => e.event === 'central.session.reset')
  expect(reset.length).toBe(1)
  expect((reset[0]!.data as Record<string, unknown>).oldSessionPrefix).toBe('stale-se')
  expect(JSON.stringify(reset).includes('stale-session-1234567890')).toBe(false)
})

test('missing resumed session whose fresh retry also fails: surfaced normally, no third spawn', async () => {
  const { exe, spawns } = resumeFake(`process.stderr.write('Error: fresh run broke\\n'); process.exit(1)`)
  const { events, emit } = recorder()
  const result = await plainRuntime(exe).turn(turnInput({ turnId: 't-reset-fail', sessionRef: 'stale-session-2' }), emit)
  expect(result.outcome).toBe('error')
  expect(spawns().length).toBe(2)
  const errors = events.filter((e) => e.type === 'error') as Array<{ message: string }>
  expect(errors.length).toBe(1)
  expect(errors[0]!.message).toBe('Claude exited with code 1 before starting: Error: fresh run broke')
})
