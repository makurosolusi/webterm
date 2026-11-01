// Allocation/release target guards for the worktree service (QC L1). `git worktree add` writes
// through a symlink at the target path, and `git worktree remove` would then act on the link's
// victim, so both seams inspect the target with lstat and resolve the real path before git runs.
//
// Problems are returned as data instead of thrown: `WorktreeError` lives in `worktree.ts` and this
// module must stay import-cycle free.
import { lstatSync } from 'node:fs'
import { realPathOf, isInsideRoot } from './safePath'

export type WorktreeTargetProblemCode = 'unsafe_target' | 'outside_root'

export interface WorktreeTargetProblem {
  code: WorktreeTargetProblemCode
  message: string
}

/**
 * Rejects a target that exists as a symlink or as a non-directory, then verifies that the target's
 * real path (symlinks in the existing prefix resolved) is still inside the configured root.
 * `root` must already be an absolute, lexically validated worktree root.
 */
export function worktreeTargetProblem(root: string, path: string): WorktreeTargetProblem | null {
  let stat: ReturnType<typeof lstatSync> | undefined
  try {
    stat = lstatSync(path)
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      return { code: 'unsafe_target', message: `cannot inspect worktree target ${path}` }
    }
  }
  if (stat !== undefined) {
    if (stat.isSymbolicLink()) {
      return { code: 'unsafe_target', message: `refusing to allocate through symlink ${path}` }
    }
    if (!stat.isDirectory()) {
      return { code: 'unsafe_target', message: `${path} exists and is not a directory` }
    }
  }
  const realRoot = realPathOf(root)
  const realPath = realPathOf(path)
  if (!isInsideRoot(realRoot, realPath)) {
    return {
      code: 'outside_root',
      message: `real path ${realPath} is outside configured root ${realRoot}`,
    }
  }
  return null
}

/** Release must never operate through a symlink swapped in after allocation. */
export function symlinkProblem(path: string): WorktreeTargetProblem | null {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return { code: 'unsafe_target', message: `refusing to release through symlink ${path}` }
    }
  } catch {
    // ENOENT: nothing to remove; git reports the missing worktree itself.
  }
  return null
}
