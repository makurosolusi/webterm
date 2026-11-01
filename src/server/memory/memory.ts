/**
 * Public entry point for the P4a memory repository. `api.ts` should import from
 * here only; the split modules are implementation detail.
 *
 * Integration contract:
 * - `claimMemory(db, authority, {...})` — a worker may only claim (never `fact`).
 * - `promoteMemory(db, authority, {...})` — `authority.kind` must be
 *   `'orchestrator' | 'human'`; core scope additionally requires `'human'`.
 * - `supersedeMemory` keeps the old row as `superseded` with `superseded_at`.
 * - `searchMemory(db, projectId, query, limit)` — facts only, bm25 order.
 *
 * SECURITY: `authority` (`{ kind, id }`) is never read from a request payload. It must be
 * derived by the caller from the authenticated principal, so a worker cannot declare itself a
 * human or an orchestrator (RND/qc/p3-security.md M2). There is no default kind.
 *
 * Every function is synchronous over an open `bun:sqlite` Database and throws
 * `MemoryError` subclasses (`MemoryEvidenceError`, `MemoryAuthorityError`,
 * `MemoryConflictError`, `MemoryNotFoundError`); all of them extend `LedgerError`.
 */
export {
  EVIDENCE_FUTURE_SKEW_MS,
  EVIDENCE_PAST_SKEW_MS,
  MEMORY_ACTOR_KINDS,
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
  MemoryAuthority,
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

/**
 * P4b file+git truth (flag `WEBTERM_MEMORY_FILES=on`, default off). SQLite stays the
 * rebuildable index; `writeMemoryFactFile` is the only export path and
 * `rebuildMemoryIndex` the only import path. Flag off makes both inert.
 */
export {
  MEMORY_FILES_FLAG,
  MemoryFileError,
  assertConfined,
  createMemoryFilePort,
  memoryCommitMessage,
  memoryFileRelPath,
  memoryFilesEnabled,
  memorySqlDb,
  parseMemoryFile,
  rebuildMemoryIndex,
  renderMemoryFile,
  resolveInside,
  safeSegment,
  writeMemoryFactFile,
} from './memoryFile'
export type {
  MemoryFileExecResult,
  MemoryFilePort,
  MemoryFileRecord,
  MemoryFileSpawn,
  MemoryRebuildRejection,
  MemoryRebuildReport,
  MemorySqlDb,
  WriteMemoryFileResult,
} from './memoryFile'
