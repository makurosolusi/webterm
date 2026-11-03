import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudePreflight, type RunFn, type RunResult } from './claudePreflight'

const EMAIL = 'someone.private@example.com'
const env = { PATH: '/x' } as NodeJS.ProcessEnv
const fake = (r: Partial<RunResult> | Error): RunFn => vi.fn(async () => {
  if (r instanceof Error) throw r
  return { code: 0, stdout: '', timedOut: false, ...r }
})
const make = (run: RunFn, extra = {}) => createClaudePreflight({ env, run, onPath: () => true, ...extra })

afterEach(() => vi.restoreAllMocks())

describe('createClaudePreflight', () => {
  it('claude_not_found when not on PATH, without spawning', async () => {
    const run = fake({})
    const r = await createClaudePreflight({ env, run, onPath: () => false })()
    expect(r).toMatchObject({ ok: false, code: 'claude_not_found' })
    expect(run).not.toHaveBeenCalled()
  })

  it('ok on exit 0 and loggedIn true', async () => {
    expect(await make(fake({ stdout: '{"loggedIn":true}' }))()).toEqual({ ok: true })
  })

  it('not_authenticated on exit 1, and on exit 0 with loggedIn false/missing', async () => {
    expect(await make(fake({ code: 1, stdout: '{"loggedIn":false}' }))()).toMatchObject({ code: 'claude_not_authenticated' })
    expect(await make(fake({ stdout: '{"loggedIn":false}' }))()).toMatchObject({ code: 'claude_not_authenticated' })
    expect(await make(fake({ stdout: '{}' }))()).toMatchObject({ code: 'claude_not_authenticated' })
  })

  it('check_failed on timeout, broken JSON, non-object JSON, other exit code, spawn error', async () => {
    for (const r of [{ timedOut: true, code: null }, { stdout: 'not json' }, { stdout: 'null' }, { code: 2 }, new Error('boom')]) {
      expect(await make(fake(r))()).toMatchObject({ ok: false, code: 'claude_check_failed' })
    }
  })

  it('caches within the TTL (one spawn) and re-probes after it', async () => {
    let t = 0
    const run = fake({ stdout: '{"loggedIn":true}' })
    const pre = make(run, { now: () => t, ttlMs: 100 })
    await Promise.all([pre(), pre()])
    t = 99
    await pre()
    expect(run).toHaveBeenCalledTimes(1)
    t = 100
    await pre()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never leaks output (email) into the result, console, or error text', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const out = JSON.stringify({ loggedIn: false, email: EMAIL })
    const results = [
      await make(fake({ code: 1, stdout: out }))(),
      await make(fake({ stdout: out }))(),
      await make(fake({ stdout: `${EMAIL} {bad` }))(),
      await make(fake(new Error(`spawn failed for ${EMAIL}`)))(),
    ]
    expect(JSON.stringify(results)).not.toContain('example.com')
    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain('example.com')
  })
})

describe('createClaudePreflight with a fake binary on a tmp PATH', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
  const fakeBin = (body: string): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(join(tmpdir(), 'cpf-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\n${body}\n`)
    chmodSync(join(dir, 'claude'), 0o755)
    return { PATH: dir }
  }

  it('real spawn: logged in, logged out, and timeout', async () => {
    expect(await createClaudePreflight({ env: fakeBin(`echo '{"loggedIn":true,"email":"${EMAIL}"}'`) })()).toEqual({ ok: true })
    expect(await createClaudePreflight({ env: fakeBin(`echo '{"loggedIn":false}'; exit 1`) })()).toMatchObject({ code: 'claude_not_authenticated' })
    expect(await createClaudePreflight({ env: fakeBin('exec sleep 5'), timeoutMs: 200 })()).toMatchObject({ code: 'claude_check_failed' })
  })

  it('claude_not_found when PATH has no claude', async () => {
    expect(await createClaudePreflight({ env: { PATH: tmpdir() + '/no-such-dir' } })()).toMatchObject({ code: 'claude_not_found' })
  })
})
