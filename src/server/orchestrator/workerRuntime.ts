// Runtime worker P3: startWorker -> spawn agent di worktree -> prompt -> tunggu done/exit/lease/
// timeout -> verifikasi server -> recordWorkerResult sekali. Tanpa HTTP/UI atau singleton
// `sessions`/ledger: PTY lewat `WorkerSessionPort`, verifikasi lewat closure server-owned, dan
// orkestrator lewat port sempit. Port sesi/helper prompt di `workerRuntimeSession`/`workerRuntimePrompt`.
// Kontrak dan tipe ada di `workerRuntimeTypes`; nama publik tetap diekspor ulang dari sini.
import { randomUUID } from 'node:crypto'
import { isSafeNodeId } from '../../shared/workspace'
import type { VerificationEvidence } from './orchestratorModel'
import { evidenceVerified } from './orchestratorModel'
import type { Plan } from './plan'
import type { VerifyOutcome } from './verify'
import { toModelEvidence } from './verifier'
import { buildWorkerPrompt, capBytes, deriveNodeId, sanitizeText } from './workerRuntimePrompt'
import { waitForSettle } from './workerRuntimeSettle'
import type {
  WorkerRunErrorCode,
  WorkerRunInput,
  WorkerRunOutcome,
  WorkerRuntime,
  WorkerRuntimeDeps,
} from './workerRuntimeTypes'

export {
  createSessionsPort,
  type SessionsLike,
  type WorkerSessionPort,
} from './workerRuntimeSession'
export { buildWorkerPrompt, deriveNodeId, sanitizeText } from './workerRuntimePrompt'
export type {
  WorkerOrchestratorPort,
  WorkerRunErrorCode,
  WorkerRunInput,
  WorkerRunOutcome,
  WorkerRuntime,
  WorkerRuntimeDeps,
} from './workerRuntimeTypes'

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_POLL_MS = 250
const MIN_POLL_MS = 5
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_MAX_PROMPT_BYTES = 8 * 1024
const MAX_REASON_CHARS = 500

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function boundedReason(reason: string): string {
  const clean = sanitizeText(reason).replace(/\s+/g, ' ').trim()
  return clean.length > MAX_REASON_CHARS ? `${clean.slice(0, MAX_REASON_CHARS)}…` : clean
}

function makeOutcome(args: {
  task: WorkerRunOutcome['task']
  plan: Plan | null
  nodeId: string | null
  output?: string
  evidence?: VerificationEvidence
  error?: { code: WorkerRunErrorCode; message: string }
  cleanupError?: string
}): WorkerRunOutcome {
  return {
    ok: args.error === undefined,
    task: args.task,
    plan: args.plan,
    nodeId: args.nodeId,
    output: args.output ?? '',
    ...(args.evidence ? { evidence: args.evidence } : {}),
    ...(args.error ? { error: args.error } : {}),
    ...(args.cleanupError ? { cleanupError: args.cleanupError } : {}),
  }
}

export function createWorkerRuntime(deps: WorkerRuntimeDeps): WorkerRuntime {
  const now = deps.now ?? (() => Date.now())
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = Math.max(MIN_POLL_MS, deps.pollMs ?? DEFAULT_POLL_MS)
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const maxPromptBytes = deps.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES
  const newSessionId = deps.newSessionId ?? (() => randomUUID())

  async function runTask(input: WorkerRunInput): Promise<WorkerRunOutcome> {
    const started = await deps.orchestrator.startWorker({
      projectId: input.projectId,
      itemId: input.itemId,
      expectedVersion: input.expectedVersion,
      repo: input.repo,
      ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
      ...(input.leaseMs !== undefined ? { leaseMs: input.leaseMs } : {}),
    })
    if (!started.ok) {
      return makeOutcome({
        task: null,
        plan: deps.plan?.get(input.projectId) ?? null,
        nodeId: null,
        error: { code: started.code, message: started.message },
      })
    }

    const task = started.value.task
    const item = started.value.item
    const worktree = started.value.worktree
    const projectId = input.projectId
    const itemId = item.id
    const expectedVersion = started.value.plan.version
    const actor = task.leaseOwner ?? task.agentId ?? ''
    const nodeId = deriveNodeId(task.id, task.fence)
    const timeoutMs = input.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let recorded = false
    let opened = false
    let closed = false
    let cleanupError: string | undefined

    const planNow = (): Plan | null => deps.plan?.get(projectId) ?? null

    /** Satu-satunya jalan ke ledger; `recorded` menutup double-record dan `StaleLeaseError` jadi deny. */
    const record = async (
      outcome: 'success' | 'failure',
      evidence: VerificationEvidence | undefined,
      reason?: string
    ) => {
      if (recorded) throw new Error(`worker runtime: result already recorded for ${task.id}`)
      recorded = true
      try {
        return await deps.orchestrator.recordWorkerResult({
          projectId,
          taskId: task.id,
          fence: task.fence,
          actor,
          outcome,
          expectedVersion,
          itemId,
          ...(evidence ? { evidence } : {}),
          ...(reason ? { reason: boundedReason(reason) } : {}),
        })
      } catch (err) {
        return { ok: false as const, code: 'lease_denied' as const, message: messageOf(err) }
      }
    }

    /** Tutup PTY selalu; release worktree hanya bila masih milik path kita. */
    const cleanup = async (release: boolean): Promise<void> => {
      // Node yang tidak pernah dibuka bukan milik kita: jangan kirim close ke sesi lain.
      if (opened && !closed) {
        closed = true
        try {
          deps.sessions.close(nodeId)
        } catch (err) {
          cleanupError ??= messageOf(err)
        }
      }
      if (!release || !deps.worktrees) return
      const held = deps.worktrees.get(task.id)
      if (!held || held.path !== worktree.path) return
      try {
        await deps.worktrees.release({ taskId: task.id, branch: worktree.branch })
      } catch (err) {
        cleanupError ??= messageOf(err)
      }
    }

    const fail = async (
      code: WorkerRunErrorCode,
      message: string,
      release = true,
      output = '',
      evidence?: VerificationEvidence
    ): Promise<WorkerRunOutcome> => {
      const applied = await record('failure', evidence, message)
      await cleanup(release)
      return makeOutcome({
        task: applied.ok ? applied.value.task : task,
        plan: applied.ok ? applied.value.plan : planNow(),
        nodeId,
        output,
        ...(evidence ? { evidence } : {}),
        error: { code, message },
        ...(cleanupError ? { cleanupError } : {}),
      })
    }

    if (!isSafeNodeId(nodeId)) {
      return fail('spawn_failed', boundedReason(`derived node id is unsafe: ${nodeId}`))
    }
    if (deps.sessions.isLive(nodeId)) {
      return fail('spawn_failed', boundedReason(`node ${nodeId} is already live`))
    }

    try {
      // Sesi baru per run: `launchLine` lalu bisa memasang `--settings`/hooks.
      await deps.sessions.open({
        nodeId,
        cwd: worktree.path,
        ...(deps.cmd ? { cmd: deps.cmd } : {}),
        ...(deps.agentId ? { agentId: deps.agentId, sessionId: newSessionId() } : {}),
        ...(deps.cols !== undefined ? { cols: deps.cols } : {}),
        ...(deps.rows !== undefined ? { rows: deps.rows } : {}),
      })
      opened = true
    } catch (err) {
      return fail('spawn_failed', `spawn failed: ${messageOf(err)}`)
    }

    // Semua yang berjalan SETELAH `open` ada di dalam satu try: `statusOf`/`getTerminal`/
    // `waitForSettle` yang melempar tidak boleh lolos keluar membocorkan PTY hidup + worktree
    // tertahan. Catch menutup lewat jalur gagal yang sama (record sekali, close, release).
    try {
      const prompt = buildWorkerPrompt({
        item,
        worktree,
        attempt: task.attempt,
        maxBytes: maxPromptBytes,
        extra: input.prompt,
      })
      try {
        deps.sessions.input(nodeId, `${prompt}\n`)
      } catch (err) {
        return fail('spawn_failed', `prompt delivery failed: ${messageOf(err)}`)
      }

      const settled = await waitForSettle(deps.sessions, nodeId, {
        deadline: now() + timeoutMs,
        leaseDeadline: task.leaseExpires,
        timeoutMs,
        pollMs,
        now,
        sleep,
      })
      const output = capBytes(sanitizeText(deps.sessions.getTerminal(nodeId)), maxOutputBytes)

      if (settled !== 'done') {
        const reason =
          settled === 'timeout'
            ? `worker timed out after ${timeoutMs}ms`
            : settled === 'lease_expired'
              ? `worker lease expired before task ${task.id} completed`
              : 'worker session exited before reporting done'
        return fail(settled, reason, true, output)
      }

      let verdict: VerifyOutcome
      try {
        verdict = await deps.verify({ cwd: worktree.path, scope: item.scope })
      } catch (err) {
        return fail('verify_failed', `verifier error: ${messageOf(err)}`, true, output)
      }
      const evidence = toModelEvidence(verdict)
      if (!verdict.ok || !evidenceVerified(evidence)) {
        const reasons = verdict.reasons.length > 0 ? verdict.reasons : ['no machine evidence']
        return fail('verify_failed', `verification failed: ${reasons.join('; ')}`, true, output, evidence)
      }
      // No-op (mis. keluar di prompt trust) bisa lolos diff kosong + test hijau; bukan hasil kerja.
      if (verdict.changedFiles.length === 0)
        return fail('verify_failed', 'verification failed: no files changed', true, output, evidence)

      const applied = await record('success', evidence)
      if (!applied.ok) {
        // Fence basi = attempt lain sudah memiliki task; jangan sentuh worktree bersama.
        const holdOn = applied.code === 'stale_fence'
        await cleanup(!holdOn)
        return makeOutcome({
          task,
          plan: planNow(),
          nodeId,
          output,
          evidence,
          error: { code: applied.code, message: applied.message },
          ...(cleanupError ? { cleanupError } : {}),
        })
      }
      await cleanup(true)
      return makeOutcome({
        task: applied.value.task,
        plan: applied.value.plan,
        nodeId,
        output,
        evidence,
        ...(applied.value.releaseError ? { cleanupError: applied.value.releaseError } : {}),
      })
    } catch (err) {
      // Hasil sudah tercatat: jangan record dua kali. Cukup cleanup, hasilnya tetap kegagalan
      // runtime supaya pemanggil tidak mengira kerja ini sukses.
      if (recorded) {
        await cleanup(true)
        return makeOutcome({
          task,
          plan: planNow(),
          nodeId,
          error: { code: 'spawn_failed', message: boundedReason(`runtime error after record: ${messageOf(err)}`) },
          ...(cleanupError ? { cleanupError } : {}),
        })
      }
      return fail('spawn_failed', boundedReason(`runtime error after spawn: ${messageOf(err)}`))
    }
  }

  return { runTask }
}
