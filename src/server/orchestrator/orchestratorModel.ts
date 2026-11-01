// Bentuk data dan port orkestrator P3 (RND/03-RENCANA.md §8). Sengaja tidak meng-import
// facade `ledger.ts` supaya modul ini tetap bisa diuji di vitest tanpa bun:sqlite:
// setiap dependensi masuk lewat interface sempit yang di-inject.
import type { AgentRole, SpawnTarget } from './roles'
import type { CapLimits, CapSnapshot, CapViolation } from './caps'
import type { Plan, PlanItem, PlanStore } from './plan'
import type { WorktreeService } from './worktree'

export interface OrchestratorDeps {
  ledger: OrchestratorLedger
  plan: PlanStore
  worktrees: WorktreeService
  caps?: CapLimits
  /** Prefix cabang default; `agent` -> `agent/<taskId>`. */
  branchPrefix?: string
}

export interface OrchestratorAgent {
  id: string
  projectId: string
  role: string
  depth: number
  state: string
}

export interface OrchestratorTask {
  id: string
  projectId: string
  agentId: string | null
  status: string
  fence: number
  leaseOwner: string | null
  leaseExpires: number | null
  attempt: number
  maxAttempts: number
  evidence: unknown
}

export interface CreateTaskPortInput {
  projectId: string
  spec: string
  agentId?: string
  idemKey?: string
  maxAttempts?: number
}

export interface AppendEventPortInput {
  projectId?: string
  taskId?: string
  actor: string
  kind: string
  payload?: unknown
}

/** Potongan `Ledger` P2 yang dipakai orkestrator; facade asli memenuhi bentuk ini. */
export interface OrchestratorLedger {
  agent: {
    getAgent(id: string): OrchestratorAgent | null
  }
  task: {
    createTask(input: CreateTaskPortInput): OrchestratorTask
    getTask(id: string): OrchestratorTask | null
    leaseTask(id: string, input: { owner: string; ttlMs: number }): OrchestratorTask | null
    claimDone(id: string, fence: number, evidence: unknown): OrchestratorTask
    verifyTask(id: string, fence: number, evidence: unknown): OrchestratorTask
    failTask(id: string, fence: number, reason: string): OrchestratorTask
  }
  /** Audit append-only; event ditulis dalam transaksi yang sama saat tersedia. */
  event: {
    appendEvent(input: AppendEventPortInput): unknown
  }
  /** Opsional: production wiring mengirim `ledger.tx` agar task + plan satu transaksi. */
  tx?<T>(fn: () => T): T
}

export type OrchestratorDenyCode =
  | 'wrong_role'
  | 'project_mismatch'
  | 'agent_not_found'
  | 'plan_missing'
  | 'plan_stale'
  | 'item_not_found'
  | 'invalid_state'
  | 'not_participant'
  | 'cap_denied'
  | 'lease_denied'
  | 'stale_fence'
  | 'worktree_failed'
  | 'task_not_found'
  | 'spawn_depth'

export interface OrchestratorDeny {
  ok: false
  code: OrchestratorDenyCode
  message: string
  /** Hanya terisi untuk cap_denied; alasan bertipe, bukan teks. */
  violations?: CapViolation[]
}

export type OrchestratorResult<T> = { ok: true; value: T } | OrchestratorDeny

/**
 * Satu-satunya nilai `verifiedBy` yang dianggap bukti server. Konstanta ini menandai evidence
 * yang dibuat oleh `verifyWorktree`/`toModelEvidence`, bukan objek yang dirakit worker.
 */
export const SERVER_VERIFIED_BY = 'server-verifier'
export type ServerVerifiedBy = typeof SERVER_VERIFIED_BY

/**
 * Bukti hasil verifikasi. `verifiedBy` wajib dan hanya diisi oleh jalur verifier server
 * (`toModelEvidence`): objek evidence buatan worker tanpa marker ini tidak pernah `verified`.
 * Pengecualian eksplisit: approval manusia (`approvalHumanReview`) memanggil
 * `ledger.task.verifyTask` langsung dengan evidence `null`, jadi tidak lewat gerbang ini.
 */
export interface VerificationEvidence {
  verifiedBy: ServerVerifiedBy
  diffStat?: string
  filesChanged?: string[]
  scopeViolations?: string[]
  tests?: { passed: number; failed: number; command?: string }
  typecheck?: { ok: boolean; command?: string }
}

/**
 * Verifikasi independen minimal (RND §8): evidence tanpa marker server, tanpa test, test
 * yang gagal, atau typecheck merah bukan `verified`. Scope violation selalu memblokir.
 * `verifiedBy` membuat klaim worker berhenti di `claimed_done` meski angka test-nya hijau.
 */
export function evidenceVerified(evidence: VerificationEvidence | undefined): boolean {
  if (!evidence) return false
  if (evidence.verifiedBy !== SERVER_VERIFIED_BY) return false
  if (Array.isArray(evidence.scopeViolations) && evidence.scopeViolations.length > 0) return false
  const tests = evidence.tests
  if (!tests || !Number.isFinite(tests.passed) || !Number.isFinite(tests.failed)) return false
  if (tests.passed <= 0 || tests.failed > 0) return false
  if (evidence.typecheck && evidence.typecheck.ok !== true) return false
  return true
}

export interface AssignTaskInput {
  projectId: string
  itemId: string
  /** Agent worker (depth 2) yang akan mengerjakan item. */
  assignee: string
  /** Versi plan yang dibaca caller; stale -> deny `plan_stale`. */
  expectedVersion: number
  actor?: string
  maxAttempts?: number
}

export interface AssignTaskValue {
  task: OrchestratorTask
  item: PlanItem
  plan: Plan
}

export interface StartWorkerInput {
  projectId: string
  itemId: string
  expectedVersion: number
  /** Path repo git project (absolut); dasar `git worktree add`. */
  repo: string
  /** Override cabang; default `<branchPrefix>/<taskId>`. */
  branch?: string
  leaseMs?: number
  /** Pemakaian aktual project (token/USD/turn/waktu) untuk cap tambahan. */
  usage?: Partial<CapSnapshot>
  /** Override nama ref dasar git. */
  baseRef?: string
}

export interface StartWorkerValue {
  task: OrchestratorTask
  worktree: { taskId: string; branch: string; path: string }
  item: PlanItem
  plan: Plan
}

export interface RecordWorkerResultInput {
  projectId: string
  taskId: string
  /** Fence yang dipegang worker; beda satu angka = deny `stale_fence`. */
  fence: number
  /** Identitas worker; harus sama dengan lease owner dan assignee plan. */
  actor: string
  outcome: 'success' | 'failure'
  evidence?: VerificationEvidence
  reason?: string
  expectedVersion: number
  itemId?: string
}

export interface RecordWorkerResultValue {
  task: OrchestratorTask
  item: PlanItem
  plan: Plan
  verified: boolean
  /** Error cleanup worktree (best effort); hasil ledger tetap berlaku. */
  releaseError?: string
}

export type SpawnDecision = OrchestratorResult<SpawnTarget & { role: AgentRole }>
