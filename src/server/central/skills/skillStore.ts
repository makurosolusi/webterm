// File-backed skill store with a SQLite index. Central may only `propose`; activation is the human admin path.
import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type SkillAudience, type SkillContent, type SkillIndexEntry, SkillOrigin, SkillProposeInput, SkillRecord, SkillStatus, SkillStore, SKILL_AUDIENCES, isSkillAudience } from '../contracts/skill.types'
import { createLogger } from '../../logs'
import { type SkillEvaluator, activeDir, approveSkill, evaluateSkill, rejectSkill, requireHuman, rollbackSkill, staticEvaluator, submitForApproval, verifyFolder } from './skillLifecycle'
import {
  DAY_MS, HASH_FILE, MAX_ACTIVE_SKILLS, MAX_AGENT_PROPOSALS_PER_DAY, MAX_PROPOSALS_PER_DAY, SKILL_FILE, type SkillCtx, SkillError, type StoredSkill, activeDescriptions, activeRecord, assertSkillName,
  activeDescriptionMap, countCreatedSince, ensureSkillTable, getRecord, hashFolder, isSkillName, listRecords, putRecord, setEnabled, setStatus, skillDir, versionsOf,
} from './skillIndex'
import { formatSkill, lintSkill } from './skillLint'
import type { SkillToggle } from './skillToggleAudit'

/** Prompt-prefix budget of the skill index: 500 tokens at 4 chars per token (RND/25 4.6). */
export const INDEX_CHAR_BUDGET = 2000
const OPEN_STATES: readonly SkillStatus[] = ['proposed', 'evaluated', 'pending_approval']
const BUILTIN_ACTOR = 'system:builtin'
const SWEEP_LIMIT = 200
const log = createLogger('central.skills')
export const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'builtin')

/** SKILL.md text by skill name, read from a `builtin/`-shaped folder (dev and tests; the binary uses builtinSkills.embedded.ts). */
export function readBuiltinDir(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {}
  return Object.fromEntries(readdirSync(dir).filter(isSkillName).map((name) => [name, readFileSync(join(dir, name, SKILL_FILE), 'utf8')]))
}

/** `builtins`: shipped skills by name; defaults to reading BUILTIN_DIR from disk. */
export interface SkillStoreOptions { db: Database; root: string; now?: () => number; evaluator?: SkillEvaluator; allowedCaps?: ReadonlySet<string>; builtins?: Readonly<Record<string, string>> }
export interface SkillPage { limit?: number; offset?: number }

/** `SkillStore` plus the human-only admin steps; none of these are exposed as tools. */
export interface SkillAdminStore extends SkillStore {
  index(): readonly SkillIndexEntry[]
  /** Description of every active skill by name, audience-blind (agent list and edit; `index` is Central's audience-filtered view). */
  descriptions(): ReadonlyMap<string, string>
  list(status?: SkillStatus, page?: SkillPage): readonly StoredSkill[]
  load(name: string): SkillContent | null
  /** Stores the draft, then evaluates and submits it; resolves to its final state (`pending_approval` or `rejected`). */
  propose(input: SkillProposeInput, proposedBy: string): Promise<StoredSkill>
  rollback(name: string, by: string): SkillRecord
  /** Needs a `human:` actor (the route passes `confirmPhrase`); there is no other way to activate a draft. */
  approve(name: string, version: string, approvedBy: string, typedConfirm?: string): SkillRecord
  /** Human-only on/off switch, independent of status; builtin skills can be switched too. */
  setEnabled(name: string, enabled: boolean, by: string): SkillToggle
  evaluate(name: string, version: string): Promise<SkillRecord>
  submit(name: string, version: string): SkillRecord
  reject(name: string, version: string, by: string): SkillRecord
  /** Copies shipped `webterm-*` skills into the data dir and registers them active. */
  installBuiltins(): readonly SkillRecord[]
}

const originOf = (by: string): SkillOrigin => (by.startsWith('human:') ? 'human' : by.startsWith('agent:') ? 'agent' : 'central')

function proposeSkill(ctx: SkillCtx, input: SkillProposeInput, proposedBy: string): SkillRecord {
  if (typeof input?.title !== 'string' || typeof input.description !== 'string' || typeof input.body !== 'string' || !Array.isArray(input.caps) || input.caps.some((c) => typeof c !== 'string')) throw new SkillError('invalid', 'propose input shape is invalid')
  if (typeof proposedBy !== 'string' || proposedBy.length < 1 || proposedBy.length > 100) throw new SkillError('invalid', 'proposedBy is required')
  assertSkillName(input.name)
  if (!isSkillAudience(input.audience)) throw new SkillError('invalid_audience', `audience is required: ${SKILL_AUDIENCES.join(' | ')}`)
  const existing = versionsOf(ctx.db, input.name)
  const origin = originOf(proposedBy)
  // Security: Central loads `central` skills as rules, so no agent session may ever author one.
  if (origin === 'agent' && input.audience !== 'canvas') throw new SkillError('audience_forbidden', 'agent sessions may only write canvas skills')
  if (existing.some((r) => r.origin === 'builtin')) throw new SkillError('forbidden', 'builtin skills cannot be replaced')
  if (existing.length && existing[0].audience !== input.audience) throw new SkillError('audience_immutable', `${input.name} is a ${existing[0].audience} skill; a skill keeps its kind; write a new skill for the other kind`)
  if (existing.some((r) => OPEN_STATES.includes(r.status))) throw new SkillError('limit', `${input.name} already has an open proposal`)
  const cap = origin === 'central' ? MAX_PROPOSALS_PER_DAY : origin === 'agent' ? MAX_AGENT_PROPOSALS_PER_DAY : Infinity
  if (countCreatedSince(ctx.db, origin, ctx.now() - DAY_MS) >= cap) throw new SkillError('limit', `at most ${cap} ${origin} proposals per day`)
  const version = String((existing.length ? Number(existing[0].version) : 0) + 1)
  const text = formatSkill({ name: input.name, title: input.title, description: input.description, body: input.body, caps: input.caps, version, origin, audience: input.audience })
  const lint = lintSkill(text, { expectedName: input.name, requireStructure: true, ...(ctx.allowedCaps ? { allowedCaps: ctx.allowedCaps } : {}) })
  if (!lint.ok) throw new SkillError('invalid', `proposal ${input.name} failed lint`, [...lint.issues, ...lint.structure.map((p) => `structure:${p}`)])
  const dir = skillDir(ctx.root, 'proposed', input.name, version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SKILL_FILE), text, { flag: 'wx' })
  const rec: SkillRecord = { name: input.name, version, sha256: hashFolder(dir), status: 'proposed', origin, audience: input.audience, title: input.title, caps: lint.meta?.caps ?? [], createdAt: ctx.now(), proposedBy, approvedBy: null, approvedAt: null, evalScore: null, enabled: existing[0]?.enabled !== false }
  putRecord(ctx.db, rec, input.description)
  return rec
}

/** Evaluate then submit; a failure is logged and leaves the row rejected, it never reaches the proposer. */
async function advanceProposal(ctx: SkillCtx, rec: SkillRecord, evaluator: SkillEvaluator): Promise<StoredSkill> {
  const fields = { name: rec.name, version: rec.version }
  try {
    const evaluated = await evaluateSkill(ctx, rec.name, rec.version, evaluator)
    if (evaluated.status === 'evaluated') return submitForApproval(ctx, rec.name, rec.version)
    log.warn('skills.evaluate_rejected', `skill ${rec.name}@${rec.version} did not pass evaluation`, fields)
    return evaluated
  } catch (err) {
    log.error('skills.evaluate_failed', `could not evaluate skill ${rec.name}@${rec.version}`, { ...fields, error: err instanceof Error ? err.message : String(err) })
    return getRecord(ctx.db, rec.name, rec.version) ?? rec
  }
}

/** One pass over rows that were proposed before proposals advanced by themselves. */
async function advanceStuckProposals(ctx: SkillCtx, evaluator: SkillEvaluator): Promise<void> {
  for (const rec of listRecords(ctx.db, 'proposed', SWEEP_LIMIT)) await advanceProposal(ctx, rec, evaluator)
}

function loadSkill(ctx: SkillCtx, name: string): SkillContent | null {
  if (!isSkillName(name)) return null
  const rec = activeRecord(ctx.db, name)
  if (!rec || rec.enabled === false) return null
  try {
    return { record: rec, body: verifyFolder(ctx, rec, activeDir(ctx, rec)).body }
  } catch (err) {
    // Tampered, relinked or missing content disables the skill (recorded in status); other errors surface.
    if (err instanceof SkillError || (err as NodeJS.ErrnoException).code === 'ENOENT') { setStatus(ctx.db, name, rec.version, 'disabled'); return null }
    throw err
  }
}

function installBuiltins(ctx: SkillCtx, source: Readonly<Record<string, string>>): SkillRecord[] {
  const out: SkillRecord[] = []
  for (const entry of Object.keys(source).sort()) {
    if (!isSkillName(entry)) continue
    const text = source[entry]
    const lint = lintSkill(text, { expectedName: entry })
    if (!lint.ok || !lint.meta?.version) throw new SkillError('invalid', `builtin skill ${entry} failed lint`, lint.issues)
    const { version, description, caps } = lint.meta
    const title = lint.meta.title ?? ''
    // Built-ins are Central's own rules; a shipped file without `webterm.audience` stays central (see ensureSkillTable).
    const audience: SkillAudience = isSkillAudience(lint.meta.audience) ? lint.meta.audience : 'central'
    const dir = skillDir(ctx.root, 'builtin', entry, version)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SKILL_FILE), text)
    const sha256 = hashFolder(dir)
    writeFileSync(join(dir, HASH_FILE), `${sha256}\n`)
    const previous = activeRecord(ctx.db, entry)
    if (previous && previous.version !== version) setStatus(ctx.db, entry, previous.version, 'archived')
    const rec: SkillRecord = { name: entry, version, sha256, status: 'active', origin: 'builtin', audience, title, caps, createdAt: ctx.now(), proposedBy: null, approvedBy: BUILTIN_ACTOR, approvedAt: ctx.now(), evalScore: null, enabled: versionsOf(ctx.db, entry)[0]?.enabled !== false } // keep a human's off switch across boots
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
  void advanceStuckProposals(ctx, evaluator).catch((err: unknown) => log.error('skills.sweep_failed', 'could not advance stuck skill proposals', { error: err instanceof Error ? err.message : String(err) }))
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
    descriptions: () => activeDescriptionMap(ctx.db),
    list: (status, page = {}) => listRecords(ctx.db, status, page.limit, page.offset),
    load: (name) => loadSkill(ctx, name),
    propose: async (input, proposedBy) => advanceProposal(ctx, proposeSkill(ctx, input, proposedBy), evaluator),
    approve: (name, version, approvedBy, typedConfirm) => approveSkill(ctx, name, version, approvedBy, typedConfirm),
    setEnabled(name, enabled, by) {
      requireHuman(by)
      assertSkillName(name)
      const latest = versionsOf(ctx.db, name)[0]
      if (!latest || !setEnabled(ctx.db, name, enabled)) throw new SkillError('not_found', `skill ${name} not found`)
      return { name, version: latest.version, audience: latest.audience, from: latest.enabled !== false, to: enabled }
    },
    rollback: (name, by) => rollbackSkill(ctx, name, by),
    evaluate: (name, version) => evaluateSkill(ctx, name, version, evaluator),
    submit: (name, version) => submitForApproval(ctx, name, version),
    reject: (name, version, by) => rejectSkill(ctx, name, version, by),
    installBuiltins: () => installBuiltins(ctx, opts.builtins ?? readBuiltinDir(BUILTIN_DIR)),
  }
}
