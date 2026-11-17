// Skill lifecycle (RND/25 4.5): proposed -> eval -> pending_approval -> (human R3 typed confirm) -> hash lock -> active.
// Nothing here is reachable from a tool: only human-callable admin paths use approve/rollback.
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillRecord, SkillStatus } from '../contracts/skill.types'
import type { Awaitable } from '../contracts/tool.types'
import { writeTx } from '../writeTx'
import { HASH_FILE, MAX_ACTIVE_SKILLS, SKILL_FILE, type SkillCtx, SkillError, type StoredSkill, activeRecord, countActive, getRecord, hashFolder, setStatus, skillDir, versionsOf } from './skillIndex'
import { type LintResult, lintSkill } from './skillLint'

export interface SkillEvalInput { name: string; version: string; description: string; body: string; caps: readonly string[] }
export interface SkillEvalResult { passed: boolean; score: number }
/** Eval port; the scripted-runtime evaluator (WS-16) plugs in here. */
export type SkillEvaluator = (input: SkillEvalInput) => Awaitable<SkillEvalResult>
/** Default evaluator: lint already passed, so only the static gate applies. TODO(ca2-16): replace with the scripted runtime eval. */
export const staticEvaluator: SkillEvaluator = () => ({ passed: true, score: 1 })

const HUMAN_RE = /^human:[A-Za-z0-9._@-]{1,64}$/

/** The exact text a human types to activate a version (R3 typed confirm). */
export function confirmPhrase(name: string, version: string): string { return `approve ${name}@${version}` }

/** Throws `forbidden` unless `by` is a `human:*` actor. */
export function requireHuman(by: string): void {
  if (!HUMAN_RE.test(by)) throw new SkillError('forbidden', 'only a human actor may change skill activation')
}

const reasonOf = (err: unknown): string => {
  if (err instanceof SkillError && err.issues.length) return `${err.message}: ${err.issues.join(', ')}`
  return err instanceof Error ? err.message : String(err)
}

/** Loads a record or throws `not_found`. */
export function requireRecord(ctx: SkillCtx, name: string, version: string): StoredSkill {
  skillDir(ctx.root, 'proposed', name, version)
  const rec = getRecord(ctx.db, name, version)
  if (!rec) throw new SkillError('not_found', `skill ${name}@${version} not found`)
  return rec
}

function requireStatus(rec: SkillRecord, allowed: readonly SkillStatus[]): void {
  if (!allowed.includes(rec.status)) throw new SkillError('forbidden', `skill ${rec.name}@${rec.version} is ${rec.status}, expected ${allowed.join('|')}`)
}

/** Folder must match the locked hash and pass lint; otherwise throws `hash_mismatch` / `invalid`. */
export function verifyFolder(ctx: SkillCtx, rec: SkillRecord, dir: string): LintResult {
  let text: string
  try {
    if (hashFolder(dir) !== rec.sha256) throw new SkillError('hash_mismatch', `skill ${rec.name}@${rec.version} content changed since it was locked`)
    text = readFileSync(join(dir, SKILL_FILE), 'utf8')
  } catch (err) {
    if (err instanceof SkillError) throw err
    throw new SkillError('hash_mismatch', `skill ${rec.name}@${rec.version} folder unreadable`)
  }
  const lint = lintSkill(text, { expectedName: rec.name, ...(ctx.allowedCaps && rec.origin !== 'builtin' ? { allowedCaps: ctx.allowedCaps } : {}) })
  if (!lint.ok) throw new SkillError('invalid', `skill ${rec.name}@${rec.version} failed lint`, lint.issues)
  return lint
}

/** proposed -> evaluated (or rejected when lint, hash or eval fails). */
export async function evaluateSkill(ctx: SkillCtx, name: string, version: string, evaluator: SkillEvaluator): Promise<SkillRecord> {
  const rec = requireRecord(ctx, name, version)
  requireStatus(rec, ['proposed'])
  let lint: LintResult
  try { lint = verifyFolder(ctx, rec, skillDir(ctx.root, 'proposed', name, version)) } catch (err) {
    setStatus(ctx.db, name, version, 'rejected', { rejectReason: reasonOf(err) })
    throw err
  }
  let result: SkillEvalResult
  try { result = await evaluator({ name, version, description: lint.meta?.description ?? '', body: lint.body, caps: rec.caps }) } catch (err) {
    setStatus(ctx.db, name, version, 'rejected', { rejectReason: `evaluator failed: ${reasonOf(err)}` })
    throw new SkillError('invalid', `evaluator failed for ${name}@${version}: ${reasonOf(err)}`)
  }
  if (result.passed) setStatus(ctx.db, name, version, 'evaluated', { evalScore: result.score })
  else setStatus(ctx.db, name, version, 'rejected', { evalScore: result.score, rejectReason: `evaluation did not pass (score ${result.score})` })
  return requireRecord(ctx, name, version)
}

/** evaluated -> pending_approval: the item a human reviews. */
export function submitForApproval(ctx: SkillCtx, name: string, version: string): SkillRecord {
  requireStatus(requireRecord(ctx, name, version), ['evaluated'])
  setStatus(ctx.db, name, version, 'pending_approval')
  return requireRecord(ctx, name, version)
}

/** Human-only: proposed|evaluated|pending_approval -> rejected. */
export function rejectSkill(ctx: SkillCtx, name: string, version: string, by: string): SkillRecord {
  requireHuman(by)
  requireStatus(requireRecord(ctx, name, version), ['proposed', 'evaluated', 'pending_approval'])
  // A reason code keeps the draft listed (as rejected) instead of vanishing.
  setStatus(ctx.db, name, version, 'rejected', { rejectReason: 'rejected_by_human' })
  return requireRecord(ctx, name, version)
}

/** Atomically repoints `active/<name>` at `versions/<name>/<version>` (relative symlink, rename over the old one). */
function pointActive(root: string, name: string, version: string): void {
  const activeDir = join(root, 'active')
  mkdirSync(activeDir, { recursive: true })
  const tmp = join(activeDir, `.tmp-${name}`)
  rmSync(tmp, { force: true })
  symlinkSync(join('..', 'versions', name, version), tmp)
  renameSync(tmp, join(activeDir, name))
}

/**
 * Human-only R3: needs a pending_approval version, an intact hash and a clean re-lint. The human gate is the `human:*`
 * actor (one click in the UI, no typed phrase; docs/decisions/skill-approval.md). The route passes the internal phrase.
 */
export function approveSkill(ctx: SkillCtx, name: string, version: string, approvedBy: string, typedConfirm: string | undefined): SkillRecord {
  requireHuman(approvedBy)
  const rec = requireRecord(ctx, name, version)
  if (typedConfirm !== confirmPhrase(name, version)) throw new SkillError('forbidden', 'typed confirmation does not match')
  requireStatus(rec, ['pending_approval'])
  const previous = activeRecord(ctx.db, name)
  if (!previous && countActive(ctx.db) >= MAX_ACTIVE_SKILLS) throw new SkillError('limit', `at most ${MAX_ACTIVE_SKILLS} active skills`)
  const from = skillDir(ctx.root, 'proposed', name, version)
  verifyFolder(ctx, rec, from)
  const to = skillDir(ctx.root, 'versions', name, version)
  mkdirSync(join(ctx.root, 'versions', name), { recursive: true })
  renameSync(from, to)
  writeFileSync(join(to, HASH_FILE), `${rec.sha256}\n`)
  // ponytail: fs steps are not transactional with the DB; a crash between them leaves pending_approval, safe to retry.
  pointActive(ctx.root, name, version)
  writeTx(ctx.db, (db) => {
    if (previous) setStatus(db, name, previous.version, 'archived')
    setStatus(db, name, version, 'active', { approvedBy, approvedAt: ctx.now() })
  })
  return requireRecord(ctx, name, version)
}

/** Human-only: repoints `active/<name>` at the highest older archived version after re-verifying its hash. */
export function rollbackSkill(ctx: SkillCtx, name: string, by: string): SkillRecord {
  requireHuman(by)
  skillDir(ctx.root, 'proposed', name, '0')
  const current = activeRecord(ctx.db, name)
  if (!current) throw new SkillError('not_found', `no active version of ${name}`)
  if (current.origin === 'builtin') throw new SkillError('forbidden', 'builtin skills cannot be rolled back')
  const target = versionsOf(ctx.db, name).find((r) => r.status === 'archived' && Number(r.version) < Number(current.version))
  if (!target) throw new SkillError('not_found', `no earlier version of ${name} to roll back to`)
  verifyFolder(ctx, target, skillDir(ctx.root, 'versions', name, target.version))
  pointActive(ctx.root, name, target.version)
  writeTx(ctx.db, (db) => {
    setStatus(db, name, current.version, 'archived')
    setStatus(db, name, target.version, 'active', { approvedBy: by, approvedAt: ctx.now() })
  })
  return requireRecord(ctx, name, target.version)
}

/** Directory a loaded skill must come from; the symlink must resolve inside `versions/`. */
export function activeDir(ctx: SkillCtx, rec: SkillRecord): string {
  if (rec.origin === 'builtin') return skillDir(ctx.root, 'builtin', rec.name, rec.version)
  const expected = realpathSync(skillDir(ctx.root, 'versions', rec.name, rec.version))
  if (realpathSync(join(ctx.root, 'active', rec.name)) !== expected) throw new SkillError('hash_mismatch', `active pointer of ${rec.name} does not match its record`)
  return expected
}
