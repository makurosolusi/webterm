// Kontrak runtime worker P3: jenis hasil/input dan port dependensi. Dipisah dari orkestrasi
// supaya `workerRuntime.ts` fokus pada alur run dan modul ini bebas efek samping.
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
import type { Plan, PlanStore } from './plan'
import type { VerifyInput, VerifyOutcome } from './verify'
import type { WorktreeService } from './worktree'
import type { WorkerSessionPort } from './workerRuntimeSession'
import type { spawnAgent } from '../spawn/agentSpawn'
import type { ReportCompletion } from '../verifier/verifier.report'

export type WorkerRunErrorCode =
  | OrchestratorDenyCode
  | 'spawn_failed'
  | 'timeout'
  | 'lease_expired'
  | 'session_exited'
  | 'verify_failed'
  | 'lease_violation'

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
  /** Where a judged verdict goes (timeline + inbox); default `recordCompletion`. */
  report?: ReportCompletion
  /** Opsional: cleanup manual bila `recordWorkerResult` ditolak sebelum sempat release. */
  worktrees?: WorktreeService
  cmd?: string
  agentId?: string
  /** Principal the worker is spawned under (K3 lineage); default `human-ui` (the run route is root-token only). */
  spawnParent?: string
  /** The `agent.spawn` path (F2-h); default = the process-wide spawner. */
  spawn?: typeof spawnAgent
  /** Minting id sesi baru per run; default `crypto.randomUUID` (injectable untuk test). */
  newSessionId?: () => string
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
