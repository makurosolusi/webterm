// Git source version for tool_cache. Separate from toolCache.ts because knowledgeFresh pulls bun:sqlite at
// runtime, and toolCache.ts must stay importable from vitest (node) tests.
import { readGitState } from '../knowledge/knowledgeFresh'

/**
 * Working-tree version of the repo at top-level `root`: HEAD plus a hash of `git status` with the
 * mtime+size of every dirty or untracked file (knowledgeFresh.readGitState), so a commit, a stage, an
 * unstaged edit, a second edit of a dirty file and a new file all change it.
 */
export async function gitTreeVersion(root: string): Promise<string> {
  const s = await readGitState(root)
  if (!s.isGit) throw new Error(`gitTreeVersion: ${root} is not a git work tree`)
  return `${s.head ?? 'unborn'}:${s.dirtyHash}`
}
