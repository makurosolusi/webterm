// File-backed skill store with a SQLite index. Central may only `propose`; activation is the human admin path.
import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillContent, SkillIndexEntry, SkillOrigin, SkillProposeInput, SkillRecord, SkillStatus, SkillStore } from '../contracts/skill.types'
import { type SkillEvaluator, activeDir, approveSkill, evaluateSkill, rejectSkill, rollbackSkill, staticEvaluator, submitForApproval, verifyFolder } from './skillLifecycle'
import {
  DAY_MS, HASH_FILE, MAX_ACTIVE_SKILLS, MAX_PROPOSALS_PER_DAY, SKILL_FILE, type SkillCtx, SkillError, activeDescriptions, activeRecord, assertSkillName,
  countCreatedSince, ensureSkillTable, hashFolder, isSkillName, listRecords, putRecord, setStatus, skillDir, versionsOf,
} from './skillIndex'
import { formatSkill, lintSkill } from './skillLint'

/** Prompt-prefix budget of the skill index: 500 tokens at 4 chars per token (RND/25 4.6). */
export const INDEX_CHAR_BUDGET = 2000
const OPEN_STATES: readonly SkillStatus[] = ['proposed', 'evaluated', 'pending_approval']
const BUILTIN_ACTOR = 'system:builtin'
export const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'builtin')

export interface SkillStoreOptions { db: Database; root: string; now?: () => number; evaluator?: SkillEvaluator; allowedCaps?: ReadonlySet<string>; builtinDir?: string }
export interface SkillPage { limit?: number; offset?: number }

/** `SkillStore` plus the human-only admin steps; none of these are exposed as tools. */
export interface SkillAdminStore extends SkillStore {
  index(): readonly SkillIndexEntry[]
  list(status?: SkillStatus, page?: SkillPage): readonly SkillRecord[]
  load(name: string): SkillContent | null
  propose(input: SkillProposeInput, proposedBy: string): SkillRecord
  rollback(name: string, by: string): SkillRecord
  /** Needs a `human:` actor and the typed phrase from `confirmPhrase`. */
  approve(name: string, version: string, approvedBy: string, typedConfirm?: string): SkillRecord
  evaluate(name: string, version: string): Promise<SkillRecord>
  submit(name: string, version: string): SkillRecord
  reject(name: string, version: string, by: string): SkillRecord
  /** Copies shipped `webterm-*` skills into the data dir and registers them active. */
  installBuiltins(): readonly SkillRecord[]
}

function proposeSkill(ctx: SkillCtx, input: SkillProposeInput, proposedBy: string): SkillRecord {
  if (typeof input?.description !== 'string' || typeof input.body !== 'string' || !Array.isArray(input.caps) || input.caps.some((c) => typeof c !== 'string')) throw new SkillError('invalid', 'propose input shape is invalid')
  if (typeof proposedBy !== 'string' || proposedBy.length < 1 || proposedBy.length > 100) throw new SkillError('invalid', 'proposedBy is required')
  assertSkillName(input.name)
  const existing = versionsOf(ctx.db, input.name)
  if (existing.some((r) => r.origin === 'builtin')) throw new SkillError('forbidden', 'builtin skills cannot be replaced')
  if (existing.some((r) => OPEN_STATES.includes(r.status))) throw new SkillError('limit', `${input.name} already has an open proposal`)
  const origin: SkillOrigin = proposedBy.startsWith('human:') ? 'human' : 'central'
  if (origin === 'central' && countCreatedSince(ctx.db, 'central', ctx.now() - DAY_MS) >= MAX_PROPOSALS_PER_DAY) throw new SkillError('limit', `at most ${MAX_PROPOSALS_PER_DAY} proposals per day`)
  const version = String((existing.length ? Number(existing[0].version) : 0) + 1)
  const text = formatSkill({ name: input.name, description: input.description, body: input.body, caps: input.caps, version, origin })
  const lint = lintSkill(text, { expectedName: input.name, ...(ctx.allowedCaps ? { allowedCaps: ctx.allowedCaps } : {}) })
  if (!lint.ok) throw new SkillError('invalid', `proposal ${input.name} failed lint`, lint.issues)
  const dir = skillDir(ctx.root, 'proposed', input.name, version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SKILL_FILE), text, { flag: 'wx' })
  const rec: SkillRecord = { name: input.name, version, sha256: hashFolder(dir), status: 'proposed', origin, caps: lint.meta?.caps ?? [], createdAt: ctx.now(), proposedBy, approvedBy: null, approvedAt: null, evalScore: null }
  putRecord(ctx.db, rec, input.description)
  return rec
}

function loadSkill(ctx: SkillCtx, name: string): SkillContent | null {
  if (!isSkillName(name)) return null
  const rec = activeRecord(ctx.db, name)
  if (!rec) return null
  try {
    return { record: rec, body: verifyFolder(ctx, rec, activeDir(ctx, rec)).body }
  } catch (err) {
    // Tampered, relinked or missing content disables the skill (recorded in status); other errors surface.
    if (err instanceof SkillError || (err as NodeJS.ErrnoException).code === 'ENOENT') { setStatus(ctx.db, name, rec.version, 'disabled'); return null }
    throw err
  }
}

function installBuiltins(ctx: SkillCtx, source: string): SkillRecord[] {
  if (!existsSync(source)) return []
  const out: SkillRecord[] = []
  for (const entry of readdirSync(source).sort()) {
    if (!isSkillName(entry)) continue
    const text = readFileSync(join(source, entry, SKILL_FILE), 'utf8')
    const lint = lintSkill(text, { expectedName: entry })
    if (!lint.ok || !lint.meta?.version) throw new SkillError('invalid', `builtin skill ${entry} failed lint`, lint.issues)
    const { version, description, caps } = lint.meta
    const dir = skillDir(ctx.root, 'builtin', entry, version)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SKILL_FILE), text)
    const sha256 = hashFolder(dir)
    writeFileSync(join(dir, HASH_FILE), `${sha256}\n`)
    const previous = activeRecord(ctx.db, entry)
    if (previous && previous.version !== version) setStatus(ctx.db, entry, previous.version, 'archived')
    const rec: SkillRecord = { name: entry, version, sha256, status: 'active', origin: 'builtin', caps, createdAt: ctx.now(), proposedBy: null, approvedBy: BUILTIN_ACTOR, approvedAt: ctx.now(), evalScore: null }
    putRecord(ctx.db, rec, description)
    out.push(rec)
  }
  return out
}

/** Creates the store, ensuring the index table exists. */
export function createSkillStore(opts: SkillStoreOptions): SkillAdminStore {
  ensureSkillTable(opts.db)
  const ctx: SkillCtx = { db: opts.db, root: opts.root, now: opts.now ?? Date.now, ...(opts.allowedCaps ? { allowedCaps: opts.allowedCaps } : {}) }
  const evaluator = opts.evaluator ?? staticEvaluator
  return {
    index(): readonly SkillIndexEntry[] {
      let used = 0
      const out: SkillIndexEntry[] = []
      for (const row of activeDescriptions(ctx.db, MAX_ACTIVE_SKILLS)) {
        used += row.name.length + row.description.length + 4
        if (used > INDEX_CHAR_BUDGET) break
        out.push(row)
      }
      return out
    },
    list: (status, page = {}) => listRecords(ctx.db, status, page.limit, page.offset),
    load: (name) => loadSkill(ctx, name),
    propose: (input, proposedBy) => proposeSkill(ctx, input, proposedBy),
    approve: (name, version, approvedBy, typedConfirm) => approveSkill(ctx, name, version, approvedBy, typedConfirm),
    rollback: (name, by) => rollbackSkill(ctx, name, by),
    evaluate: (name, version) => evaluateSkill(ctx, name, version, evaluator),
    submit: (name, version) => submitForApproval(ctx, name, version),
    reject: (name, version, by) => rejectSkill(ctx, name, version, by),
    installBuiltins: () => installBuiltins(ctx, opts.builtinDir ?? BUILTIN_DIR),
  }
}
