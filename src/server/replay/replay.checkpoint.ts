// "Diff at that checkpoint" for the replay scrub state: what checkpoint N changed relative to
// checkpoint N-1 (read-only `git diff-tree` between the two stored trees). Listing and rewinding
// stay in checkpoint/ (this module never writes a ref, the index or a file).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listCheckpoints, PREVIEW_PATCH_MAX, repoOf, type Checkpoint, type FileChange } from '../checkpoint/checkpoint.git'
import { resolveFsPath } from '../fsOps'

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000

export interface CheckpointAt {
  seq: number
  ts: number
  reason: string
  /** Previous checkpoint the diff is taken against; null = first one (diff against nothing shown). */
  baseSeq: number | null
  files: FileChange[]
  patch: string
  truncated: boolean
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
    return (await run('git', ['-C', root, ...args], { env, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * PREVIEW_PATCH_MAX })).stdout
  } catch (err) {
    throw new Error(`replay: git ${args[0]} failed in ${root}`, { cause: err })
  }
}

/** Latest checkpoint taken at or before `t` (by its recorded ts); pure. */
export function checkpointBefore(list: readonly Checkpoint[], t: number): { target: Checkpoint; base: Checkpoint | null } | null {
  let target: Checkpoint | null = null
  let base: Checkpoint | null = null
  for (const c of [...list].sort((a, b) => a.seq - b.seq)) {
    if (c.ts > t) break
    base = target
    target = c
  }
  return target ? { target, base } : null
}

/** Checkpoint state at `t` for a workspace folder; null when there is none yet or no git repo. */
export async function checkpointAt(workspaceId: string, cwd: string | undefined, t: number): Promise<CheckpointAt | null> {
  if (!cwd) return null
  const repo = await repoOf(resolveFsPath(cwd))
  if (!repo) return null
  const hit = checkpointBefore(await listCheckpoints(repo, workspaceId), t)
  if (!hit) return null
  const { target, base } = hit
  const scope = repo.prefix || '.'
  const files: FileChange[] = []
  let patch = ''
  if (base) {
    const parts = (await git(repo.root, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', base.tree, target.tree, '--', scope])).split('\0').filter(Boolean)
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i] as FileChange['status'], path: parts[i + 1]! })
    if (files.length) patch = await git(repo.root, ['diff-tree', '-r', '-p', '--no-renames', '--no-color', '--no-ext-diff', base.tree, target.tree, '--', scope])
  }
  return {
    seq: target.seq, ts: target.ts, reason: target.reason, baseSeq: base?.seq ?? null,
    files, patch: patch.slice(0, PREVIEW_PATCH_MAX), truncated: patch.length > PREVIEW_PATCH_MAX,
  }
}
