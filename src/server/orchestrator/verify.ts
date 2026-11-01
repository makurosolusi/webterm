// Verifikasi independen P3 (RND/03-RENCANA.md §8, 07-IMPLEMENTASI-P3-P5.md P3-5): server yang
// menjalankan git/test, bukan payload worker. Command hanya lewat allowlist argv (tanpa shell),
// cwd wajib di dalam root worktree, ada timeout + output cap, dan yang disimpan hanya digest.
// Runner proses + helper hasil worker ada di `verifier.ts`; tabel command server-owned ada di
// `verifyCommands.ts`. Tiap modul tetap < 300 baris.
import { isAbsolute, resolve } from 'node:path'
import { realPathInsideRoot } from './safePath'
import { isInsideRoot } from './worktree'
import { SERVER_VERIFIED_BY, type ServerVerifiedBy } from './orchestratorModel'
import {
  type CheckId,
  type CommandResolution,
  type ConfiguredCommand,
  DEFAULT_EXECUTABLES,
  GIT_COMMANDS,
  baseDiffCommands,
  resolveBaseRef,
  resolveCommand,
} from './verifyCommands'
import { type RawRun, parseChangedFiles, parseNameOnly, parseTestCounts, runCommand } from './verifier'

// `CheckId`/`ConfiguredCommand` are part of this module's public surface; the tables live in
// `verifyCommands.ts` so this file stays under the line budget.
export type { CheckId, ConfiguredCommand } from './verifyCommands'

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

export interface VerifyOptions {
  /** Root worktree (absolut). Semua cwd harus di dalamnya. */
  root: string
  exec: VerifyExec
  timeoutMs?: number
  maxOutputBytes?: number
  /**
   * Command test/typecheck/lint. SERVER CONFIG ONLY: never populated from a worker payload
   * (`VerifyInput` cannot carry commands, and `verify.ts` rejects such keys outright).
   */
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
  /**
   * Base ref worktree (server-validated oleh `parseRunBody`, bukan perintah worker). Dipakai untuk
   * melihat perubahan yang sudah di-commit; `HEAD`/kosong jatuh ke `HEAD^`.
   */
  baseRef?: string
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 30 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DIFF_STAT_LIMIT = 4096

/**
 * Fields a worker payload is allowed to influence. `commands`, `args`, `env` and friends are NOT
 * part of `VerifyInput`; this list makes a hand-rolled or forward-compatible payload fail loudly
 * instead of being silently ignored (RND/qc/p3-security.md M4).
 */
const WORKER_CONTROLLED_KEYS = ['commands', 'command', 'args', 'argv', 'exec', 'env', 'shell'] as const

export interface VerifyOutcome {
  /** Bukti verdict dibuat `verifyWorktree` di server; disalin `toModelEvidence`. */
  verifiedBy: ServerVerifiedBy
  ok: boolean
  reasons: string[]
  evidence: VerificationEvidence[]
  changedFiles: string[]
  scopeViolations: string[]
  diffStat?: string
  tests?: { passed: number; failed: number; command: string }
  typecheck?: { ok: boolean; command: string }
}

/** Satu-satunya konstruktor `VerifyOutcome`: marker server tidak bisa terlupa di return mana pun. */
function verdict(outcome: Omit<VerifyOutcome, 'verifiedBy'>): VerifyOutcome {
  return { verifiedBy: SERVER_VERIFIED_BY, ...outcome }
}

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
  // Lexical containment is not enough: a symlinked subdirectory can point anywhere.
  if (!realPathInsideRoot(resolve(base), resolved)) {
    throw new VerifyError(
      'invalid_cwd',
      `cwd ${resolved} escapes worktree root ${resolve(base)} through a symlink`
    )
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
  const resolved: CommandResolution = resolveCommand(id, configured, allowed)
  if (!resolved.ok) throw new VerifyError('invalid_command', resolved.message)
  return resolved.command
}

/**
 * Jalankan verifikasi independen: git status/diff, scope check, lalu command test/typecheck/lint.
 * Verdict pass hanya bila git sukses, tanpa scope violation, semua check exit 0, dan test lulus.
 */
export async function verifyWorktree(options: VerifyOptions, input: VerifyInput): Promise<VerifyOutcome> {
  if (!options || typeof options.exec !== 'function') {
    throw new VerifyError('invalid_input', 'verify options.exec is required')
  }
  for (const key of WORKER_CONTROLLED_KEYS) {
    if (key in (input as unknown as Record<string, unknown>)) {
      throw new VerifyError(
        'invalid_input',
        `verify input must not carry "${key}": commands come from server config only`
      )
    }
  }
  const cwd = resolveVerifyCwd(options.root, input.cwd)
  const scope = normalizeScope(input.scope)
  // Divalidasi sebelum command apa pun: ref buruk ditolak, bukan diteruskan ke git.
  const base = resolveBaseRef(input.baseRef)
  if (!base.ok) throw new VerifyError('invalid_input', base.message)
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
    return verdict({ ok: false, reasons: gitReasons, evidence, changedFiles: [], scopeViolations: [] })
  }

  /*
   * A worker that committed its work leaves a clean worktree, so `git status`/`git diff` see
   * nothing. Compare against the base ref too (argv only, never a worker command). A missing
   * parent (root commit) or unknown ref is NOT fatal: the base diff is simply empty.
   */
  for (const [id, args] of Object.entries(baseDiffCommands(base.ref))) {
    const run = await runCommand({ file: 'git', args: [...args] }, cwd, options.exec, limits, now)
    runs.set(id, run)
    evidence.push(run.evidence)
  }

  const baseNames = runs.get('baseNames')
  const committedFiles = baseNames?.evidence.exitCode === 0 ? parseNameOnly(baseNames.output) : []
  const baseStat = runs.get('baseStat')
  const committedStat = baseStat?.evidence.exitCode === 0 ? baseStat.output : ''
  const changedFiles = Array.from(
    new Set([
      ...parseChangedFiles(runs.get('status')?.output ?? ''),
      ...parseNameOnly(runs.get('names')?.output ?? ''),
      ...committedFiles,
    ])
  ).sort()
  const scopeViolations = changedFiles.filter((file) => !inScope(file, scope))
  const diffStat = `${runs.get('diffStat')?.output ?? ''}${committedStat}`.slice(0, DIFF_STAT_LIMIT)
  if (scopeViolations.length > 0) {
    return verdict({
      ok: false,
      reasons: scopeViolations.map((file) => `scope violation: ${file}`),
      evidence,
      changedFiles,
      scopeViolations,
      diffStat,
    })
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

  return verdict({ ok: reasons.length === 0, reasons, evidence, changedFiles, scopeViolations, diffStat, tests, typecheck })
}
