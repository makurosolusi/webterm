// Symlink-aware path confinement shared by the worktree allocator and the verifier (QC L1/M4).
// Lexical `resolve()` checks are not enough: `git worktree add` and a child `cwd` both follow a
// symlink, so every seam that writes outside a configured root resolves the real path first.
import { existsSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

/** True when `target` is inside `root` (root itself counts as inside). Lexical comparison. */
export function isInsideRoot(root: string, target: string): boolean {
  const base = resolve(root)
  const path = resolve(target)
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * Real path of `path` even when the leaf does not exist yet: symlinks in the existing prefix are
 * resolved, the non-existent remainder is appended lexically. Falls back to the lexical path when
 * nothing on the way exists (unit tests use roots that are not on disk).
 */
export function realPathOf(path: string): string {
  const target = resolve(path)
  let ancestor = target
  for (;;) {
    if (existsSync(ancestor)) {
      const real = realpathSync(ancestor)
      const rest = relative(ancestor, target)
      return rest === '' ? real : resolve(real, rest)
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) return target
    ancestor = parent
  }
}

/**
 * True when the real path of `target` stays inside the real path of `root`, i.e. no symlink in the
 * existing chain redirects it elsewhere.
 */
export function realPathInsideRoot(root: string, target: string): boolean {
  return isInsideRoot(realPathOf(root), realPathOf(target))
}
