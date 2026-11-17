import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeSqlite } from '../../nodeSqlite.testutil'
import { DAY_MS, MAX_AGENT_PROPOSALS_PER_DAY, MAX_PROPOSALS_PER_DAY, SkillError, ensureSkillTable } from './skillIndex'
import { type SkillAdminStore, createSkillStore } from './skillStore'

const HUMAN = 'human:alice'
let root: string
let clock: number
let raw: ReturnType<typeof nodeSqlite>
let store: SkillAdminStore
const input = (name = 'webterm-demo', body = '1. Read the portfolio.') => ({ name, description: 'Summarize status. Use when asked.', body, caps: ['portfolio.read'] })
const code = (p: unknown): string | undefined => { try { (p as () => unknown)(); return undefined } catch (e) { return e instanceof SkillError ? e.code : `other:${String(e)}` } }
const asyncCode = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => (e instanceof SkillError ? e.code : `other:${String(e)}`))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-manage-'))
  clock = 1_700_000_000_000
  raw = nodeSqlite()
  store = createSkillStore({ db: raw.db, root, now: () => clock })
})
afterEach(() => { raw.raw.close(); rmSync(root, { recursive: true, force: true }) })

describe('enabled switch', () => {
  it('a disabled skill is not loadable or indexed, shows enabled:false, and survives a new version and a reboot', async () => {
    await store.propose(input(), HUMAN)
    store.approve('webterm-demo', '1', HUMAN, undefined, true)
    expect(store.load('webterm-demo')?.body).toContain('portfolio')
    store.setEnabled('webterm-demo', false, HUMAN)
    expect(store.load('webterm-demo')).toBeNull()
    expect(store.index()).toEqual([])
    expect(store.list('active')[0].enabled).toBe(false)
    const v2 = await store.propose(input('webterm-demo', '1. Newer.'), HUMAN)
    expect(v2.enabled).toBe(false)
    store.setEnabled('webterm-demo', true, HUMAN)
    expect(store.index().map((e) => e.name)).toEqual(['webterm-demo'])
    expect(store.load('webterm-demo')?.record.enabled).toBe(true)
  })

  it('needs a human actor and an existing name; builtin skills can be switched off and stay off after reinstall', () => {
    expect(code(() => store.setEnabled('webterm-demo', false, 'central:c1'))).toBe('forbidden')
    expect(code(() => store.setEnabled('webterm-nope', false, HUMAN))).toBe('not_found')
    store.installBuiltins()
    store.setEnabled('webterm-central-basics', false, HUMAN)
    expect(store.load('webterm-central-basics')).toBeNull()
    expect(store.index().map((e) => e.name)).not.toContain('webterm-central-basics')
    store.installBuiltins()
    expect(store.load('webterm-central-basics')).toBeNull()
  })
})

describe('one-click approval', () => {
  it('is allowed for a human-origin draft, refused for central and agent origin, which still take the typed phrase', async () => {
    await store.propose(input('webterm-h'), HUMAN)
    expect(store.approve('webterm-h', '1', HUMAN, undefined, true).status).toBe('active')
    for (const [name, by] of [['webterm-c', 'central:c1'], ['webterm-a', 'agent:node1']] as const) {
      await store.propose(input(name), by)
      expect(code(() => store.approve(name, '1', HUMAN, undefined, true))).toBe('forbidden')
      expect(code(() => store.approve(name, '1', HUMAN))).toBe('forbidden')
      expect(store.approve(name, '1', HUMAN, `approve ${name}@1`).status).toBe('active')
    }
  })

  it('still needs a human actor and the pending state, and a tampered draft fails the hash lock', async () => {
    await store.propose(input('webterm-h'), HUMAN)
    expect(code(() => store.approve('webterm-h', '1', 'central:c1', undefined, true))).toBe('forbidden')
    store.reject('webterm-h', '1', HUMAN)
    expect(code(() => store.approve('webterm-h', '1', HUMAN, undefined, true))).toBe('forbidden')
    await store.propose(input('webterm-t'), HUMAN)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(root, 'proposed', 'webterm-t', '1', 'SKILL.md'), 'tampered')
    expect(code(() => store.approve('webterm-t', '1', HUMAN, undefined, true))).toBe('hash_mismatch')
  })
})

describe('agent origin', () => {
  it('maps agent: proposers to origin agent with a daily cap separate from central', async () => {
    for (let i = 0; i < MAX_AGENT_PROPOSALS_PER_DAY; i++) expect((await store.propose(input(`webterm-a${i}`), `agent:n${i}`)).origin).toBe('agent')
    expect(await asyncCode(store.propose(input('webterm-a9'), 'agent:n9'))).toBe('limit')
    for (let i = 0; i < MAX_PROPOSALS_PER_DAY; i++) expect((await store.propose(input(`webterm-c${i}`), 'central:x')).origin).toBe('central')
    expect(await asyncCode(store.propose(input('webterm-c9'), 'central:x'))).toBe('limit')
    clock += DAY_MS + 1
    expect((await store.propose(input('webterm-a10'), 'agent:n1')).origin).toBe('agent')
  })
})

describe('rejected drafts and fork', () => {
  it('a human reject keeps the row with a reason code', async () => {
    await store.propose(input(), HUMAN)
    expect(store.reject('webterm-demo', '1', HUMAN)).toMatchObject({ status: 'rejected' })
    expect(store.list('rejected')[0].rejectReason).toBe('rejected_by_human')
  })

  it('forks a builtin into the next free copy name as a human draft', async () => {
    store.installBuiltins()
    const first = await store.fork('webterm-central-basics', HUMAN)
    expect(first).toMatchObject({ name: 'webterm-central-basics-copy', origin: 'human', status: 'pending_approval' })
    store.reject(first.name, '1', HUMAN)
    expect((await store.fork('webterm-central-basics', HUMAN)).name).toBe('webterm-central-basics-copy-2')
    expect((await store.fork('webterm-central-basics-copy', 'human:alice').catch((e: unknown) => e)) instanceof SkillError).toBe(true)
    expect(await asyncCode(store.fork('webterm-central-basics', 'central:c1'))).toBe('forbidden')
    expect(await asyncCode(store.fork('webterm-missing', HUMAN))).toBe('not_found')
  })
})

describe('central_skill migration', () => {
  const OLD = `CREATE TABLE central_skill (name TEXT NOT NULL, version TEXT NOT NULL, sha256 TEXT,
    status TEXT NOT NULL CHECK (status IN ('proposed','rejected','evaluated','pending_approval','active','disabled','archived')),
    origin TEXT NOT NULL CHECK (origin IN ('builtin','human','central')), description TEXT NOT NULL DEFAULT '', caps TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, proposed_by TEXT, approved_by TEXT, approved_at INTEGER, eval_score REAL, PRIMARY KEY (name, version))`

  it('upgrades an old table in place, keeps rows (enabled backfilled to 1), accepts agent origin, and is idempotent', () => {
    const old = nodeSqlite()
    old.db.exec(OLD)
    old.db.exec("INSERT INTO central_skill (name, version, status, origin, created_at) VALUES ('webterm-x', '1', 'active', 'human', 5)")
    ensureSkillTable(old.db)
    ensureSkillTable(old.db)
    const row = old.db.query('SELECT enabled, reject_reason FROM central_skill WHERE name = ?').get('webterm-x') as { enabled: number; reject_reason: string | null }
    expect(row).toEqual({ enabled: 1, reject_reason: null })
    old.db.exec("INSERT INTO central_skill (name, version, status, origin, created_at) VALUES ('webterm-y', '1', 'proposed', 'agent', 6)")
    const idx = old.db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_central_skill_status'").get() as { n: number }
    expect(idx.n).toBe(1)
    old.raw.close()
  })
})
