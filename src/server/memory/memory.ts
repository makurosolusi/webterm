/**
 * Public entry point for the P4a memory repository. `api.ts` should import from
 * here only; the split modules are implementation detail.
 *
 * Integration contract:
 * - `claimMemory(db, {...})` — worker only; `actorKind` defaults to `worker`.
 * - `promoteMemory(db, {...})` — `actorKind: 'orchestrator' | 'human'`; core
 *   scope additionally requires `'human'`.
 * - `supersedeMemory` keeps the old row as `superseded` with `superseded_at`.
 * - `searchMemory(db, projectId, query, limit)` — facts only, bm25 order.
 *
 * Every function is synchronous over an open `bun:sqlite` Database and throws
 * `MemoryError` subclasses (`MemoryEvidenceError`, `MemoryAuthorityError`,
 * `MemoryConflictError`, `MemoryNotFoundError`); all of them extend `LedgerError`.
 */
export {
  EVIDENCE_FUTURE_SKEW_MS,
  EVIDENCE_PAST_SKEW_MS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MemoryAuthorityError,
  MemoryConflictError,
  MemoryError,
  MemoryEvidenceError,
  MemoryNotFoundError,
} from './memoryModel'
export type {
  ClaimMemoryInput,
  ListMemoryOptions,
  MachineEvidence,
  Memory,
  MemoryActorKind,
  MemoryEvent,
  MemoryEventsOptions,
  MemoryScope,
  MemorySearchHit,
  MemoryStatus,
  PromoteMemoryInput,
  QuarantineMemoryInput,
  SupersedeMemoryInput,
} from './memoryModel'
export { claimMemory, promoteMemory, quarantineMemory, supersedeMemory } from './memoryWrite'
export { listMemory, memoryEvents, searchMemory } from './memorySearch'
