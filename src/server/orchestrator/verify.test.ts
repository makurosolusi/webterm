import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const BASE_NAMES = 'git diff --name-only HEAD^...HEAD --'
const BASE_STAT = 'git diff --stat HEAD^...HEAD --'

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
    [BASE_NAMES]: { stdout: '' },
    [BASE_STAT]: { stdout: '' },
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
      'git diff --name-only HEAD^...HEAD --',
      'git diff --stat HEAD^...HEAD --',
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
    expect(calls.map((call) => call.file)).toEqual(['git', 'git', 'git', 'git', 'git'])
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

  it('M4: rejects commands smuggled in through the worker input', async () => {
    const { exec, calls } = fakeExec(baseScript())
    for (const key of ['commands', 'args', 'exec', 'env', 'shell']) {
      await expect(
        verifyWorktree(
          { root: ROOT, exec },
          { cwd: ROOT, [key]: { test: { file: 'curl', args: ['http://evil.test'] } } } as never
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
    // Nothing ran: the guard fires before git, let alone a worker-chosen executable.
    expect(calls).toEqual([])
  })

  it('M4: refuses a cwd that escapes the root through a symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webterm-verify-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'webterm-verify-outside-'))
    try {
      mkdirSync(join(root, 'task-1'), { recursive: true })
      symlinkSync(outside, join(root, 'task-1', 'escape'))
      const { exec } = fakeExec(baseScript())
      await expect(
        verifyWorktree({ root: join(root, 'task-1'), exec }, { cwd: 'escape' })
      ).rejects.toMatchObject({ code: 'invalid_cwd' })
      // A real nested directory still works.
      mkdirSync(join(root, 'task-1', 'packages'))
      const outcome = await verifyWorktree(
        { root: join(root, 'task-1'), exec },
        { cwd: 'packages', scope: ['src/api.ts', 'src/api.test.ts'] }
      )
      expect(outcome.ok).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
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
      'git diff --name-only HEAD^...HEAD --',
      'git diff --stat HEAD^...HEAD --',
    ])
    expect(outcome.ok).toBe(true)
  })
})

describe('committed changes (worktree clean)', () => {
  /** Worktree bersih: worker sudah commit, jadi hanya diff baseRef...HEAD yang terlihat. */
  function committedScript(files: string, stat = ' src/change.txt | 1 +\n 1 file changed, 1 insertion(+)\n'): Script {
    const script = baseScript()
    script['git status --porcelain'] = { stdout: '' }
    script['git diff --name-only'] = { stdout: '' }
    script['git diff --stat'] = { stdout: '' }
    script[BASE_NAMES] = { stdout: files }
    script[BASE_STAT] = { stdout: stat }
    return script
  }

  it('counts a committed file as changed and passes the verdict', async () => {
    const { exec } = fakeExec(committedScript('src/change.txt\n'))
    const outcome = await verifyWorktree(
      { root: ROOT, exec },
      { cwd: ROOT, scope: ['src/change.txt'], checks: { typecheck: false } }
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.changedFiles).toEqual(['src/change.txt'])
    expect(outcome.scopeViolations).toEqual([])
    expect(outcome.diffStat).toContain('src/change.txt')
  })

  it('merges committed and uncommitted files without duplicates', async () => {
    const script = committedScript('src/api.ts\nsrc/committed.ts\n', ' src/api.ts | 1 +\n src/committed.ts | 1 +\n')
    script['git status --porcelain'] = { stdout: ' M src/api.ts\n?? src/new.ts\n' }
    script['git diff --name-only'] = { stdout: 'src/api.ts\n' }
    const { exec } = fakeExec(script)
    const outcome = await verifyWorktree(
      { root: ROOT, exec },
      { cwd: ROOT, checks: { typecheck: false } }
    )
    expect(outcome.changedFiles).toEqual(['src/api.ts', 'src/committed.ts', 'src/new.ts'])
    expect(outcome.diffStat).toContain('src/committed.ts')
    expect(outcome.diffStat).toContain('src/api.ts')
  })

  it('treats a missing HEAD^ as an empty base diff instead of failing', async () => {
    const script = baseScript()
    script['git status --porcelain'] = { stdout: ' M src/api.ts\n' }
    script[BASE_NAMES] = { code: 128, stderr: "fatal: ambiguous argument 'HEAD^'" }
    script[BASE_STAT] = { code: 128, stderr: "fatal: ambiguous argument 'HEAD^'" }
    const { exec } = fakeExec(script)
    const outcome = await verifyWorktree(
      { root: ROOT, exec },
      { cwd: ROOT, checks: { typecheck: false } }
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.changedFiles).toEqual(['src/api.ts'])
  })

  it('reports a committed file outside the scope as a violation', async () => {
    const { exec, calls } = fakeExec(committedScript('src/secret.ts\n'))
    const outcome = await verifyWorktree(
      { root: ROOT, exec },
      { cwd: ROOT, scope: ['src/api.ts'] }
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.scopeViolations).toEqual(['src/secret.ts'])
    expect(calls.some((call) => call.file === 'npm')).toBe(false)
  })

  it('still reports zero changed files when worktree and base diff are both empty', async () => {
    const script = committedScript('', '')
    const { exec } = fakeExec(script)
    const outcome = await verifyWorktree(
      { root: ROOT, exec },
      { cwd: ROOT, checks: { typecheck: false } }
    )
    // Verdict itself is green; the no-work guard lives in the worker runtime.
    expect(outcome.ok).toBe(true)
    expect(outcome.changedFiles).toEqual([])
  })

  it('passes an explicit base ref as git argv and falls back to HEAD^ for HEAD', async () => {
    const script = baseScript()
    script['git diff --name-only main...HEAD --'] = { stdout: 'src/change.txt\n' }
    script['git diff --stat main...HEAD --'] = { stdout: ' src/change.txt | 1 +\n' }
    const { exec, calls } = fakeExec(script)
    const outcome = await verifyWorktree(
      { root: ROOT, exec },
      { cwd: ROOT, baseRef: 'main', checks: { typecheck: false } }
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.changedFiles).toContain('src/change.txt')
    expect(calls.map((call) => call.args.join(' '))).toContain('diff --name-only main...HEAD --')

    const headOnly = fakeExec(baseScript())
    await verifyWorktree(
      { root: ROOT, exec: headOnly.exec },
      { cwd: ROOT, baseRef: 'HEAD', checks: { typecheck: false } }
    )
    expect(headOnly.calls.map((call) => call.args.join(' '))).toContain('diff --name-only HEAD^...HEAD --')
  })

  it('rejects a base ref that could be parsed as an option', async () => {
    const { exec, calls } = fakeExec(baseScript())
    for (const baseRef of ['-D', 'main..other', 'ma in', 'main~2']) {
      await expect(
        verifyWorktree({ root: ROOT, exec }, { cwd: ROOT, baseRef })
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(calls).toEqual([])
  })
})
