import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type VerifyExec,
  type VerifyExecOptions,
  type VerifyExecResult,
  VerifyError,
  verifyWorktree,
} from './verify'
import { createProcessExec } from './verifier'

const ROOT = '/tmp/wt/task-1'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

type Script = Record<string, Partial<VerifyExecResult>>

function fakeExec(script: Script) {
  const calls: { file: string; args: string[]; options: VerifyExecOptions }[] = []
  const exec: VerifyExec = (file, args, options) => {
    calls.push({ file, args, options })
    const key = [file, ...args].join(' ')
    const entry = script[key]
    if (!entry) throw new Error(`unexpected command: ${key}`)
    return { code: 0, ...entry }
  }
  return { exec, calls }
}

function baseScript(): Script {
  return {
    'git status --porcelain': { stdout: ' M src/api.ts\n?? src/api.test.ts\n' },
    'git diff --name-only': { stdout: 'src/api.ts\n' },
    'git diff --stat': { stdout: ' src/api.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)\n' },
    'npm test': { stdout: 'Tests 12 passed (12)\n' },
    'npm run typecheck': { stdout: '' },
  }
}

describe('verifyWorktree', () => {
  it('runs only allowlisted argv commands and records digests, not output', async () => {
    const { exec, calls } = fakeExec(baseScript())
    let clock = 0
    const outcome = await verifyWorktree(
      { root: ROOT, exec, now: () => (clock += 5) },
      { cwd: ROOT, scope: ['src/api.ts', 'src/api.test.ts'] }
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.reasons).toEqual([])
    expect(outcome.changedFiles).toEqual(['src/api.test.ts', 'src/api.ts'])
    expect(outcome.scopeViolations).toEqual([])
    expect(outcome.tests).toEqual({ passed: 12, failed: 0, command: 'npm test' })
    expect(outcome.typecheck).toEqual({ ok: true, command: 'npm run typecheck' })
    expect(outcome.evidence.map((entry) => entry.command)).toEqual([
      'git status --porcelain',
      'git diff --name-only',
      'git diff --stat',
      'npm test',
      'npm run typecheck',
    ])
    for (const entry of outcome.evidence) {
      expect(entry.outputDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.exitCode).toBe(0)
      expect(entry.durationMs).toBe(5)
      expect(entry.summary).not.toContain('Tests 12 passed')
    }
    expect(calls.every((call) => call.options.cwd === ROOT)).toBe(true)
    expect(calls.every((call) => call.options.timeoutMs === 120_000)).toBe(true)
  })

  it('fails on a scope violation before running test commands', async () => {
    const script = baseScript()
    script['git status --porcelain'] = { stdout: ' M src/secret.ts\n' }
    const { exec, calls } = fakeExec(script)
    const outcome = await verifyWorktree(
      { root: ROOT, exec },
      { cwd: ROOT, scope: ['src/api.ts'] }
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.scopeViolations).toEqual(['src/secret.ts'])
    expect(outcome.reasons).toEqual(['scope violation: src/secret.ts'])
    expect(outcome.tests).toBeUndefined()
    expect(calls.map((call) => call.file)).toEqual(['git', 'git', 'git'])
  })

  it('rejects a configured command whose executable is not allowlisted', async () => {
    const { exec, calls } = fakeExec(baseScript())
    await expect(
      verifyWorktree(
        { root: ROOT, exec, commands: { test: { file: 'curl', args: ['http://example.test'] } } },
        { cwd: ROOT }
      )
    ).rejects.toMatchObject({ code: 'invalid_command' })
    expect(calls.some((call) => call.file === 'curl')).toBe(false)
  })

  it('rejects configured arguments with control characters', async () => {
    const { exec } = fakeExec(baseScript())
    await expect(
      verifyWorktree(
        { root: ROOT, exec, commands: { test: { file: 'npm', args: ['test', 'a\u0000b'] } } },
        { cwd: ROOT }
      )
    ).rejects.toMatchObject({ code: 'invalid_command' })
  })

  it('stops a hung exec at the configured timeout', async () => {
    const script = baseScript()
    const { exec: base } = fakeExec(script)
    const exec: VerifyExec = (file, args, options) => {
      if ([file, ...args].join(' ') === 'npm test') return new Promise<VerifyExecResult>(() => {})
      return base(file, args, options)
    }
    const outcome = await verifyWorktree(
      { root: ROOT, exec, timeoutMs: 20 },
      { cwd: ROOT }
    )

    expect(outcome.ok).toBe(false)
    const testRun = outcome.evidence.find((entry) => entry.command === 'npm test')
    expect(testRun?.exitCode).toBe(124)
    expect(testRun?.summary).toContain('timed out')
    expect(outcome.reasons).toContain('npm test exited 124')
    expect(outcome.tests).toEqual({ passed: 0, failed: 1, command: 'npm test' })
  })

  it('caps output and digests only the capped bytes', async () => {
    const script = baseScript()
    const big = 'x'.repeat(10_000)
    script['npm test'] = { stdout: `Tests 3 passed\n${big}` }
    const { exec } = fakeExec(script)
    const outcome = await verifyWorktree(
      { root: ROOT, exec, maxOutputBytes: 64 },
      { cwd: ROOT, checks: { typecheck: false } }
    )

    const testRun = outcome.evidence.find((entry) => entry.command === 'npm test')
    const expected = Buffer.from(`Tests 3 passed\n${big}`, 'utf8').subarray(0, 64).toString('utf8')
    expect(testRun?.outputDigest).toBe(sha256(expected))
    expect(testRun?.summary).toContain('truncated')
    expect(testRun?.summary.length).toBeLessThan(120)
    expect(outcome.tests?.passed).toBe(3)
  })

  it('refuses cwd outside the worktree root', async () => {
    const { exec } = fakeExec(baseScript())
    await expect(verifyWorktree({ root: ROOT, exec }, { cwd: '../outside' })).rejects.toMatchObject({
      code: 'invalid_cwd',
    })
    await expect(verifyWorktree({ root: ROOT, exec }, { cwd: '/etc' })).rejects.toMatchObject({
      code: 'invalid_cwd',
    })
    await expect(verifyWorktree({ root: 'relative/root', exec }, { cwd: 'sub' })).rejects.toMatchObject({
      code: 'invalid_root',
    })
  })

  it('accepts a cwd nested inside the root', async () => {
    const { exec, calls } = fakeExec(baseScript())
    const outcome = await verifyWorktree(
      { root: ROOT, exec },
      { cwd: `${ROOT}/packages/app`, scope: ['src/api.ts', 'src/api.test.ts'] }
    )
    expect(outcome.ok).toBe(true)
    expect(calls[0]?.options.cwd).toBe(`${ROOT}/packages/app`)
  })

  it('passes configured argv verbatim without a shell', async () => {
    const script = baseScript()
    const args = ['test', '--', '--grep', 'a b; rm -rf /']
    script[`npm ${args.join(' ')}`] = { stdout: 'ok\n' }
    const { exec, calls } = fakeExec(script)
    const outcome = await verifyWorktree(
      { root: ROOT, exec, commands: { test: { file: 'npm', args } } },
      { cwd: ROOT, checks: { typecheck: false } }
    )

    expect(outcome.ok).toBe(true)
    expect(calls.find((call) => call.file === 'npm')?.args).toEqual(args)
  })

  it('fails when the test command is red or reports zero passing tests', async () => {
    const red = baseScript()
    red['npm test'] = { code: 1, stdout: 'Tests 2 passed, 1 failed\n' }
    const redOutcome = await verifyWorktree(
      { root: ROOT, exec: fakeExec(red).exec },
      { cwd: ROOT, checks: { typecheck: false } }
    )
    expect(redOutcome.ok).toBe(false)
    expect(redOutcome.tests).toEqual({ passed: 2, failed: 1, command: 'npm test' })
    expect(redOutcome.reasons).toContain('npm test exited 1')

    const empty = baseScript()
    empty['npm test'] = { stdout: 'Tests 0 passed\n' }
    const emptyOutcome = await verifyWorktree(
      { root: ROOT, exec: fakeExec(empty).exec },
      { cwd: ROOT, checks: { typecheck: false } }
    )
    expect(emptyOutcome.ok).toBe(false)
    expect(emptyOutcome.reasons).toContain('npm test reported 0 passing tests')
  })

  it('fails git and runs no checks when the worktree is not a git repo', async () => {
    const { exec, calls } = fakeExec({
      'git status --porcelain': { code: 128, stderr: 'not a git repository' },
      'git diff --name-only': { code: 0 },
      'git diff --stat': { code: 0 },
    })
    const outcome = await verifyWorktree({ root: ROOT, exec }, { cwd: ROOT })
    expect(outcome.ok).toBe(false)
    expect(outcome.reasons).toEqual(['git status --porcelain exited 128'])
    expect(calls.map((call) => call.file)).toEqual(['git', 'git', 'git'])
  })

  it('rejects scope entries that escape the worktree', async () => {
    const { exec } = fakeExec(baseScript())
    await expect(
      verifyWorktree({ root: ROOT, exec }, { cwd: ROOT, scope: ['../etc'] })
    ).rejects.toMatchObject({ code: 'invalid_scope' })
    await expect(
      verifyWorktree({ root: ROOT, exec }, { cwd: ROOT, scope: ['/etc/passwd'] })
    ).rejects.toMatchObject({ code: 'invalid_scope' })
    await expect(
      verifyWorktree({ root: ROOT, exec }, { cwd: ROOT, scope: [''] })
    ).rejects.toBeInstanceOf(VerifyError)
  })
})

describe('createProcessExec', () => {
  it('runs an allowlisted git command with shell:false in the repo', async () => {
    const outcome = await verifyWorktree(
      { root: process.cwd(), exec: createProcessExec() },
      { cwd: process.cwd(), checks: { test: false, typecheck: false } }
    )
    expect(outcome.evidence.map((entry) => entry.command)).toEqual([
      'git status --porcelain',
      'git diff --name-only',
      'git diff --stat',
    ])
    expect(outcome.ok).toBe(true)
  })
})
