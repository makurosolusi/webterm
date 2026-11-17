// Audience (central | canvas): lint, stored record, built-ins, prompt index, fork and the guarded column migration.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeSqlite } from '../../nodeSqlite.testutil'
import { confirmPhrase } from './skillLifecycle'
import { SkillError, ensureSkillTable, getRecord } from './skillIndex'
import { formatSkill, lintSkill } from './skillLint'
import { type SkillAdminStore, createSkillStore } from './skillStore'

const base = { name: 'webterm-demo', description: 'Summarize a project. Use when asked for status.', body: '1. Read the portfolio.\n2. Write five lines.', caps: ['portfolio.read'], version: '1', origin: 'human' }
const HUMAN = 'human:alice'
const input = (over: Record<string, unknown> = {}) => ({ name: 'webterm-demo', description: 'Summarize status. Use when asked.', body: '1. Read the portfolio.', caps: [], audience: 'canvas' as const, ...over }) as never
let root: string
let raw: ReturnType<typeof nodeSqlite>
let store: SkillAdminStore
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'audience-')); raw = nodeSqlite(); store = createSkillStore({ db: raw.db, root }) })
afterEach(() => { raw.raw.close(); rmSync(root, { recursive: true, force: true }) })

const activate = async (over: Record<string, unknown>) => {
  const rec = await store.propose(input(over), HUMAN)
  store.approve(rec.name, rec.version, HUMAN, confirmPhrase(rec.name, rec.version))
  return rec
}

describe('lint', () => {
  it.each(['central', 'canvas'])('accepts webterm.audience %s and reports it in meta', (audience) => {
    const r = lintSkill(formatSkill({ ...base, audience }), { expectedName: 'webterm-demo' })
    expect(r.ok).toBe(true)
    expect(r.meta?.audience).toBe(audience)
  })
  it('flags an unknown audience value with the issue code audience', () => {
    const r = lintSkill(formatSkill({ ...base, audience: 'everyone' }), { expectedName: 'webterm-demo' })
    expect(r.ok).toBe(false)
    expect(r.issues).toEqual(['audience'])
  })
  it('still accepts a legacy file without the key (meta.audience null)', () => {
    const legacy = formatSkill({ ...base, audience: 'canvas' }).replace(/ {2}webterm\.audience: .*\n/, '')
    const r = lintSkill(legacy, { expectedName: 'webterm-demo' })
    expect(r.ok).toBe(true)
    expect(r.meta?.audience).toBeNull()
  })
})

describe('store', () => {
  it('round-trips the audience through propose, approve, load and list', async () => {
    for (const audience of ['central', 'canvas'] as const) {
      const rec = await activate({ name: `webterm-a-${audience}`, audience })
      expect(rec.audience).toBe(audience)
      expect(store.load(rec.name)?.record.audience).toBe(audience)
      expect(getRecord(raw.db, rec.name, '1')?.audience).toBe(audience)
    }
    expect(store.list('active').map((r) => r.audience).sort()).toEqual(['canvas', 'central'])
  })
  it('refuses a missing or unknown audience with invalid_audience and stores nothing', async () => {
    for (const audience of [undefined, 'everyone', 3]) {
      const err = await store.propose(input({ audience }), HUMAN).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SkillError)
      expect((err as SkillError).code).toBe('invalid_audience')
      expect((err as SkillError).message).toContain('central | canvas')
    }
    expect(store.list()).toEqual([])
  })
  it('builtins are central; Central prompt index lists central skills and never canvas ones', async () => {
    const recs = store.installBuiltins()
    expect(recs.map((r) => r.audience)).toEqual(['central', 'central', 'central', 'central'])
    await activate({ name: 'webterm-canvas-only', audience: 'canvas' })
    await activate({ name: 'webterm-central-own', audience: 'central' })
    const indexed = store.index().map((e) => e.name)
    expect(indexed).not.toContain('webterm-canvas-only')
    expect(indexed).toContain('webterm-central-own')
    expect(indexed).toHaveLength(5)
  })
  it('an agent actor can only write canvas skills (audience_forbidden), a human or Central can write either', async () => {
    const code = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => (e as SkillError).code)
    expect(await code(store.propose(input({ name: 'webterm-x-one', audience: 'central' }), 'agent:n1'))).toBe('audience_forbidden')
    expect(store.list()).toEqual([])
    expect((await store.propose(input({ name: 'webterm-x-two', audience: 'canvas' }), 'agent:n1')).audience).toBe('canvas')
    expect((await store.propose(input({ name: 'webterm-x-three', audience: 'central' }), 'central:c1')).audience).toBe('central')
    expect((await store.propose(input({ name: 'webterm-x-four', audience: 'central' }), HUMAN)).audience).toBe('central')
  })
  it('a new version keeps the kind (audience_immutable); fork is how a skill gets the other kind', async () => {
    await activate({ audience: 'canvas' })
    const err = await store.propose(input({ audience: 'central' }), HUMAN).catch((e: unknown) => e)
    expect((err as SkillError).code).toBe('audience_immutable')
    expect((await store.propose(input({ body: '1. Newer.' }), HUMAN)).version).toBe('2')
    expect((await store.fork('webterm-demo', HUMAN)).audience).toBe('canvas')
    expect((await store.fork('webterm-demo', HUMAN, 'central')).audience).toBe('central')
  })
})

describe('ensureSkillTable migration', () => {
  // The table as it was before audience existed (agent origin already present).
  const OLD = `CREATE TABLE central_skill (
    name TEXT NOT NULL, version TEXT NOT NULL, sha256 TEXT,
    status TEXT NOT NULL CHECK (status IN ('proposed','rejected','evaluated','pending_approval','active','disabled','archived')),
    origin TEXT NOT NULL CHECK (origin IN ('builtin','human','central','agent')),
    description TEXT NOT NULL DEFAULT '', caps TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, proposed_by TEXT, approved_by TEXT, approved_at INTEGER, eval_score REAL,
    reject_reason TEXT, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (name, version))`
  const cols = (d: ReturnType<typeof nodeSqlite>) => (d.db.query('PRAGMA table_info(central_skill)').all() as Array<{ name: string }>).map((c) => c.name)

  it('adds the column, backfills every existing row to central, and is safe to run twice', () => {
    const old = nodeSqlite()
    old.db.exec(OLD)
    old.db.exec("INSERT INTO central_skill (name, version, status, origin, created_at) VALUES ('webterm-old','1','active','human',1),('webterm-old2','1','proposed','agent',2)")
    expect(cols(old)).not.toContain('audience')
    ensureSkillTable(old.db)
    ensureSkillTable(old.db)
    expect(cols(old).filter((c) => c === 'audience')).toHaveLength(1)
    expect((old.db.query('SELECT audience FROM central_skill ORDER BY name').all() as Array<{ audience: string }>).map((r) => r.audience)).toEqual(['central', 'central'])
    expect(getRecord(old.db, 'webterm-old', '1')?.audience).toBe('central')
    expect(() => old.db.exec("UPDATE central_skill SET audience = 'nobody'")).toThrow()
    old.raw.close()
  })
  it('a pre-agent-origin table is rebuilt once and keeps the backfilled audience', () => {
    const older = nodeSqlite()
    older.db.exec(OLD.replace(",'agent'", ''))
    older.db.exec("INSERT INTO central_skill (name, version, status, origin, created_at) VALUES ('webterm-older','1','active','human',1)")
    ensureSkillTable(older.db)
    ensureSkillTable(older.db)
    expect(getRecord(older.db, 'webterm-older', '1')?.audience).toBe('central')
    older.raw.close()
  })
})
