// Cross-WS contract: skill store and lifecycle (RND/29b §4.10, RND/25 §4.5).
import type { Awaitable } from './tool.types'

/** proposed -> (rejected | evaluated) -> pending_approval -> active -> archived; `disabled` on hash mismatch. */
export type SkillStatus =
  | 'proposed' | 'rejected' | 'evaluated' | 'pending_approval' | 'active' | 'disabled' | 'archived'

/** Where a skill came from. */
export type SkillOrigin = 'builtin' | 'human' | 'central' | 'agent'

/** The two skill kinds, never shared: `central` = rules for Central, `canvas` = procedures for Claude agents on the canvas. */
export type SkillAudience = 'central' | 'canvas'
export const SKILL_AUDIENCES: readonly SkillAudience[] = ['central', 'canvas']
/** True for a legal audience value. */
export const isSkillAudience = (v: unknown): v is SkillAudience => typeof v === 'string' && (SKILL_AUDIENCES as readonly string[]).includes(v)
/** Central loads (and acts on) only `central` skills; canvas ones stay list-only for it. */
export const centralSees = (a: SkillAudience): boolean => a === 'central'
/** Canvas agents see only `canvas` skills; `central` ones (Central's own rules) stay invisible. */
export const canvasSees = (a: SkillAudience): boolean => a === 'canvas'

/** One row of the skill index (`central_skill`). */
export interface SkillRecord {
  name: string
  version: string
  /** Hash of the whole folder, locked at activation and re-checked on every load. */
  sha256: string | null
  status: SkillStatus
  origin: SkillOrigin
  audience: SkillAudience
  /** Tool verbs the skill may ask for; a subset of what central owns. */
  caps: readonly string[]
  createdAt: number
  proposedBy: string | null
  approvedBy: string | null
  approvedAt: number | null
  evalScore: number | null
  /** On/off switch independent of `status`; absent means on. A disabled skill is neither indexed nor loadable. */
  enabled?: boolean
}

/** Cheap line for the stable prompt prefix (index <= 500 tokens). */
export interface SkillIndexEntry {
  name: string
  description: string
}

/** Skill body returned by JIT `skill.load`. */
export interface SkillContent {
  record: SkillRecord
  body: string
}

/** Input of `skill.propose`; writes to `proposed/` only, never to `active/`. */
export interface SkillProposeInput {
  name: string
  description: string
  body: string
  caps: readonly string[]
  /** Required: who the skill is for; there is no silent default for a new proposal. */
  audience: SkillAudience
}

/** Failure codes of the store; callers never parse messages. */
export type SkillErrorCode = 'invalid' | 'not_found' | 'hash_mismatch' | 'limit' | 'forbidden' | 'invalid_audience' | 'audience_forbidden' | 'audience_immutable'

/** File-backed skill store; the SQLite index is rebuildable from folders. */
export interface SkillStore {
  /** Prompt-prefix index of active skills. */
  index(): Awaitable<readonly SkillIndexEntry[]>
  /** Lists records, optionally by status, newest first. */
  list(status?: SkillStatus): Awaitable<readonly SkillRecord[]>
  /** Loads an active skill after verifying its hash; null when absent or disabled. */
  load(name: string): Awaitable<SkillContent | null>
  /** Stores a draft for lint and eval. */
  propose(input: SkillProposeInput, proposedBy: string): Awaitable<SkillRecord>
  /** Human-only: locks the hash and switches `active/<name>`. */
  approve(name: string, version: string, approvedBy: string): Awaitable<SkillRecord>
  /** Human-only: points `active/<name>` back to the previous version. */
  rollback(name: string, by: string): Awaitable<SkillRecord>
}
