// Server-owned command configuration for the verifier (QC M4). Nothing here is derived from a
// worker payload: the executable must be on the allowlist and the argv is fixed, so task/plan text
// can never become a command (and there is no shell to interpolate into).
//
// Resolution problems are returned as data; `VerifyError` lives in `verify.ts` to avoid a cycle.

export type CheckId = 'test' | 'typecheck' | 'lint'

export interface ConfiguredCommand {
  file: string
  args: string[]
}

export const MAX_ARGS = 64
export const MAX_ARG_LENGTH = 500
export const DEFAULT_EXECUTABLES = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'node'] as const
export const DEFAULT_COMMANDS: Record<CheckId, ConfiguredCommand> = {
  test: { file: 'npm', args: ['test'] },
  typecheck: { file: 'npm', args: ['run', 'typecheck'] },
  lint: { file: 'npm', args: ['run', 'lint'] },
}
/** Argv tetap, tidak pernah diambil dari task/plan, jadi tidak ada interpolasi data task. */
export const GIT_COMMANDS = {
  status: ['status', '--porcelain'],
  names: ['diff', '--name-only'],
  diffStat: ['diff', '--stat'],
} as const

/**
 * Fallback when the caller has no base ref: a worker that committed its work leaves a clean
 * worktree, so comparing against the parent of HEAD still surfaces that change.
 */
export const DEFAULT_BASE_REF = 'HEAD^'
export const MAX_BASE_REF_CHARS = 200

/**
 * Ref validation for the base diff. The ref becomes a git argv entry (never shell), but a leading
 * `-` or whitespace would still be parsed as an option/extra argument, and `^`/`~` would let the
 * caller reach arbitrary revisions. Callers pass refs validated by `parseRunBody`, so this is a
 * second line of defence.
 */
export function baseRefProblem(ref: string): string | null {
  if (typeof ref !== 'string' || ref.trim() === '') return 'baseRef must be a non-empty string'
  if (ref !== ref.trim()) return 'baseRef must not have surrounding whitespace'
  if (ref.length > MAX_BASE_REF_CHARS) return 'baseRef is too long'
  if (/[\u0000-\u001f\u007f]/.test(ref)) return 'baseRef must not contain control characters'
  if (ref.startsWith('-')) return 'baseRef must not start with "-"'
  if (ref.includes('..') || /[\s~^:?*[\\]/.test(ref)) return 'baseRef contains a character git rejects'
  return null
}

/**
 * `HEAD` must not become the comparison base: the worktree branch was created from it, so
 * `HEAD...HEAD` is always empty. Resolve an absent/`HEAD` base to the `HEAD^` fallback.
 */
export function resolveBaseRef(
  raw: unknown
): { ok: true; ref: string } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, ref: DEFAULT_BASE_REF }
  if (typeof raw !== 'string') return { ok: false, message: 'baseRef must be a string' }
  const ref = raw.trim()
  if (ref === '' || ref === 'HEAD') return { ok: true, ref: DEFAULT_BASE_REF }
  const problem = baseRefProblem(ref)
  return problem === null ? { ok: true, ref } : { ok: false, message: problem }
}

/**
 * Argv for `baseRef...HEAD` (merge-base diff): name-only for the file list, stat for the summary.
 * The trailing `--` terminates revisions so nothing after the ref can be read as a path.
 */
export function baseDiffCommands(baseRef: string): {
  baseNames: string[]
  baseStat: string[]
} {
  const range = `${baseRef}...HEAD`
  return {
    baseNames: ['diff', '--name-only', range, '--'],
    baseStat: ['diff', '--stat', range, '--'],
  }
}

export type CommandResolution =
  | { ok: true; command: ConfiguredCommand }
  | { ok: false; message: string }

/** Configured executable must be allowlisted and its argv clean; anything else is rejected. */
export function resolveCommand(
  id: CheckId,
  configured: ConfiguredCommand | undefined,
  allowed: readonly string[]
): CommandResolution {
  const command = configured ?? DEFAULT_COMMANDS[id]
  if (!command || typeof command.file !== 'string' || !allowed.includes(command.file)) {
    return {
      ok: false,
      message: `${id} command rejected: executable ${JSON.stringify(command?.file)} is not allowlisted`,
    }
  }
  if (!Array.isArray(command.args) || command.args.length > MAX_ARGS) {
    return { ok: false, message: `${id} command rejected: unsupported argument list` }
  }
  for (const arg of command.args) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || /[\u0000-\u001f]/.test(arg)) {
      return { ok: false, message: `${id} command rejected: invalid argument` }
    }
  }
  return { ok: true, command: { file: command.file, args: [...command.args] } }
}
