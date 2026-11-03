// Skill persistence: folder layout, folder hash, coded errors and the rebuildable SQLite index (`central_skill`).
// Layout under <root>: builtin/<n>/<v>, proposed/<n>/<v>, versions/<n>/<v> (approved), active/<n> -> ../versions/<n>/<v>.
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillErrorCode, SkillOrigin, SkillRecord, SkillStatus } from '../contracts/skill.types'
import { SKILL_NAME_RE } from './skillLint'

export const HASH_FILE = 'SKILL.sha256'
export const SKILL_FILE = 'SKILL.md'
export const MAX_ACTIVE_SKILLS = 20
export const MAX_PROPOSALS_PER_DAY = 3
export const DAY_MS = 86_400_000
export const DEFAULT_LIST_LIMIT = 50
/** OpenCode `permission.skill` for the central child: hide every skill except webterm-* (RND/25 4.4). */
export const SKILL_PERMISSION: Readonly<Record<string, 'allow' | 'deny'>> = { '*': 'deny', 'webterm-*': 'allow' }

/** Coded failure of the skill store; `issues` carries lint codes only. */
export class SkillError extends Error {
  constructor(readonly code: SkillErrorCode, message: string, readonly issues: readonly string[] = []) { super(message) }
}

/** Everything a skill operation needs; `allowedCaps` narrows `webterm.caps` when set. */
export interface SkillCtx { db: Database; root: string; now(): number; allowedCaps?: ReadonlySet<string> }

/** True for names that may become a path segment and pass `permission.skill`. */
export function isSkillName(name: unknown): name is string { return typeof name === 'string' && name.length <= 64 && SKILL_NAME_RE.test(name) }

/** Throws `invalid` unless `name` is a safe skill name (guards every path join). */
export function assertSkillName(name: string): void {
  if (!isSkillName(name)) throw new SkillError('invalid', 'skill name must match webterm-<slug>')
}

/** Folder of one skill version in a bucket. */
export function skillDir(root: string, bucket: 'builtin' | 'proposed' | 'versions', name: string, version: string): string {
  assertSkillName(name)
  if (!/^[0-9]{1,6}$/.test(version)) throw new SkillError('invalid', 'skill version must be an integer')
  return join(root, bucket, name, version)
}

/** sha256 over file names and bytes of a flat skill folder; symlinks and subfolders are refused. */
export function hashFolder(dir: string): string {
  const hash = createHash('sha256')
  for (const entry of readdirSync(dir).sort()) {
    if (entry === HASH_FILE) continue
    if (!lstatSync(join(dir, entry)).isFile()) throw new SkillError('invalid', 'skill folder holds a non-file entry', ['extra_file'])
    hash.update(entry).update('\0').update(readFileSync(join(dir, entry))).update('\0')
  }
  return hash.digest('hex')
}

export const DDL_SKILL = `
CREATE TABLE IF NOT EXISTS central_skill (
  name TEXT NOT NULL, version TEXT NOT NULL, sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed','rejected','evaluated','pending_approval','active','disabled','archived')),
  origin TEXT NOT NULL CHECK (origin IN ('builtin','human','central')),
  description TEXT NOT NULL DEFAULT '', caps TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(caps)),
  created_at INTEGER NOT NULL, proposed_by TEXT, approved_by TEXT, approved_at INTEGER, eval_score REAL,
  PRIMARY KEY (name, version)
);
CREATE INDEX IF NOT EXISTS idx_central_skill_status ON central_skill (status, created_at);
`

interface Row { name: string; version: string; sha256: string | null; status: SkillStatus; origin: SkillOrigin; description: string; caps: string; created_at: number; proposed_by: string | null; approved_by: string | null; approved_at: number | null; eval_score: number | null }
const toRecord = (r: Row): SkillRecord => ({ name: r.name, version: r.version, sha256: r.sha256, status: r.status, origin: r.origin, caps: JSON.parse(r.caps) as string[], createdAt: r.created_at, proposedBy: r.proposed_by, approvedBy: r.approved_by, approvedAt: r.approved_at, evalScore: r.eval_score })

/** Creates the index table when missing (idempotent). */
export function ensureSkillTable(db: Database): void { db.exec(DDL_SKILL) }

/** Inserts or replaces one record. */
export function putRecord(db: Database, rec: SkillRecord, description: string): void {
  db.query('INSERT OR REPLACE INTO central_skill (name, version, sha256, status, origin, description, caps, created_at, proposed_by, approved_by, approved_at, eval_score) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(rec.name, rec.version, rec.sha256, rec.status, rec.origin, description, JSON.stringify(rec.caps), rec.createdAt, rec.proposedBy, rec.approvedBy, rec.approvedAt, rec.evalScore)
}

/** Patches status and optional columns of one version. */
export function setStatus(db: Database, name: string, version: string, status: SkillStatus, extra: { evalScore?: number; approvedBy?: string; approvedAt?: number } = {}): void {
  db.query('UPDATE central_skill SET status = ?, eval_score = COALESCE(?, eval_score), approved_by = COALESCE(?, approved_by), approved_at = COALESCE(?, approved_at) WHERE name = ? AND version = ?')
    .run(status, extra.evalScore ?? null, extra.approvedBy ?? null, extra.approvedAt ?? null, name, version)
}

/** One record or null. */
export function getRecord(db: Database, name: string, version: string): SkillRecord | null {
  const row = db.query('SELECT * FROM central_skill WHERE name = ? AND version = ?').get(name, version) as Row | null
  return row ? toRecord(row) : null
}

/** The single active version of a name, or null. */
export function activeRecord(db: Database, name: string): SkillRecord | null {
  const row = db.query("SELECT * FROM central_skill WHERE name = ? AND status = 'active'").get(name) as Row | null
  return row ? toRecord(row) : null
}

/** All versions of a name, highest first. */
export function versionsOf(db: Database, name: string): SkillRecord[] {
  return (db.query('SELECT * FROM central_skill WHERE name = ? ORDER BY CAST(version AS INTEGER) DESC').all(name) as Row[]).map(toRecord)
}

/** Newest-first page, optionally by status. */
export function listRecords(db: Database, status: SkillStatus | undefined, limit = DEFAULT_LIST_LIMIT, offset = 0): SkillRecord[] {
  const where = status ? 'WHERE status = ?' : ''
  const args = status ? [status, limit, offset] : [limit, offset]
  return (db.query(`SELECT * FROM central_skill ${where} ORDER BY created_at DESC, name, CAST(version AS INTEGER) DESC LIMIT ? OFFSET ?`).all(...args) as Row[]).map(toRecord)
}

/** Count of records created by `origin` since `since` (daily proposal quota). */
export function countCreatedSince(db: Database, origin: SkillOrigin, since: number): number {
  return (db.query('SELECT COUNT(*) AS n FROM central_skill WHERE origin = ? AND created_at > ?').get(origin, since) as { n: number }).n
}

/** Number of active skills. */
export function countActive(db: Database): number { return (db.query("SELECT COUNT(*) AS n FROM central_skill WHERE status = 'active'").get() as { n: number }).n }

/** Name + description of active skills, name order, capped by `limit`. */
export function activeDescriptions(db: Database, limit: number): Array<{ name: string; description: string }> {
  return db.query("SELECT name, description FROM central_skill WHERE status = 'active' ORDER BY name LIMIT ?").all(limit) as Array<{ name: string; description: string }>
}
