// "New workspace from worktree" (PLAN/rnd/05-ide-parity.md G3), imitating Orca worktrees
// (docs/site/content/docs/model/worktrees.mdx): every task gets its own branch + checkout, the branch
// name is derived from the task title, deleting asks for confirmation and a branch with unmerged work
// is kept. Location follows Orca's nested layout `<workspaceDir>/<repo>/<name>` (worktree-logic.ts
// `computeWorktreePath`) under webterm's own `<dataDir>/worktrees`, the root the orchestrator already
// uses and that the agent sandbox keeps readable/writable (agentSandbox.ts AGENT_READABLE_ENTRIES).
//
// Validation reuses orchestrator/worktree.ts (branch rules, base-ref rules, symlink-safe target).
// Removal never passes `--force` unless the caller confirmed, and only deletes the branch with
// `git branch -d` when asked (never `-D`): unmerged work stays reachable.
import { execFile } from 'node:child_process'
import { gitCommand } from './gitExec'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { dataDir } from './config'
import { assertBaseRef, assertSafeWorktreeTarget, branchProblem, isInsideRoot, WorktreeError } from './orchestrator/worktree'
import { symlinkProblem } from './orchestrator/worktreeTarget'
import { copyWorktreeIncludes, runSetupScript, SETUP_TIMEOUT_MS, type IncludeResult, type SetupResult } from './workspaceWorktree.setup'

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 10_000
const ADD_TIMEOUT_MS = 120_000 // checkout of a large repo
const MAX_SUFFIX = 100
const DIRTY_LIST_MAX = 20

export interface WorktreeDeps {
  /** Absolute root for webterm-owned worktrees; default `<dataDir>/worktrees`. */
  root?: string
  setupTimeoutMs?: number
}

export interface CreateWorktreeInput {
  /** Any path inside the repo (the active workspace cwd). */
  repo: string
  /** Task title; the branch name is derived from it when `branch` is empty. */
  title: string
  branch?: string
  /** Start-from ref; default the repo's current branch. */
  base?: string
  runSetup?: boolean
}

export interface CreatedWorktree {
  path: string
  branch: string
  base: string
  primary: string
  includes: IncludeResult
  setup: SetupResult
}

export interface WorktreeStatus {
  managed: boolean
  path?: string
  branch?: string | null
  /** `git status --porcelain` lines (first 20) and their total count. */
  dirty?: string[]
  dirtyCount?: number
  /** Commits on HEAD not reachable from any other branch or any remote. */
  unpushed?: number
}

export type RemoveWorktreeResult =
  | { removed: false; needsConfirm: true; status: WorktreeStatus }
  | { removed: true; path: string; branch: string | null; branchDeleted: boolean; branchNote?: string }

export function worktreeRoot(deps: WorktreeDeps = {}): string {
  const root = resolve(deps.root ?? join(dataDir(), 'worktrees'))
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return realpathSync(root) // git reports real paths (macOS /tmp → /private/tmp)
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const g = gitCommand(['-C', cwd, ...args])
    const { stdout } = await run(g.file, g.args, { timeout, maxBuffer: 16 * 1024 * 1024, env: g.env })
    return stdout.trim()
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '').trim()
    throw new WorktreeError('git_failed', `git ${args.join(' ')} in ${cwd} failed: ${stderr || String(err)}`, err)
  }
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  return git(cwd, args).then(() => true, () => false)
}

/** Primary checkout of the repo containing `cwd` (works from a linked worktree too). */
async function primaryCheckout(cwd: string): Promise<string> {
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch((err) => {
    throw new WorktreeError('invalid_repo', `${cwd} is not inside a git repository`, err)
  })
  if (basename(common) !== '.git') throw new WorktreeError('invalid_repo', `bare repositories are not supported: ${common}`)
  return dirname(common)
}

/** Branch-safe slug of a task title, after Orca `sanitizeWorktreeName` (ASCII: branchProblem's rules). */
export function branchSlug(title: string): string {
  const slug = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/\.{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '')
    .replace(/\.lock$/, '')
  return slug.slice(0, 80).replace(/[._-]+$/, '') || 'workspace'
}

const dirNameOf = (branch: string) => branch.replace(/\//g, '-')

async function branchExists(primary: string, branch: string): Promise<boolean> {
  return gitOk(primary, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
}

/** First free `<slug>`, `<slug>-2`, … that is neither a branch nor an existing directory. */
async function freeBranch(primary: string, parent: string, wanted: string, explicit: boolean): Promise<string> {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const candidate = n === 1 ? wanted : `${wanted}-${n}`
    const taken = (await branchExists(primary, candidate)) || existsSync(join(parent, dirNameOf(candidate)))
    if (!taken) return candidate
    if (explicit) throw new WorktreeError('branch_in_use', `branch ${wanted} already exists or has a worktree`)
  }
  throw new WorktreeError('branch_in_use', `no free branch name for ${wanted} after ${MAX_SUFFIX} tries`)
}

/** `git worktree add -b <branch>` under the webterm root, then `.worktreeinclude` + setup script. */
export async function createWorkspaceWorktree(input: CreateWorktreeInput, deps: WorktreeDeps = {}): Promise<CreatedWorktree> {
  const root = worktreeRoot(deps)
  const primary = await primaryCheckout(resolve(input.repo))
  const explicit = typeof input.branch === 'string' && input.branch.trim() !== ''
  const wanted = explicit ? input.branch!.trim() : branchSlug(input.title)
  const problem = branchProblem(wanted)
  if (problem) throw new WorktreeError('invalid_branch', problem)
  let base = input.base?.trim() || await git(resolve(input.repo), ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (base === 'HEAD') base = await git(resolve(input.repo), ['rev-parse', 'HEAD']) // detached: start from the commit
  assertBaseRef(base)
  if (!(await gitOk(primary, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]))) {
    throw new WorktreeError('invalid_base', `base ${base} is not a commit in ${primary}`)
  }
  const parent = join(root, basename(primary))
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const branch = await freeBranch(primary, parent, wanted, explicit)
  const path = assertSafeWorktreeTarget(root, join(parent, dirNameOf(branch)))
  await git(primary, ['worktree', 'add', '-b', branch, path, base], ADD_TIMEOUT_MS)
  const includes = await copyWorktreeIncludes(primary, path)
  const setup = input.runSetup === false
    ? { source: null, ran: false, ok: true, timedOut: false, exitCode: null, output: '' }
    : await runSetupScript(primary, path, deps.setupTimeoutMs ?? SETUP_TIMEOUT_MS)
  return { path, branch, base, primary, includes, setup }
}

/** Branch, dirty files and unpushed commits of a webterm-managed worktree; `managed: false` otherwise. */
export async function worktreeStatus(path: string, deps: WorktreeDeps = {}): Promise<WorktreeStatus> {
  const root = worktreeRoot(deps)
  if (!existsSync(path)) return { managed: false }
  const top = await git(path, ['rev-parse', '--show-toplevel']).catch(() => null)
  if (!top || !isInsideRoot(root, top) || resolve(top) === root) return { managed: false }
  const gitDir = await git(top, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const common = await git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (gitDir === common) return { managed: false } // a primary checkout that happens to live here
  const head = await git(top, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = head === 'HEAD' ? null : head
  const lines = (await git(top, ['status', '--porcelain'])).split('\n').filter(Boolean)
  const others = branch ? [`--exclude=${branch}`, '--branches'] : ['--branches']
  const unpushed = Number(await git(top, ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...others]))
  return { managed: true, path: top, branch, dirty: lines.slice(0, DIRTY_LIST_MAX), dirtyCount: lines.length, unpushed }
}

/**
 * Remove a webterm-managed worktree. Uncommitted or unpushed work → `needsConfirm` unless `confirm`;
 * `--force` only for a confirmed dirty tree. The branch is kept unless `deleteBranch`, and even then
 * `git branch -d` refuses unmerged work (reported in `branchNote`, like Orca's preserved branches).
 */
export async function removeWorkspaceWorktree(
  input: { path: string; confirm?: boolean; deleteBranch?: boolean },
  deps: WorktreeDeps = {}
): Promise<RemoveWorktreeResult> {
  const status = await worktreeStatus(input.path, deps)
  if (!status.managed || !status.path) throw new WorktreeError('not_found', `${input.path} is not a webterm-managed worktree`)
  const dirty = (status.dirtyCount ?? 0) > 0
  if ((dirty || (status.unpushed ?? 0) > 0) && input.confirm !== true) return { removed: false, needsConfirm: true, status }
  const stale = symlinkProblem(status.path)
  if (stale) throw new WorktreeError(stale.code, stale.message)
  const primary = await primaryCheckout(status.path)
  await git(primary, ['worktree', 'remove', ...(dirty ? ['--force'] : []), status.path])
  const branch = status.branch ?? null
  if (!input.deleteBranch || !branch) return { removed: true, path: status.path, branch, branchDeleted: false }
  try {
    await git(primary, ['branch', '-d', branch])
    return { removed: true, path: status.path, branch, branchDeleted: true }
  } catch (err) {
    return { removed: true, path: status.path, branch, branchDeleted: false, branchNote: `Branch ${branch} kept: ${err instanceof Error ? err.message : String(err)}` }
  }
}
