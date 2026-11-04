// Wire contract of `/api/git/scm/*` (Source Control panel, plan I2-a, ide-parity G2). Types, constants
// and the pure Rule 9 validator only (no node imports), so the client can import it.
// Shape imitates Orca `src/shared/git-status-*` (area = staged | unstaged | untracked) and VS Code's
// SCM resource groups (Staged Changes / Changes / Untracked).

export const SCM_PREFIX = '/api/git/scm'
export const SCM_STATUS_PATH = `${SCM_PREFIX}/status`
export const SCM_HUNKS_PATH = `${SCM_PREFIX}/hunks`
export const SCM_STAGE_PATH = `${SCM_PREFIX}/stage`
export const SCM_UNSTAGE_PATH = `${SCM_PREFIX}/unstage`
export const SCM_MESSAGE_PATH = `${SCM_PREFIX}/message`
export const SCM_COMMIT_PATH = `${SCM_PREFIX}/commit`
export const SCM_REPORT_PATH = `${SCM_PREFIX}/report`
export const SCM_PUSH_PATH = `${SCM_PREFIX}/push`
export const SCM_PR_PATH = `${SCM_PREFIX}/pr`

/** Per-group cap of the status listing (Rule 13); `total` tells the client how many exist. */
export const SCM_GROUP_MAX = 500

export type ScmArea = 'staged' | 'unstaged' | 'untracked'

export interface ScmEntry {
  path: string
  oldPath?: string
  /** One porcelain letter: M A D R C T U (U = unmerged), `?` for untracked. */
  code: string
  /** Name looks like a secret (repoHygiene `sensitivePattern`): never staged from the panel. */
  sensitive: boolean
  /** The secret pattern the name matched, shown as the refusal reason. */
  sensitivePattern?: string
}

export interface ScmGroup { entries: ScmEntry[]; total: number }

export interface ScmStatus {
  root: string
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: ScmGroup
  unstaged: ScmGroup
  untracked: ScmGroup
  /** `gh` is on PATH: the Create PR button is offered. */
  gh: boolean
}

export interface ScmHunk { id: string; header: string; text: string }

/** One pre-push check, Rule 6/18 style: a script that was actually run, or why it was not. */
export interface ScmCheck {
  name: string
  status: 'pass' | 'fail' | 'timeout' | 'skipped'
  /** The command that ran, or the skip reason. */
  detail: string
  durationMs: number
  /** Tail of stdout+stderr, credential-redacted. */
  output: string
}

export interface ScmFinding { path: string; line: number; text: string }

export interface ScmReport {
  root: string
  /** HEAD the report was made for; a new commit makes it stale. */
  head: string
  createdAt: number
  checks: ScmCheck[]
  /** Added lines holding a credential-shaped value (value never included). Blocks push, no override. */
  credentials: ScmFinding[]
  /** TODO/FIXME/XXX/HACK in added lines; `text` is the trimmed line. Listed, not a blocker (Rule 18). */
  debt: ScmFinding[]
  /** Every check passed or was skipped with a reason, and no credential finding. */
  green: boolean
}

export interface ScmCommitFailure {
  error: 'commit_failed'
  message: string
  /** Hook / git output, redacted. */
  output: string
  /** Repair prompt for "Fix with agent" (Orca source-control-commit-failure.ts). */
  fixPrompt: string
}

/** Rule 9 types; anything else is refused. */
export const COMMIT_TYPES = ['feat', 'fix', 'chore', 'refactor', 'test', 'docs', 'perf'] as const
export const COMMIT_SUBJECT_MAX = 100
const SUBJECT_RE = new RegExp(`^(${COMMIT_TYPES.join('|')})\\(([a-z0-9][a-z0-9._/-]*)\\): (\\S.*)$`)
/** Rule 9 examples of a generic description. */
const GENERIC = /^(fix(es|ed)? (a |the )?bugs?|update[sd]?|wip|changes?|misc|stuff|fix|tmp)\.?$/i

/** Why `message` breaks Rule 9 (`<type>(<scope>): <description>`), or null when it is fine. */
export function commitMessageProblem(message: string): string | null {
  const subject = message.split('\n')[0].trim()
  if (!subject) return 'Commit message is empty.'
  if (subject.length > COMMIT_SUBJECT_MAX) return `First line is longer than ${COMMIT_SUBJECT_MAX} characters.`
  const m = SUBJECT_RE.exec(subject)
  if (!m) return `First line must be "<type>(<scope>): <description>" with type one of ${COMMIT_TYPES.join(', ')}.`
  if (GENERIC.test(m[3].trim())) return 'Description is too generic; say what changed.'
  if (/\.$/.test(m[3])) return 'Drop the trailing period from the first line.'
  return null
}
