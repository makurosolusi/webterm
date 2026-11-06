import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withoutGitSafety } from '../gitExec.testutil'
import {
  WorktreeError,
  assertInsideRoot,
  branchProblem,
  createWorktreeService,
  isInsideRoot,
  type Exec,
  type ExecResult,
} from './worktree'

const ROOT = resolve('/tmp/webterm-worktrees')
const REPO = resolve('/tmp/example-repo')

function fakeExec(result: ExecResult = { code: 0 }): { exec: Exec; calls: string[][] } {
  const calls: string[][] = []
  const exec: Exec = async (file, args) => {
    calls.push([file, ...withoutGitSafety(args)])
    return result
  }
  return { exec, calls }
}

function service(exec: Exec) {
  return createWorktreeService({ root: ROOT, exec, now: () => 42 })
}

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`expected WorktreeError ${code}, resolved instead`)
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(WorktreeError)
      expect((err as WorktreeError).code).toBe(code)
    }
  )
}

describe('allocation', () => {
  it('runs git worktree add with a path inside the configured root', async () => {
    const { exec, calls } = fakeExec()
    const worktrees = service(exec)
    const allocation = await worktrees.allocate({
      taskId: 'task-1',
      branch: 'agent/task-1',
      repo: REPO,
      owner: 'worker-1',
    })
    expect(calls).toEqual([
      ['git', '-C', REPO, 'worktree', 'add', '-b', 'agent/task-1', resolve(ROOT, 'task-task-1'), 'HEAD'],
    ])
    expect(allocation).toEqual({
      taskId: 'task-1',
      branch: 'agent/task-1',
      path: resolve(ROOT, 'task-task-1'),
      repo: REPO,
      owner: 'worker-1',
      createdAt: 42,
    })
    expect(worktrees.get('task-1')).toEqual(allocation)
    expect(worktrees.list().length).toBe(1)
  })

  it('refuses a second task on the same branch without calling git', async () => {
    const { exec, calls } = fakeExec()
    const worktrees = service(exec)
    await worktrees.allocate({ taskId: 't1', branch: 'agent/shared', repo: REPO, owner: 'w1' })
    await expectCode(
      worktrees.allocate({ taskId: 't2', branch: 'agent/shared', repo: REPO, owner: 'w2' }),
      'branch_in_use'
    )
    expect(calls.length).toBe(1)
  })

  it('refuses to allocate twice for one task', async () => {
    const { exec } = fakeExec()
    const worktrees = service(exec)
    await worktrees.allocate({ taskId: 't1', branch: 'agent/a', repo: REPO, owner: 'w1' })
    await expectCode(
      worktrees.allocate({ taskId: 't1', branch: 'agent/b', repo: REPO, owner: 'w1' }),
      'task_in_use'
    )
  })

  it('does not record an owner when git fails, so the branch stays free', async () => {
    const { exec } = fakeExec({ code: 128, stderr: 'fatal: branch already exists' })
    const worktrees = service(exec)
    await expectCode(
      worktrees.allocate({ taskId: 't1', branch: 'agent/a', repo: REPO, owner: 'w1' }),
      'git_failed'
    )
    expect(worktrees.get('t1')).toBe(undefined)

    const retry = service(fakeExec().exec)
    const again = await retry.allocate({ taskId: 't2', branch: 'agent/a', repo: REPO, owner: 'w2' })
    expect(again.branch).toBe('agent/a')
    expect(retry.get('t2')?.branch).toBe('agent/a')
  })
})

describe('input validation', () => {
  it('rejects traversal and ref-injection branches before calling git', async () => {
    const { exec, calls } = fakeExec()
    const worktrees = service(exec)
    for (const branch of ['../evil', 'agent/../../evil', '/absolute', '-x', 'a b', 'a..b', 'a.lock', '.hidden/x']) {
      await expectCode(
        worktrees.allocate({ taskId: 't1', branch, repo: REPO, owner: 'w1' }),
        'invalid_branch'
      )
    }
    expect(calls.length).toBe(0)
  })

  it('rejects task ids that could escape the worktree directory', async () => {
    const { exec } = fakeExec()
    const worktrees = service(exec)
    for (const taskId of ['../etc', 'a/b', '..', '', '.hidden']) {
      await expectCode(
        worktrees.allocate({ taskId, branch: 'agent/x', repo: REPO, owner: 'w1' }),
        'invalid_task'
      )
    }
  })

  it('requires an absolute repo and a safe base ref', async () => {
    const { exec } = fakeExec()
    const worktrees = service(exec)
    await expectCode(
      worktrees.allocate({ taskId: 't1', branch: 'agent/x', repo: 'relative/repo', owner: 'w1' }),
      'invalid_repo'
    )
    await expectCode(
      worktrees.allocate({
        taskId: 't1',
        branch: 'agent/x',
        repo: REPO,
        owner: 'w1',
        baseRef: '--upload-pack=evil',
      }),
      'invalid_base'
    )
    await expectCode(
      worktrees.allocate({ taskId: 't1', branch: 'agent/x', repo: REPO, owner: ' ' }),
      'invalid_owner'
    )
  })

  it('refuses a relative root at construction time', () => {
    expect(() => createWorktreeService({ root: 'relative', exec: fakeExec().exec })).toThrow(
      WorktreeError
    )
  })
})

describe('release and cleanup guards', () => {
  it('releases through git worktree remove --force and frees the branch', async () => {
    const { exec, calls } = fakeExec()
    const worktrees = service(exec)
    await worktrees.allocate({ taskId: 't1', branch: 'agent/a', repo: REPO, owner: 'w1' })
    const released = await worktrees.release({ taskId: 't1' })
    expect(released.branch).toBe('agent/a')
    expect(calls[1]).toEqual([
      'git',
      '-C',
      REPO,
      'worktree',
      'remove',
      '--force',
      resolve(ROOT, 'task-t1'),
    ])
    expect(worktrees.get('t1')).toBe(undefined)
    const reused = await worktrees.allocate({
      taskId: 't2',
      branch: 'agent/a',
      repo: REPO,
      owner: 'w2',
    })
    expect(reused.branch).toBe('agent/a')
    expect(worktrees.get('t2')?.branch).toBe('agent/a')
  })

  it('rejects unknown tasks and a mismatched branch on release', async () => {
    const { exec } = fakeExec()
    const worktrees = service(exec)
    await expectCode(worktrees.release({ taskId: 'ghost' }), 'not_found')
    await worktrees.allocate({ taskId: 't1', branch: 'agent/a', repo: REPO, owner: 'w1' })
    await expectCode(worktrees.release({ taskId: 't1', branch: 'agent/b' }), 'not_found')
    expect(worktrees.get('t1')?.branch).toBe('agent/a')
  })

  it('keeps the allocation when git refuses to remove, so cleanup can retry', async () => {
    const calls: string[][] = []
    let fail = false
    const exec: Exec = async (file, args) => {
      calls.push([file, ...withoutGitSafety(args)])
      return fail ? { code: 1, stderr: 'fatal: not a worktree' } : { code: 0 }
    }
    const worktrees = service(exec)
    await worktrees.allocate({ taskId: 't1', branch: 'agent/a', repo: REPO, owner: 'w1' })
    fail = true
    await expectCode(worktrees.release({ taskId: 't1' }), 'git_failed')
    expect(worktrees.get('t1')?.taskId).toBe('t1')
  })

  it('refuses paths outside the configured root and the root itself', () => {
    expect(isInsideRoot(ROOT, resolve(ROOT, 'task-t1'))).toBe(true)
    expect(isInsideRoot(ROOT, ROOT)).toBe(true)
    expect(isInsideRoot(ROOT, `${ROOT}-evil/task-t1`)).toBe(false)
    expectCode(Promise.resolve().then(() => assertInsideRoot(ROOT, '/etc/passwd')), 'outside_root')
    expectCode(Promise.resolve().then(() => assertInsideRoot(ROOT, ROOT)), 'outside_root')
    expectCode(Promise.resolve().then(() => assertInsideRoot(ROOT, `${ROOT}-evil/x`)), 'outside_root')
    expect(assertInsideRoot(ROOT, resolve(ROOT, 'task-t1'))).toBe(resolve(ROOT, 'task-t1'))
  })
})

describe('branchProblem', () => {
  it('accepts normal refs and reports the reason for bad ones', () => {
    expect(branchProblem('agent/task-1')).toBe(null)
    expect(branchProblem('feature/agent-pusat-p3')).toBe(null)
    expect(branchProblem('')).toContain('non-empty')
    expect(branchProblem('a..b')).toContain('..')
    expect(branchProblem('a@{1}')).toContain('@{')
    expect(branchProblem('a//b')).toContain('//')
  })
})

describe('symlink confinement (L1)', () => {
  function realService(root: string) {
    const calls: string[][] = []
    const exec: Exec = async (file, args) => {
      calls.push([file, ...withoutGitSafety(args)])
      return { code: 0 }
    }
    return { calls, service: createWorktreeService({ root, exec, now: () => 42 }) }
  }

  it('refuses to allocate when the target path is a symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webterm-wt-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'webterm-wt-outside-'))
    try {
      mkdirSync(root, { recursive: true })
      symlinkSync(outside, join(root, 'task-t1'))
      const { calls, service: worktrees } = realService(root)
      await expectCode(
        worktrees.allocate({ taskId: 't1', branch: 'agent/t1', repo: REPO, owner: 'w1' }),
        'unsafe_target'
      )
      expect(calls).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a target that exists as a regular file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webterm-wt-root-'))
    try {
      writeFileSync(join(root, 'task-t1'), 'not a directory')
      const { service: worktrees } = realService(root)
      await expectCode(
        worktrees.allocate({ taskId: 't1', branch: 'agent/t1', repo: REPO, owner: 'w1' }),
        'unsafe_target'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a symlinked subpath that resolves outside the root', async () => {
    const base = mkdtempSync(join(tmpdir(), 'webterm-wt-base-'))
    const outside = mkdtempSync(join(tmpdir(), 'webterm-wt-outside-'))
    try {
      // root is a symlink to a directory: the REAL root inside it is what confines allocations.
      const realRoot = join(base, 'real-root')
      mkdirSync(realRoot)
      symlinkSync(realRoot, join(base, 'link-root'))
      symlinkSync(outside, join(realRoot, 'task-t1'))
      const { calls, service: worktrees } = realService(join(base, 'link-root'))
      await expectCode(
        worktrees.allocate({ taskId: 't1', branch: 'agent/t1', repo: REPO, owner: 'w1' }),
        'unsafe_target'
      )
      expect(calls).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('still allocates a fresh directory inside a real root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webterm-wt-root-'))
    try {
      const { calls, service: worktrees } = realService(root)
      const allocation = await worktrees.allocate({
        taskId: 't1',
        branch: 'agent/t1',
        repo: REPO,
        owner: 'w1',
      })
      expect(allocation.path).toBe(join(root, 'task-t1'))
      expect(calls).toEqual([
        ['git', '-C', REPO, 'worktree', 'add', '-b', 'agent/t1', join(root, 'task-t1'), 'HEAD'],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to release through a symlink swapped in after allocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webterm-wt-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'webterm-wt-outside-'))
    try {
      const { service: worktrees } = realService(root)
      await worktrees.allocate({ taskId: 't1', branch: 'agent/t1', repo: REPO, owner: 'w1' })
      symlinkSync(outside, join(root, 'task-t1'))
      await expectCode(worktrees.release({ taskId: 't1' }), 'unsafe_target')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
