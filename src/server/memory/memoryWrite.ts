/**
 * Memory writes: claim, promote, supersede, quarantine. Every function runs in
 * one BEGIN IMMEDIATE transaction so the row change and its `memory_event`
 * audit row commit together (RND/01-TEMUAN.md §6).
 */
import type { Database } from 'bun:sqlite'
import { execInsert, execWrite, newId, requireText, tx } from '../ledger/ledgerCore'
import {
  assertCanPromote,
  actorKindOf,
  appendMemoryEvent,
  findMemoryByKey,
  loadMemory,
  memoryContext,
  parseScope,
  validateEvidence,
} from './memoryCore'
import {
  type ClaimMemoryInput,
  MemoryConflictError,
  MemoryEvidenceError,
  type Memory,
  type PromoteMemoryInput,
  type QuarantineMemoryInput,
  type SupersedeMemoryInput,
} from './memoryModel'

interface InsertRow {
  id: string
  projectId: string
  scope: string
  key: string
  title: string
  body: string
  status: string
  sourceKind: string
  sourceRef: string
  supersedes: string | null
  now: number
}

function insertMemory(ctx: ReturnType<typeof memoryContext>, row: InsertRow): void {
  try {
    execInsert(
      ctx.db,
      `INSERT INTO memory (id, project_id, scope, key, title, body, status,
         source_kind, source_ref, supersedes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.projectId,
      row.scope,
      row.key,
      row.title,
      row.body,
      row.status,
      row.sourceKind,
      row.sourceRef,
      row.supersedes,
      row.now,
      row.now
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('UNIQUE') || message.includes('memory.project_id')) {
      throw new MemoryConflictError(
        `memory ${row.projectId}/${row.scope}/${row.key} already exists; ` +
          'correct it with supersedeMemory instead of overwriting'
      )
    }
    throw err
  }
}

/**
 * Worker-side queue entry. A claim without `sourceKind`/`sourceRef` is rejected:
 * provenance is what lets the orchestrator check the claim before promotion.
 * Claims never touch the fact store and never auto-promote.
 */
export function claimMemory(db: Database, input: ClaimMemoryInput): Memory {
  const projectId = requireText(input.projectId, 'claimMemory.projectId')
  const key = requireText(input.key, 'claimMemory.key')
  const title = requireText(input.title, 'claimMemory.title')
  const body = requireText(input.body, 'claimMemory.body')
  const sourceKind = requireText(input.sourceKind, 'claimMemory.sourceKind')
  const sourceRef = requireText(input.sourceRef, 'claimMemory.sourceRef')
  const actor = requireText(input.actor, 'claimMemory.actor')
  const actorKind = actorKindOf(input.actorKind)
  const scope = parseScope(input.scope)
  if (scope === 'core' && actorKind !== 'human') {
    throw new MemoryEvidenceError('claimMemory: scope core is human-only')
  }
  const ctx = memoryContext(db, input.now)
  const at = ctx.now()
  const id = input.id ?? newId()
  return tx(ctx, () => {
    if (findMemoryByKey(ctx, projectId, scope, key) !== null) {
      throw new MemoryConflictError(
        `memory ${projectId}/${scope}/${key} already exists; supersede it instead`
      )
    }
    insertMemory(ctx, {
      id, projectId, scope, key, title, body, status: 'claim',
      sourceKind, sourceRef, supersedes: null, now: at,
    })
    appendMemoryEvent(ctx, id, actor, 'memory.claim', { actorKind, sourceKind, sourceRef }, at)
    return loadMemory(ctx, id)
  })
}

/**
 * Orchestrator promotion of a claim to `fact`. Requires machine evidence
 * (`command`, exit 0, `observedAt`) and a non-worker actor. Workers are rejected
 * here even when they somehow hold a claim.
 */
export function promoteMemory(db: Database, input: PromoteMemoryInput): Memory {
  const id = requireText(input.id, 'promoteMemory.id')
  const actor = requireText(input.actor, 'promoteMemory.actor')
  const actorKind = actorKindOf(input.actorKind)
  const ctx = memoryContext(db, input.now)
  const at = ctx.now()
  return tx(ctx, () => {
    const memory = loadMemory(ctx, id)
    if (memory.status !== 'claim') {
      throw new MemoryConflictError(`promoteMemory: ${id} is ${memory.status}, expected claim`)
    }
    assertCanPromote(actorKind, memory.scope, 'promoteMemory')
    const evidence = validateEvidence(input.evidence, at, memory.createdAt, 'promoteMemory')
    // The memory_au trigger reindexes memory_fts, so sqlite3_changes() reports the
    // trigger's statement, not this UPDATE. Verify the resulting row instead.
    execWrite(
      ctx.db,
      "UPDATE memory SET status = 'fact', updated_at = ? WHERE id = ? AND status = 'claim'",
      at,
      id
    )
    if (loadMemory(ctx, id).status !== 'fact') {
      throw new MemoryConflictError(`promoteMemory: concurrent change for ${id}`)
    }
    appendMemoryEvent(ctx, id, actor, 'memory.promote', { actorKind, evidence }, at)
    return loadMemory(ctx, id)
  })
}

/**
 * Replaces a row with new content while keeping the old one as history. The old
 * row's key is moved to a unique historical alias (`key#superseded:<id>`) so the
 * `(project, scope, key)` unique index frees up for the replacement. Nothing is
 * ever deleted and the old content stays readable via `listMemory`.
 */
export function supersedeMemory(db: Database, input: SupersedeMemoryInput): Memory {
  const id = requireText(input.id, 'supersedeMemory.id')
  const title = requireText(input.title, 'supersedeMemory.title')
  const body = requireText(input.body, 'supersedeMemory.body')
  const sourceKind = requireText(input.sourceKind, 'supersedeMemory.sourceKind')
  const sourceRef = requireText(input.sourceRef, 'supersedeMemory.sourceRef')
  const actor = requireText(input.actor, 'supersedeMemory.actor')
  const actorKind = actorKindOf(input.actorKind)
  const ctx = memoryContext(db, input.now)
  const at = ctx.now()
  return tx(ctx, () => {
    const old = loadMemory(ctx, id)
    if (old.status !== 'claim' && old.status !== 'fact') {
      throw new MemoryConflictError(
        `supersedeMemory: ${id} is ${old.status}; only claim/fact rows can be superseded`
      )
    }
    if (old.projectId === null) {
      throw new MemoryConflictError(`supersedeMemory: ${id} has no project`)
    }
    const nextStatus = old.status === 'fact' ? 'fact' : 'claim'
    let evidence = null
    if (nextStatus === 'fact') {
      assertCanPromote(actorKind, old.scope, 'supersedeMemory')
      evidence = validateEvidence(input.evidence, at, old.createdAt, 'supersedeMemory')
    }
    const alias = `${old.key}#superseded:${old.id}`
    // See promoteMemory: the FTS reindex trigger makes sqlite3_changes() unreliable.
    execWrite(
      ctx.db,
      `UPDATE memory SET scope = ?, key = ?, status = 'superseded', superseded_at = ?,
         updated_at = ? WHERE id = ? AND status = ?`,
      old.scope,
      alias,
      at,
      at,
      old.id,
      old.status
    )
    if (loadMemory(ctx, old.id).status !== 'superseded') {
      throw new MemoryConflictError(`supersedeMemory: concurrent change for ${id}`)
    }
    const nextId = newId()
    insertMemory(ctx, {
      id: nextId,
      projectId: old.projectId,
      scope: old.scope,
      key: old.key,
      title,
      body,
      status: nextStatus,
      sourceKind,
      sourceRef,
      supersedes: old.id,
      now: at,
    })
    appendMemoryEvent(ctx, old.id, actor, 'memory.superseded', { by: nextId }, at)
    appendMemoryEvent(
      ctx,
      nextId,
      actor,
      nextStatus === 'fact' ? 'memory.promote' : 'memory.claim',
      { actorKind, supersedes: old.id, evidence },
      at
    )
    return loadMemory(ctx, nextId)
  })
}

/** Takes a claim/fact out of circulation without deleting its history. */
export function quarantineMemory(db: Database, input: QuarantineMemoryInput): Memory {
  const id = requireText(input.id, 'quarantineMemory.id')
  const reason = requireText(input.reason, 'quarantineMemory.reason')
  const actor = requireText(input.actor, 'quarantineMemory.actor')
  const actorKind = actorKindOf(input.actorKind)
  const ctx = memoryContext(db, input.now)
  const at = ctx.now()
  return tx(ctx, () => {
    const memory = loadMemory(ctx, id)
    if (memory.status !== 'claim' && memory.status !== 'fact') {
      throw new MemoryConflictError(
        `quarantineMemory: ${id} is ${memory.status}; only claim/fact rows can be quarantined`
      )
    }
    // See promoteMemory: the FTS reindex trigger makes sqlite3_changes() unreliable.
    execWrite(
      ctx.db,
      "UPDATE memory SET status = 'quarantine', updated_at = ? WHERE id = ? AND status = ?",
      at,
      id,
      memory.status
    )
    if (loadMemory(ctx, id).status !== 'quarantine') {
      throw new MemoryConflictError(`quarantineMemory: concurrent change for ${id}`)
    }
    appendMemoryEvent(ctx, id, actor, 'memory.quarantine', { actorKind, reason, from: memory.status }, at)
    return loadMemory(ctx, id)
  })
}
