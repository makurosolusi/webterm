// Alokasi worktree git per task (RND/03-RENCANA.md §8): satu owner per branch,
// branch/task/repo divalidasi sebelum menyentuh git, dan cleanup menolak path di luar root.
// Exec di-inject supaya test tidak pernah menjalankan git nyata.
import { isAbsolute, join, resolve } from 'node:path'
import { isInsideRoot } from './safePath'
import { symlinkProblem, worktreeTargetProblem } from './worktreeTarget'

// `isInsideRoot` is part of this module's public surface (verifier imports it from here).
export { isInsideRoot } from './safePath'

export interface ExecResult {
  code: number
  stdout?: string
  stderr?: string
}

/** `(file, args)` seperti spawn tanpa shell; implementasi nyata memakai Bun.spawn. */
export type Exec = (file: string, args: string[]) => ExecResult | Promise<ExecResult>

export interface WorktreeAllocation {
  taskId: string
  branch: string
  path: string
  repo: string
  owner: string
  createdAt: number
}

export interface AllocateWorktreeInput {
  taskId: string
  branch: string
  repo: string
  owner: string
  /** Ref dasar; default `HEAD`. */
  baseRef?: string
}

export interface ReleaseWorktreeInput {
  taskId: string
  /** Bila diisi, harus sama dengan branch alokasi (guard salah-task). */
  branch?: string
}

export type WorktreeDenyCode =
  | 'invalid_root'
  | 'invalid_branch'
  | 'invalid_task'
  | 'invalid_repo'
  | 'invalid_base'
  | 'invalid_owner'
  | 'branch_in_use'
  | 'task_in_use'
  | 'outside_root'
  | 'unsafe_target'
  | 'git_failed'
  | 'not_found'

export class WorktreeError extends Error {
  constructor(
    readonly code: WorktreeDenyCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'WorktreeError'
  }
}

export interface WorktreeService {
  allocate(input: AllocateWorktreeInput): Promise<WorktreeAllocation>
  release(input: ReleaseWorktreeInput): Promise<WorktreeAllocation>
  get(taskId: string): WorktreeAllocation | undefined
  list(): WorktreeAllocation[]
}

export interface WorktreeOptions {
  /** Base directory for every worktree; must be absolute. */
  root: string
  exec: Exec
  now?: () => number
  /** Prefix ref dasar bila `baseRef` tidak diberikan; default `HEAD`. */
  defaultBaseRef?: string
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const BRANCH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Subset `git check-ref-format --branch`: menolak karakter shell/ref terlarang,
 * `..`, `@{`, komponen tersembunyi, dan akhiran `.lock`. Return pesan error atau null.
 */
export function branchProblem(branch: string): string | null {
  if (typeof branch !== 'string' || branch.trim() === '') return 'branch must be a non-empty string'
  if (branch !== branch.trim()) return 'branch must not have surrounding whitespace'
  if (branch.length > 200) return 'branch is too long'
  if (branch.startsWith('-')) return 'branch must not start with "-"'
  if (branch === '@') return 'branch must not be "@"'
  if (branch.includes('..')) return 'branch must not contain ".."'
  if (branch.includes('@{')) return 'branch must not contain "@{"'
  if (branch.includes('//')) return 'branch must not contain "//"'
  if (branch.startsWith('/') || branch.endsWith('/')) return 'branch must not start or end with "/"'
  if (branch.endsWith('.')) return 'branch must not end with "."'
  if (hasControlChars(branch)) return 'branch must not contain control characters'
  if (/[\s~^:?*[\\]/.test(branch)) return 'branch contains a character git rejects'
  for (const segment of branch.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return `branch segment "${segment}" is not allowed`
    }
    if (segment.startsWith('.')) return `branch segment "${segment}" must not start with "."`
    if (segment.endsWith('.lock')) return `branch segment "${segment}" must not end with ".lock"`
    if (!BRANCH_SEGMENT.test(segment)) return `branch segment "${segment}" has invalid characters`
  }
  return null
}

export function assertValidBranch(branch: string): string {
  const problem = branchProblem(branch)
  if (problem) throw new WorktreeError('invalid_branch', problem)
  return branch
}

export function assertValidTaskId(taskId: string): string {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId) || taskId === '.' || taskId === '..') {
    throw new WorktreeError(
      'invalid_task',
      `taskId must match ${TASK_ID.source}, got ${JSON.stringify(taskId)}`
    )
  }
  return taskId
}

export function assertInsideRoot(root: string, target: string): string {
  if (!isAbsolute(root)) throw new WorktreeError('invalid_root', `root must be absolute: ${root}`)
  if (typeof target !== 'string' || target.trim() === '' || hasControlChars(target)) {
    throw new WorktreeError('outside_root', `invalid worktree path: ${JSON.stringify(target)}`)
  }
  const path = resolve(target)
  if (!isInsideRoot(root, path)) {
    throw new WorktreeError(
      'outside_root',
      `refusing to touch ${path}: outside configured root ${resolve(root)}`
    )
  }
  if (path === resolve(root)) {
    throw new WorktreeError('outside_root', `refusing to remove the worktree root itself: ${path}`)
  }
  return path
}

/**
 * Allocation target: not a symlink, a real directory if it exists, and its REAL path inside root.
 * Problems come back from `worktreeTarget.ts` as data so this module owns the error type.
 */
export function assertSafeWorktreeTarget(root: string, target: string): string {
  const path = assertInsideRoot(root, target)
  const problem = worktreeTargetProblem(resolve(root), path)
  if (problem !== null) throw new WorktreeError(problem.code, problem.message)
  return path
}

function assertRepo(repo: string): string {
  if (typeof repo !== 'string' || !isAbsolute(repo) || hasControlChars(repo)) {
    throw new WorktreeError('invalid_repo', `repo must be an absolute path, got ${JSON.stringify(repo)}`)
  }
  return resolve(repo)
}

function assertBaseRef(ref: string): string {
  if (typeof ref !== 'string' || ref.trim() === '' || hasControlChars(ref) || ref.startsWith('-')) {
    throw new WorktreeError('invalid_base', `invalid base ref: ${JSON.stringify(ref)}`)
  }
  if (ref.includes('..') || /[\s~^:?*[\\]/.test(ref)) {
    throw new WorktreeError('invalid_base', `invalid base ref: ${JSON.stringify(ref)}`)
  }
  return ref
}

function detail(result: ExecResult): string {
  const stderr = (result.stderr ?? '').trim()
  return stderr === '' ? `git exited with code ${result.code}` : stderr
}

/**
 * Service in-memory: alokasi dicatat hanya setelah `git worktree add` sukses, jadi
 * kegagalan git tidak meninggalkan owner hantu untuk branch tersebut.
 */
export function createWorktreeService(options: WorktreeOptions): WorktreeService {
  const root = resolve(options.root)
  if (!isAbsolute(options.root)) {
    throw new WorktreeError('invalid_root', `root must be absolute: ${options.root}`)
  }
  const exec = options.exec
  const now = options.now ?? (() => Date.now())
  const defaultBaseRef = options.defaultBaseRef ?? 'HEAD'
  const byTask = new Map<string, WorktreeAllocation>()
  const branchOwner = new Map<string, string>()

  async function allocate(input: AllocateWorktreeInput): Promise<WorktreeAllocation> {
    const taskId = assertValidTaskId(input.taskId)
    const branch = assertValidBranch(input.branch)
    const repo = assertRepo(input.repo)
    const baseRef = assertBaseRef(input.baseRef ?? defaultBaseRef)
    if (typeof input.owner !== 'string' || input.owner.trim() === '') {
      throw new WorktreeError('invalid_owner', 'worktree owner must be a non-empty string')
    }
    if (byTask.has(taskId)) {
      throw new WorktreeError('task_in_use', `task ${taskId} already owns a worktree`)
    }
    const holder = branchOwner.get(branch)
    if (holder !== undefined) {
      throw new WorktreeError('branch_in_use', `branch ${branch} is already owned by task ${holder}`)
    }
    const path = assertSafeWorktreeTarget(root, join(root, `task-${taskId}`))
    const result = await exec('git', ['-C', repo, 'worktree', 'add', '-b', branch, path, baseRef])
    if (result.code !== 0) {
      throw new WorktreeError('git_failed', `git worktree add failed: ${detail(result)}`)
    }
    const allocation: WorktreeAllocation = {
      taskId,
      branch,
      path,
      repo,
      owner: input.owner,
      createdAt: now(),
    }
    byTask.set(taskId, allocation)
    branchOwner.set(branch, taskId)
    return allocation
  }

  async function release(input: ReleaseWorktreeInput): Promise<WorktreeAllocation> {
    const taskId = assertValidTaskId(input.taskId)
    const allocation = byTask.get(taskId)
    if (!allocation) throw new WorktreeError('not_found', `no worktree allocated for task ${taskId}`)
    if (input.branch !== undefined && input.branch !== allocation.branch) {
      throw new WorktreeError(
        'not_found',
        `task ${taskId} owns branch ${allocation.branch}, not ${input.branch}`
      )
    }
    // Root bisa berubah antar test/wiring; path tersimpan tetap divalidasi ulang.
    const path = assertInsideRoot(root, allocation.path)
    const stale = symlinkProblem(path)
    if (stale !== null) throw new WorktreeError(stale.code, stale.message)
    const result = await exec('git', [
      '-C',
      allocation.repo,
      'worktree',
      'remove',
      '--force',
      path,
    ])
    if (result.code !== 0) {
      throw new WorktreeError('git_failed', `git worktree remove failed: ${detail(result)}`)
    }
    byTask.delete(taskId)
    branchOwner.delete(allocation.branch)
    return allocation
  }

  return {
    allocate,
    release,
    get: (taskId) => byTask.get(taskId),
    list: () => [...byTask.values()],
  }
}
