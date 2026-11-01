// Runtime worker P3: menutup loop produksi setelah `startWorker`. Modul ini tidak menyentuh
// HTTP/UI dan tidak meng-import singleton `sessions`/ledger: sesi PTY masuk lewat
// `WorkerSessionPort`, verifikasi lewat closure server-owned, dan orkestrator lewat port sempit.
// Alurnya: startWorker (cap/worktree/lease/plan) -> spawn agent di worktree -> kirim prompt
// terbatas -> tunggu done/exit/lease/timeout -> verifikasi server -> recordWorkerResult sekali.
import type { OpenMsg, ServerMsg } from '../../shared/protocol'
import type { AgentStatus } from '../../shared/workspace'
import { isSafeNodeId } from '../../shared/workspace'
import type {
  OrchestratorDenyCode,
  OrchestratorResult,
  OrchestratorTask,
  RecordWorkerResultInput,
  RecordWorkerResultValue,
  StartWorkerInput,
  StartWorkerValue,
  VerificationEvidence,
} from './orchestratorModel'
import { evidenceVerified } from './orchestratorModel'
import type { Plan, PlanItem, PlanStore } from './plan'
import type { VerifyInput, VerifyOutcome } from './verify'
import type { WorktreeService } from './worktree'
import { toModelEvidence } from './verifier'

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_POLL_MS = 250
const MIN_POLL_MS = 5
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_MAX_PROMPT_BYTES = 8 * 1024
const MAX_REASON_CHARS = 500

/** Port sesi yang dibutuhkan runtime; `sessions` asli memenuhi bentuk ini lewat adapter. */
export interface WorkerSessionPort {
  open(input: {
    nodeId: string
    cwd: string
    cmd?: string
    agentId?: string
    cols?: number
    rows?: number
  }): void | Promise<void>
  input(nodeId: string, text: string): void
  statusOf(nodeId: string): AgentStatus | undefined
  getTerminal(nodeId: string): string
  isLive(nodeId: string): boolean
  close(nodeId: string): void
}

/** Subset struktural `Sessions`; sengaja tanpa import runtime supaya test bebas PTY. */
export interface SessionsLike {
  open(msg: OpenMsg, send: (m: ServerMsg) => void): void
  input(id: string, data: string): void
  statusOf(id: string): AgentStatus | undefined
  getTerminal(id: string): string
  isLive(id: string): boolean
  close(id: string): void
}

export function createSessionsPort(source: SessionsLike): WorkerSessionPort {
  const noop = (): void => {}
  return {
    open: (input) =>
      source.open(
        {
          t: 'open',
          id: input.nodeId,
          cols: input.cols ?? 120,
          rows: input.rows ?? 40,
          cwd: input.cwd,
          ...(input.cmd ? { cmd: input.cmd } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
        },
        noop
      ),
    input: (nodeId, text) => source.input(nodeId, text),
    statusOf: (nodeId) => source.statusOf(nodeId),
    getTerminal: (nodeId) => source.getTerminal(nodeId),
    isLive: (nodeId) => source.isLive(nodeId),
    close: (nodeId) => source.close(nodeId),
  }
}

export type WorkerRunErrorCode =
  | OrchestratorDenyCode
  | 'spawn_failed'
  | 'timeout'
  | 'lease_expired'
  | 'session_exited'
  | 'verify_failed'

export interface WorkerRunOutcome {
  ok: boolean
  task: OrchestratorTask | null
  plan: Plan | null
  nodeId: string | null
  /** Output terminal ter-sanitasi + dipotong `maxOutputBytes`; tidak pernah di-log mentah. */
  output: string
  evidence?: VerificationEvidence
  error?: { code: WorkerRunErrorCode; message: string }
  /** Kegagalan best-effort saat close/release; tidak mengubah hasil ledger. */
  cleanupError?: string
}

export interface WorkerRunInput {
  projectId: string
  itemId: string
  expectedVersion: number
  repo: string
  baseRef?: string
  /** Instruksi tambahan; digabung ke prompt lalu dipotong `maxPromptBytes`. */
  prompt?: string
  timeoutMs?: number
  leaseMs?: number
}

export interface WorkerOrchestratorPort {
  startWorker(input: StartWorkerInput): Promise<OrchestratorResult<StartWorkerValue>>
  recordWorkerResult(
    input: RecordWorkerResultInput
  ): Promise<OrchestratorResult<RecordWorkerResultValue>>
}

export interface WorkerRuntimeDeps {
  orchestrator: WorkerOrchestratorPort
  /** Opsional: hanya dipakai untuk membaca plan ketika record ditolak. */
  plan?: PlanStore
  sessions: WorkerSessionPort
  /** Closure server-owned: root/exec/commands diikat pemanggil, bukan payload worker. */
  verify: (input: VerifyInput) => Promise<VerifyOutcome>
  /** Opsional: cleanup manual bila `recordWorkerResult` ditolak sebelum sempat release. */
  worktrees?: WorktreeService
  cmd?: string
  agentId?: string
  cols?: number
  rows?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  timeoutMs?: number
  maxOutputBytes?: number
  maxPromptBytes?: number
}

export interface WorkerRuntime {
  runTask(input: WorkerRunInput): Promise<WorkerRunOutcome>
}

// ANSI CSI/OSC dan karakter kontrol (newline/tab dipertahankan) supaya teks yang dikembalikan
// bersih dari escape terminal sebelum dipotong dan disimpan.
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/g

export function sanitizeText(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '')
}

function capBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return buffer.subarray(0, maxBytes).toString('utf8')
}

/** Node id deterministik dari task+fence, selalu lolos `isSafeNodeId` (prefix `w-`). */
export function deriveNodeId(taskId: string, fence: number): string {
  return `w-${taskId}-${fence}`.replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 64)
}

export function buildWorkerPrompt(args: {
  item: Pick<PlanItem, 'id' | 'title' | 'scope'>
  worktree: { path: string; branch: string }
  attempt: number
  maxBytes: number
  extra?: string
}): string {
  const scope = args.item.scope.map((entry) => `- ${entry}`).join('\n')
  const extra = args.extra === undefined || args.extra.trim() === '' ? '' : `\n\n${args.extra.trim()}`
  const prompt = [
    'You are a leaf worker agent in webterm. Work only inside the worktree below.',
    `Task: ${args.item.title}`,
    `Scope (touch only these paths):\n${scope}`,
    `Worktree: ${args.worktree.path}`,
    `Branch: ${args.worktree.branch}`,
    `Item: ${args.item.id} · attempt ${args.attempt}`,
    'Steps: implement the task, run the repo tests/typecheck, then commit locally with git.',
    'Do not push. Reply with a short summary; the orchestrator verifies independently.',
    extra,
  ]
    .join('\n')
    .trim()
  return capBytes(sanitizeText(prompt), args.maxBytes)
}

type Settle = 'done' | 'timeout' | 'lease_expired' | 'session_exited'

interface WaitLimits {
  deadline: number
  leaseDeadline: number | null
  timeoutMs: number
  pollMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/** Poll status sampai done/exit; jam dan tidur di-inject supaya test deterministik. */
async function waitForSettle(
  sessions: WorkerSessionPort,
  nodeId: string,
  limits: WaitLimits
): Promise<Settle> {
  const maxPolls = Math.max(1, Math.ceil(limits.timeoutMs / limits.pollMs) + 2)
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (sessions.statusOf(nodeId) === 'done') return 'done'
    if (!sessions.isLive(nodeId)) return 'session_exited'
    const at = limits.now()
    if (limits.leaseDeadline !== null && at >= limits.leaseDeadline) return 'lease_expired'
    if (at >= limits.deadline) return 'timeout'
    await limits.sleep(limits.pollMs)
  }
  // Jam yang tidak maju tidak boleh membuat loop abadi: batas poll = batas waktu.
  return 'timeout'
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function boundedReason(reason: string): string {
  const clean = sanitizeText(reason).replace(/\s+/g, ' ').trim()
  return clean.length > MAX_REASON_CHARS ? `${clean.slice(0, MAX_REASON_CHARS)}…` : clean
}

function makeOutcome(args: {
  task: OrchestratorTask | null
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

    /** Satu-satunya jalan ke ledger: `recorded` menutup double-record di semua cabang.
     *  Ledger bisa melempar `StaleLeaseError` bila lease sudah direbut reaper; itu tetap
     *  dipetakan ke deny supaya cleanup dan pemanggil tidak melihat exception. */
    const record = async (
      outcome: 'success' | 'failure',
      evidence: VerificationEvidence | undefined,
      reason?: string
    ): Promise<OrchestratorResult<RecordWorkerResultValue>> => {
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
        return { ok: false, code: 'lease_denied', message: messageOf(err) }
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
      await deps.sessions.open({
        nodeId,
        cwd: worktree.path,
        ...(deps.cmd ? { cmd: deps.cmd } : {}),
        ...(deps.agentId ? { agentId: deps.agentId } : {}),
        ...(deps.cols !== undefined ? { cols: deps.cols } : {}),
        ...(deps.rows !== undefined ? { rows: deps.rows } : {}),
      })
      opened = true
    } catch (err) {
      return fail('spawn_failed', `spawn failed: ${messageOf(err)}`)
    }

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
  }

  return { runTask }
}
