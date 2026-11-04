// Wire contract of `/api/git/diff*`, shared by the server route and the Diff node. Types and
// constants only (no node imports), so the client can import it without pulling server code.
// Shape imitates Orca `src/shared/git-diff-compare-types.ts` (GitBranchChangeEntry + GitDiffResult).

export const GIT_DIFF_PATH = '/api/git/diff'
export const GIT_DIFF_UNDO_PATH = '/api/git/diff/undo'

/** Default and maximum page size of the file list (Rule 13: every list endpoint paginates). */
export const GIT_DIFF_PAGE_DEFAULT = 200
export const GIT_DIFF_PAGE_MAX = 1000
/** Larger sides are not sent: Monaco on a multi-MB model freezes the canvas. Orca caps `git show` too. */
export const GIT_DIFF_FILE_MAX_BYTES = 1024 * 1024

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

/** One changed path, working tree against HEAD. */
export interface GitChange {
  path: string
  oldPath?: string
  status: GitChangeStatus
  binary: boolean
  /** Name looks like a secret (repoHygiene `isSensitivePath`): listed, contents never served. */
  sensitive: boolean
}

export interface GitDiffList {
  root: string
  files: GitChange[]
  total: number
  /** Offset of the next page, or null on the last one. */
  nextOffset: number | null
}

/** One hunk of `git diff -U3`; `id` is a digest of its patch text, so a changed file yields new ids. */
export interface GitHunk {
  id: string
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

export interface GitFileDiff extends GitChange {
  /** HEAD side and working-tree side; empty when not served (binary, sensitive, truncated). */
  original: string
  modified: string
  /** A side exceeds GIT_DIFF_FILE_MAX_BYTES, so no contents or hunks were sent. */
  truncated: boolean
  hunks: GitHunk[]
  /** Per-hunk Undo is offered (tracked text file that is modified or deleted). */
  undoable: boolean
}

export interface GitHunkUndoRequest { root: string; path: string; hunkId: string }
