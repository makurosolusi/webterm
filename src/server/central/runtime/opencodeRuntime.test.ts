import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeEvent, TurnInput } from './centralRuntime'
import { OpenCodeRuntime, type OpenCodeRuntimeOptions } from './opencodeRuntime'
import { parseRuntimeKind } from './runtimeFlag'

let dir = ''
let seq = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opencode-runtime-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Fake `opencode` executable: a Node script emitting JSONL, no network. */
function fakeBin(source: string): string {
  seq += 1
  const file = join(dir, `fake-opencode-${seq}.mjs`)
  writeFileSync(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 })
  chmodSync(file, 0o755)
  return file
}

const EMIT = 'const emit = (record) => process.stdout.write(JSON.stringify(record) + "\\n")'

function runtime(executable: string, extra: Partial<OpenCodeRuntimeOptions> = {}) {
  return new OpenCodeRuntime({
    executable,
    cwd: dir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME, WEBTERM_TOKEN: 'root-secret' },
    ...extra,
  })
}

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

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('OpenCodeRuntime success', () => {
  it('streams text, accumulates step usage, and reports the session ref', async () => {
    const bin = fakeBin(`
      ${EMIT}
      emit({ type: 'step_start', sessionID: 'ses_1', part: {} })
      emit({ type: 'text', sessionID: 'ses_1', part: { id: 'p1', text: 'Hello' } })
      emit({ type: 'step_finish', sessionID: 'ses_1', part: {
        cost: 0.00025,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      } })
    `)
    const { events, emit } = recorder()
    const result = await runtime(bin).turn(input(), emit)

    expect(result.outcome).toBe('success')
    expect(result.text).toBe('Hello')
    expect(result.sessionRef).toBe('ses_1')
    expect(result.usage).toMatchObject({
      inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1, costMicros: 250,
    })
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0)
    expect(events.map((event) => event.type)).toEqual([
      'text.delta', 'usage', 'usage', 'turn.result',
    ])
    expect(events.at(-1)).toMatchObject({ type: 'turn.result', outcome: 'success', text: 'Hello' })
  })

  it('maps tool_use into requested and completed events', async () => {
    const bin = fakeBin(`
      ${EMIT}
      emit({ type: 'tool_use', sessionID: 's', part: {
        callID: 'call_1', tool: 'portfolio.read',
        state: { status: 'completed', input: { scope: 'global' }, output: { items: 1 } },
      } })
      emit({ type: 'text', sessionID: 's', part: { id: 'p1', text: 'done' } })
    `)
    const { events, emit } = recorder()
    const result = await runtime(bin).turn(input(), emit)

    expect(result.outcome).toBe('success')
    const toolEvents = events.filter((event) => event.type === 'tool.requested' || event.type === 'tool.completed')
    expect(toolEvents).toHaveLength(2)
    expect(toolEvents[0]).toMatchObject({
      type: 'tool.requested', toolCallId: 'call_1', name: 'portfolio.read',
    })
    expect(toolEvents[1]).toMatchObject({
      type: 'tool.completed', toolCallId: 'call_1', ok: true, output: { items: 1 },
    })
  })

  it('resumes with --session and keeps the prompt out of any log/event', async () => {
    const argvFile = join(dir, 'argv.json')
    const bin = fakeBin(`
      ${EMIT}
      import fs from 'node:fs'
      fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))
      emit({ type: 'text', sessionID: 'ses_out', part: { id: 'p1', text: 'resumed' } })
    `)
    const { emit } = recorder()
    const result = await runtime(bin).turn(
      input({ text: 'continue please', sessionRef: 'ses_in' }), emit
    )

    expect(result.outcome).toBe('success')
    expect(result.sessionRef).toBe('ses_out')
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[]
    expect(argv.slice(0, 5)).toEqual(['run', '--format', 'json', '--model', 'opencode/deepseek-v4.1-flash-free'])
    expect(argv).toContain('--session')
    expect(argv[argv.indexOf('--session') + 1]).toBe('ses_in')
    expect(argv).not.toContain('--auto')
    expect(argv.at(-1)).toBe('continue please')
  })
})

describe('OpenCodeRuntime failures', () => {
  it('reports an in-band error event once and fails the turn', async () => {
    const bin = fakeBin(`
      ${EMIT}
      emit({ type: 'error', error: { name: 'ProviderError', data: { message: 'upstream unavailable' } } })
      process.exit(1)
    `)
    const { events, emit } = recorder()
    const result = await runtime(bin).turn(input(), emit)

    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_error')
    const errors = events.filter((event) => event.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'runtime_error', message: 'upstream unavailable' })
  })

  it('maps a non-zero exit without an error event to a stable message', async () => {
    const bin = fakeBin(`
      process.stderr.write('raw child output that must not leak')
      process.exit(2)
    `)
    const { events, emit } = recorder()
    const result = await runtime(bin).turn(input(), emit)

    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_error')
    const error = events.find((event) => event.type === 'error')
    expect(error).toMatchObject({ code: 'runtime_error', message: 'opencode runtime failed' })
    expect(JSON.stringify(events)).not.toContain('raw child output')
  })

  it('surfaces a spawn failure as runtime_error', async () => {
    const { events, emit } = recorder()
    const result = await runtime(join(dir, 'missing-opencode')).turn(input(), emit)
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_error')
    expect(events.some((event) => event.type === 'error')).toBe(true)
  })

  it('honors maxTurns < 1 without spawning', async () => {
    const { emit } = recorder()
    const result = await runtime(join(dir, 'missing-opencode')).turn(
      input({ limits: { maxTurns: 0 } }), emit
    )
    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('max_turns')
  })
})

describe('OpenCodeRuntime cancel and wall timeout', () => {
  it('cancel kills the child and resolves cancelled', async () => {
    const bin = fakeBin(`
      ${EMIT}
      emit({ type: 'text', sessionID: 's', part: { id: 'p1', text: 'partial' } })
      setInterval(() => {}, 1000)
    `)
    const { events, emit } = recorder()
    const rt = runtime(bin)
    const started = Date.now()
    const pending = rt.turn(input(), emit)

    // Wait for the first streamed block so the test asserts retained partial text.
    await waitFor(() => events.some((event) => event.type === 'text.delta'), 5_000)
    expect(rt.cancel('t1')).toBe(true)

    const result = await pending
    expect(result.outcome).toBe('cancelled')
    expect(result.errorCode).toBe('cancelled')
    expect(result.text).toBe('partial')
    expect(events.at(-1)).toMatchObject({ type: 'turn.result', outcome: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('cancel is idempotent and false for unknown turns', () => {
    const rt = runtime(join(dir, 'missing'))
    expect(rt.cancel('nope')).toBe(false)
  })

  it('kills a hung child at the wall deadline and reports timeout', async () => {
    const bin = fakeBin('setInterval(() => {}, 1000)')
    const { events, emit } = recorder()
    const started = Date.now()
    const result = await runtime(bin).turn(input({ limits: { maxWallMs: 200 } }), emit)

    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(events.some((event) => event.type === 'error' && event.code === 'timeout')).toBe(true)
  })
})

describe('runtime flag', () => {
  it('accepts opencode and still fail-closes unknown values', () => {
    expect(parseRuntimeKind('opencode')).toBe('opencode')
    expect(parseRuntimeKind(' OpenCode ')).toBe('opencode')
    expect(parseRuntimeKind('on')).toBe('off')
    expect(parseRuntimeKind('gpt')).toBe('off')
  })
})
