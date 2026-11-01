// Runtime verifikasi P3: runner proses (allowlist argv, timeout, output cap) dan helper yang
// mengubah verdict independen menjadi status ledger. Verifikasi tidak pernah percaya payload
// worker: `claimed_done` hanya naik ke `verified` lewat `verifyWorkerResult`.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  type ConfiguredCommand,
  type VerificationEvidence,
  type VerifyExec,
  type VerifyInput,
  type VerifyOutcome,
} from './verify'
import {
  type OrchestratorLedger,
  type OrchestratorResult,
  type OrchestratorTask,
  type VerificationEvidence as ModelEvidence,
  evidenceVerified,
} from './orchestratorModel'
import { deny } from './orchestratorSupport'

const TIMEOUT_EXIT = 124
const EXEC_FAILURE_EXIT = 127

export interface RawRun {
  result: { code: number; stdout?: string; stderr?: string; timedOut?: boolean; truncated?: boolean }
  output: string
  evidence: VerificationEvidence
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function capOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, truncated: false }
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

/**
 * Satu command: exec disuntik, deadline lokal menutup exec yang macet, output dipotong sebelum
 * di-digest (isi mentah tidak pernah keluar dari fungsi ini).
 */
export async function runCommand(
  spec: ConfiguredCommand,
  cwd: string,
  exec: VerifyExec,
  limits: { timeoutMs: number; maxOutputBytes: number },
  now: () => number
): Promise<RawRun> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<RawRun['result']>((settle) => {
    timer = setTimeout(() => settle({ code: TIMEOUT_EXIT, timedOut: true }), limits.timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  const started = now()
  const run = Promise.resolve()
    .then(() => exec(spec.file, spec.args, { cwd, ...limits }))
    .catch((err: unknown) => ({
      code: EXEC_FAILURE_EXIT,
      stderr: err instanceof Error ? err.message : String(err),
    }))
  let result: RawRun['result']
  try {
    result = await Promise.race([run, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const durationMs = Math.max(0, now() - started)
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const capped = capOutput(output, limits.maxOutputBytes)
  const exitCode = result.timedOut === true ? TIMEOUT_EXIT : result.code
  const lines = output === '' ? 0 : output.split('\n').filter((line) => line.trim() !== '').length
  const flags = [
    result.timedOut === true ? 'timed out' : '',
    result.truncated === true || capped.truncated ? 'truncated' : '',
  ].filter(Boolean)
  return {
    result,
    output,
    evidence: {
      command: [spec.file, ...spec.args].join(' '),
      exitCode,
      durationMs,
      outputDigest: sha256(capped.text),
      summary: [`exit ${exitCode}`, `${lines} lines`, ...flags].join(' · '),
    },
  }
}

/** `M  src/a.ts`, `?? baru.ts`, `R  lama -> baru`; rename dihitung pada path baru. */
export function parseChangedFiles(output: string): string[] {
  const files: string[] = []
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.length < 4) continue
    const body = line.slice(3)
    const arrow = body.lastIndexOf(' -> ')
    const path = arrow >= 0 ? body.slice(arrow + 4) : body
    files.push(path.length >= 2 && path.startsWith('"') && path.endsWith('"') ? unquote(path) : path)
  }
  return [...new Set(files)].sort()
}

export function parseNameOnly(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function unquote(path: string): string {
  try {
    return JSON.parse(path) as string
  } catch {
    return path.slice(1, -1)
  }
}

/** Test count dari output runner; tanpa ringkasan dianggap 1 lulus/0 gagal bila exit 0. */
export function parseTestCounts(output: string): { passed: number; failed: number } | null {
  const passed = /(\d+)\s+(?:passed|pass)\b/i.exec(output)
  if (!passed) return null
  const failed = /(\d+)\s+(?:failed|fail)\b/i.exec(output)
  return { passed: Number(passed[1]), failed: failed ? Number(failed[1]) : 0 }
}

/** Environment minimal: tanpa secret/credential dari proses induk. */
export function cleanEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  env.CI = '1'
  env.NO_COLOR = '1'
  return env
}

/** Exec produksi: `execFile` (shell: false), timeout + maxBuffer, env bersih. */
export function createProcessExec(source: NodeJS.ProcessEnv = process.env): VerifyExec {
  return (file, args, options) =>
    new Promise((resolveRun) => {
      execFile(
        file,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          maxBuffer: Math.max(1024, options.maxOutputBytes),
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          env: cleanEnv(source),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolveRun({ code: 0, stdout, stderr })
            return
          }
          const failure = error as { code?: number | string; killed?: boolean; signal?: string }
          const truncated = failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          const timedOut = failure.killed === true || failure.signal === 'SIGTERM'
          const code = typeof failure.code === 'number' ? failure.code : 1
          resolveRun({
            code: truncated || timedOut ? 1 : code,
            stdout,
            stderr,
            ...(timedOut ? { timedOut: true } : {}),
            ...(truncated ? { truncated: true } : {}),
          })
        }
      )
    })
}

export type VerifyModelEvidence = ModelEvidence & { commands: VerificationEvidence[] }

/** Bukti server (bukan klaim worker) dalam bentuk yang dipahami `evidenceVerified`. */
export function toModelEvidence(outcome: VerifyOutcome): VerifyModelEvidence {
  return {
    diffStat: outcome.diffStat,
    filesChanged: outcome.changedFiles,
    scopeViolations: outcome.scopeViolations,
    tests: outcome.tests,
    typecheck: outcome.typecheck,
    commands: outcome.evidence,
  }
}

export interface VerifyWorkerDeps {
  ledger: Pick<OrchestratorLedger, 'task' | 'event'>
  /** Closure yang menjalankan `verifyWorktree` dengan root/exec/config server. */
  verify: (input: VerifyInput) => Promise<VerifyOutcome>
}

export interface VerifyWorkerInput {
  projectId: string
  taskId: string
  /** Fence yang dipegang worker; ledger juga menolak fence basi saat `verifyTask`. */
  fence: number
  actor: string
  /** Path worktree untuk task ini. */
  cwd: string
  scope?: readonly string[]
  checks?: VerifyInput['checks']
}

export interface VerifyWorkerValue {
  task: OrchestratorTask
  verified: boolean
  verdict: VerifyOutcome
}

/**
 * `claimed_done` + evidence klaim wajib ada, lalu server menjalankan verifikasi sendiri.
 * Verifikasi gagal tidak menurunkan status (tetap `claimed_done`) dan tidak membuka approval;
 * hasilnya audit event `verify_failed` agar attempt berikutnya memakai evidence baru.
 */
export async function verifyWorkerResult(
  deps: VerifyWorkerDeps,
  input: VerifyWorkerInput
): Promise<OrchestratorResult<VerifyWorkerValue>> {
  const task = deps.ledger.task.getTask(input.taskId)
  if (!task) return deny('task_not_found', `task not found: ${input.taskId}`)
  if (task.projectId !== input.projectId) {
    return deny('project_mismatch', `task ${task.id} belongs to ${task.projectId}`)
  }
  if (task.fence !== input.fence) {
    return deny('stale_fence', `stale fence for task ${task.id}: caller ${input.fence}, row ${task.fence}`)
  }
  if (task.status !== 'claimed_done') {
    return deny('invalid_state', `task ${task.id} is ${task.status}; claim before verify`)
  }
  if (task.evidence === null || task.evidence === undefined) {
    return deny('invalid_state', `task ${task.id} is claimed_done without evidence`)
  }

  const verdict = await deps.verify({ cwd: input.cwd, scope: input.scope, checks: input.checks })
  const evidence = toModelEvidence(verdict)
  const verified = verdict.ok && evidenceVerified(evidence)
  const reasons = verified ? [] : verdict.reasons.length > 0 ? verdict.reasons : ['verification failed']
  const payload = {
    reasons,
    tests: verdict.tests,
    typecheck: verdict.typecheck,
    changedFiles: verdict.changedFiles.length,
    digests: verdict.evidence.map((entry) => entry.outputDigest),
  }
  if (!verified) {
    deps.ledger.event.appendEvent({
      projectId: input.projectId,
      taskId: task.id,
      actor: input.actor,
      kind: 'orchestrator.verify_failed',
      payload,
    })
    return { ok: true, value: { task, verified: false, verdict } }
  }

  const updated = deps.ledger.task.verifyTask(task.id, input.fence, evidence)
  deps.ledger.event.appendEvent({
    projectId: input.projectId,
    taskId: task.id,
    actor: input.actor,
    kind: 'orchestrator.verified',
    payload,
  })
  return { ok: true, value: { task: updated, verified: true, verdict } }
}
