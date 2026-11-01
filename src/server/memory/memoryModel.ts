/**
 * Shapes, scopes, and typed errors for the P4a memory repository. The `memory`,
 * `memory_fts`, and `memory_event` tables are created by the ledger v1 migration;
 * this module never touches SQLite.
 *
 * Authority model (RND/02-KEBUTUHAN.md M1, M4, M5, M12):
 * - a worker may only `claim`; only a human or orchestrator may promote to `fact`;
 * - `core` scope is human-only, mirroring CORE.md being human-written;
 * - corrections use supersede (history kept), never overwrite.
 */
import { LedgerError } from '../ledger/ledgerModel'

export type MemoryStatus = 'claim' | 'fact' | 'quarantine' | 'superseded'
export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  'claim',
  'fact',
  'quarantine',
  'superseded',
]

/** `core` is the human-only CORE scope; `scratch` is short-lived working memory. */
export const MEMORY_SCOPES = ['project', 'scratch', 'core'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export type MemoryActorKind = 'human' | 'orchestrator' | 'worker'
export const MEMORY_ACTOR_KINDS: readonly MemoryActorKind[] = ['human', 'orchestrator', 'worker']

/**
 * Who is performing the write, derived by the server from the authenticated caller.
 * It is deliberately NOT part of any `*MemoryInput`: a worker-controlled request body
 * must never be able to declare itself a human (M2 in RND/qc/p3-security.md).
 */
export interface MemoryAuthority {
  kind: MemoryActorKind
  /** Authenticated principal id; used only for audit rows, never for authorization. */
  id: string
}

export interface Memory {
  id: string
  projectId: string | null
  scope: MemoryScope
  key: string
  title: string
  body: string
  status: MemoryStatus
  sourceKind: string | null
  sourceRef: string | null
  supersedes: string | null
  supersededAt: number | null
  createdAt: number
  updatedAt: number
}

export interface MemorySearchHit extends Memory {
  /** Raw bm25 score from FTS5; lower (more negative) is a better match. */
  rank: number
}

export interface MemoryEvent {
  seq: number
  memoryId: string
  ts: number
  actor: string
  kind: string
  payload: unknown
}

/**
 * Machine-checkable evidence for promotion. A bare sentence ("tests pass") is
 * not evidence; the shape is deliberately small and non-executable so no
 * free-form `verify_cmd` is ever persisted (M8).
 */
export interface MachineEvidence {
  /** Allowlisted command that was actually run, e.g. `bun test src/server/memory`. */
  command: string
  /** Must be 0: a failing command cannot promote a claim. */
  exitCode: number
  /** Epoch-ms when the command finished; future timestamps are forged. */
  observedAt: number
  /**
   * Optional sha256 of the capped command output, as issued by the server-side verifier
   * (`verify.ts` `VerificationEvidence.outputDigest`). When present it is validated, so a
   * forged digest cannot be smuggled into the audit trail.
   */
  digest?: string
}

export interface ClaimMemoryInput {
  id?: string
  projectId: string
  scope?: MemoryScope
  key: string
  title: string
  body: string
  sourceKind: string
  sourceRef: string
  now?: number
}

export interface PromoteMemoryInput {
  id: string
  evidence: MachineEvidence
  now?: number
}

export interface SupersedeMemoryInput {
  /** The current row being replaced; it keeps its history as `superseded`. */
  id: string
  title: string
  body: string
  sourceKind: string
  sourceRef: string
  /** Required when the replaced row is already a `fact`. */
  evidence?: MachineEvidence
  now?: number
}

export interface QuarantineMemoryInput {
  id: string
  reason: string
  now?: number
}

export interface ListMemoryOptions {
  status?: MemoryStatus
  scope?: MemoryScope
  limit?: number
  offset?: number
}

export interface MemoryEventsOptions {
  limit?: number
}

/** Base class so API handlers can map every memory rejection to one status code. */
export class MemoryError extends LedgerError {}

/** A claim/promotion was missing or carried structurally invalid machine evidence. */
export class MemoryEvidenceError extends MemoryError {}

/** The actor kind may not perform this write (worker promoting, non-human writing core). */
export class MemoryAuthorityError extends MemoryError {}

/** `(project_id, scope, key)` already exists, or the row is not in a legal state. */
export class MemoryConflictError extends MemoryError {}

export class MemoryNotFoundError extends MemoryError {
  constructor(readonly memoryId: string) {
    super(`memory not found: ${memoryId}`)
  }
}

/** Future-clock tolerance for `observedAt` (clock skew between worker and server). */
export const EVIDENCE_FUTURE_SKEW_MS = 60_000
/** Evidence may predate the claim slightly when a test just finished before claiming. */
export const EVIDENCE_PAST_SKEW_MS = 5 * 60_000
