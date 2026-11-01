// Verifikasi independen P3 (RND/03-RENCANA.md §8, 07-IMPLEMENTASI-P3-P5.md P3-5): server yang
// menjalankan git/test, bukan payload worker. Command hanya lewat allowlist argv (tanpa shell),
// cwd wajib di dalam root worktree, ada timeout + output cap, dan yang disimpan hanya digest.
// Runner proses + helper hasil worker ada di `verifier.ts` agar tiap modul tetap < 300 baris.
import { isAbsolute, resolve } from 'node:path'
import { isInsideRoot } from './worktree'
import { type RawRun, parseChangedFiles, parseNameOnly, parseTestCounts, runCommand } from './verifier'

export type VerifyErrorCode =
  | 'invalid_root'
  | 'invalid_cwd'
  | 'invalid_command'
  | 'invalid_scope'
  | 'invalid_input'

export class VerifyError extends Error {
  constructor(
    readonly code: VerifyErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'VerifyError'
  }
}

export interface VerifyExecOptions {
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
}

export interface VerifyExecResult {
  code: number
  stdout?: string
  stderr?: string
  timedOut?: boolean
  truncated?: boolean
}

/** `(file, args, options)` seperti spawn tanpa shell; produksi memakai `createProcessExec`. */
export type VerifyExec = (
  file: string,
  args: string[],
  options: VerifyExecOptions
) => VerifyExecResult | Promise<VerifyExecResult>

/** Satu command yang dijalankan server. Output mentah tidak pernah masuk ledger. */
export interface VerificationEvidence {
  command: string
  exitCode: number
  durationMs: number
  outputDigest: string
  summary: string
}

export type CheckId = 'test' | 'typecheck' | 'lint'

export interface ConfiguredCommand {
  file: string
  args: string[]
}

export interface VerifyOptions {
  /** Root worktree (absolut). Semua cwd harus di dalamnya. */
  root: string
  exec: VerifyExec
  timeoutMs?: number
  maxOutputBytes?: number
  /** Command test/typecheck/lint; default `npm test` / `npm run typecheck|lint`. */
  commands?: Partial<Record<CheckId, ConfiguredCommand>>
  /** Executable yang boleh dipakai command terkonfigurasi. */
  allowedExecutables?: readonly string[]
  /** Jam injeksi untuk durasi deterministik di test. */
  now?: () => number
}

export interface VerifyInput {
  /** Absolute, atau relatif terhadap `options.root`. */
  cwd: string
  /** Scope path relatif dari plan item; kosong berarti tidak ada batas file. */
  scope?: readonly string[]
  /** Default: test + typecheck aktif, lint opt-in. */
  checks?: Partial<Record<CheckId, boolean>>
}

export interface VerifyOutcome {
  ok: boolean
  reasons: string[]
  evidence: VerificationEvidence[]
  changedFiles: string[]
  scopeViolations: string[]
  diffStat?: string
  tests?: { passed: number; failed: number; command: string }
  typecheck?: { ok: boolean; command: string }
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 30 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_ARGS = 64
const MAX_ARG_LENGTH = 500
const DIFF_STAT_LIMIT = 4096
const DEFAULT_EXECUTABLES = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'node'] as const
const DEFAULT_COMMANDS: Record<CheckId, ConfiguredCommand> = {
  test: { file: 'npm', args: ['test'] },
  typecheck: { file: 'npm', args: ['run', 'typecheck'] },
  lint: { file: 'npm', args: ['run', 'lint'] },
}
/** Argv tetap, tidak pernah diambil dari task/plan, jadi tidak ada interpolasi data task. */
const GIT_COMMANDS = {
  status: ['status', '--porcelain'],
  names: ['diff', '--name-only'],
  diffStat: ['diff', '--stat'],
} as const

function requireText(value: unknown, code: VerifyErrorCode, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VerifyError(code, `${label} must be a non-empty string`)
  }
  return value
}

function positiveInt(value: number | undefined, fallback: number, label: string, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) {
    throw new VerifyError('invalid_input', `${label} must be a positive integer, got ${value}`)
  }
  return Math.min(value, max)
}

/** Cwd harus resolve di dalam root; `..` dan path absolut luar ditolak sebelum exec. */
export function resolveVerifyCwd(root: string, cwd: string): string {
  const base = requireText(root, 'invalid_root', 'root')
  if (!isAbsolute(base)) throw new VerifyError('invalid_root', `root must be absolute: ${base}`)
  const resolved = resolve(resolve(base), requireText(cwd, 'invalid_cwd', 'cwd'))
  if (!isInsideRoot(resolve(base), resolved)) {
    throw new VerifyError('invalid_cwd', `cwd ${resolved} is outside worktree root ${resolve(base)}`)
  }
  return resolved
}

/** Scope plan: relatif, tanpa `..`, tanpa path absolut; trailing `/**` dianggap prefix. */
export function normalizeScope(scope: readonly string[] | undefined): string[] {
  if (scope === undefined) return []
  if (!Array.isArray(scope)) throw new VerifyError('invalid_scope', 'scope must be an array')
  const result: string[] = []
  for (const raw of scope) {
    if (typeof raw !== 'string') throw new VerifyError('invalid_scope', 'scope entry must be a string')
    const entry = raw
      .trim()
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/\/+$/, '')
      .replace(/\/\*{1,2}$/, '')
    if (entry === '' || entry === '.') {
      throw new VerifyError('invalid_scope', `scope entry must not be empty: ${JSON.stringify(raw)}`)
    }
    if (entry.startsWith('/') || /^[A-Za-z]:\//.test(entry)) {
      throw new VerifyError('invalid_scope', `scope entry must be relative, got ${entry}`)
    }
    if (entry.includes('\u0000') || entry.split('/').includes('..')) {
      throw new VerifyError('invalid_scope', `scope entry escapes the worktree: ${entry}`)
    }
    if (!result.includes(entry)) result.push(entry)
  }
  return result
}

function inScope(file: string, scope: string[]): boolean {
  if (scope.length === 0) return true
  const path = file.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  return scope.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

/** Command terkonfigurasi harus executable allowlist + argv bersih; selain itu ditolak. */
function commandOf(
  id: CheckId,
  configured: ConfiguredCommand | undefined,
  allowed: readonly string[]
): ConfiguredCommand {
  const command = configured ?? DEFAULT_COMMANDS[id]
  if (!command || typeof command.file !== 'string' || !allowed.includes(command.file)) {
    throw new VerifyError(
      'invalid_command',
      `${id} command rejected: executable ${JSON.stringify(command?.file)} is not allowlisted`
    )
  }
  if (!Array.isArray(command.args) || command.args.length > MAX_ARGS) {
    throw new VerifyError('invalid_command', `${id} command rejected: unsupported argument list`)
  }
  for (const arg of command.args) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || /[\u0000-\u001f]/.test(arg)) {
      throw new VerifyError('invalid_command', `${id} command rejected: invalid argument`)
    }
  }
  return { file: command.file, args: [...command.args] }
}

/**
 * Jalankan verifikasi independen: git status/diff, scope check, lalu command test/typecheck/lint.
 * Verdict pass hanya bila git sukses, tanpa scope violation, semua check exit 0, dan test lulus.
 */
export async function verifyWorktree(options: VerifyOptions, input: VerifyInput): Promise<VerifyOutcome> {
  if (!options || typeof options.exec !== 'function') {
    throw new VerifyError('invalid_input', 'verify options.exec is required')
  }
  const cwd = resolveVerifyCwd(options.root, input.cwd)
  const scope = normalizeScope(input.scope)
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs', MAX_TIMEOUT_MS)
  const maxOutputBytes = positiveInt(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    'maxOutputBytes',
    MAX_OUTPUT_BYTES
  )
  const allowed = options.allowedExecutables ?? DEFAULT_EXECUTABLES
  const now = options.now ?? Date.now
  const limits = { timeoutMs, maxOutputBytes }
  const checks = {
    test: input.checks?.test ?? true,
    typecheck: input.checks?.typecheck ?? true,
    lint: input.checks?.lint ?? false,
  }
  const evidence: VerificationEvidence[] = []
  const runs = new Map<string, RawRun>()
  const gitReasons: string[] = []
  for (const [id, args] of Object.entries(GIT_COMMANDS)) {
    const run = await runCommand({ file: 'git', args: [...args] }, cwd, options.exec, limits, now)
    runs.set(id, run)
    evidence.push(run.evidence)
    if (run.evidence.exitCode !== 0) gitReasons.push(`git ${args.join(' ')} exited ${run.evidence.exitCode}`)
  }
  if (gitReasons.length > 0) {
    return { ok: false, reasons: gitReasons, evidence, changedFiles: [], scopeViolations: [] }
  }

  const changedFiles = [
    ...new Set([
      ...parseChangedFiles(runs.get('status')?.output ?? ''),
      ...parseNameOnly(runs.get('names')?.output ?? ''),
    ]),
  ].sort()
  const scopeViolations = changedFiles.filter((file) => !inScope(file, scope))
  const diffStat = runs.get('diffStat')?.output.slice(0, DIFF_STAT_LIMIT) ?? ''
  if (scopeViolations.length > 0) {
    return {
      ok: false,
      reasons: scopeViolations.map((file) => `scope violation: ${file}`),
      evidence,
      changedFiles,
      scopeViolations,
      diffStat,
    }
  }

  const reasons: string[] = []
  let tests: VerifyOutcome['tests']
  let typecheck: VerifyOutcome['typecheck']
  for (const id of ['test', 'typecheck', 'lint'] as const) {
    if (!checks[id]) continue
    const run = await runCommand(commandOf(id, options.commands?.[id], allowed), cwd, options.exec, limits, now)
    evidence.push(run.evidence)
    const failed = run.evidence.exitCode !== 0
    if (failed) reasons.push(`${run.evidence.command} exited ${run.evidence.exitCode}`)
    if (id === 'test') {
      const counts = parseTestCounts(run.output)
      if (failed) {
        tests = { passed: counts?.passed ?? 0, failed: Math.max(1, counts?.failed ?? 0), command: run.evidence.command }
      } else if (counts && counts.passed === 0) {
        tests = { ...counts, command: run.evidence.command }
        reasons.push(`${run.evidence.command} reported 0 passing tests`)
      } else {
        tests = { ...(counts ?? { passed: 1, failed: 0 }), command: run.evidence.command }
      }
    } else if (id === 'typecheck') {
      typecheck = { ok: !failed, command: run.evidence.command }
    }
  }

  return { ok: reasons.length === 0, reasons, evidence, changedFiles, scopeViolations, diffStat, tests, typecheck }
}
