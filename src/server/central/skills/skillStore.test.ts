import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeSqlite } from '../../nodeSqlite.testutil'
import { DAY_MS, DDL_SKILL, MAX_ACTIVE_SKILLS, SKILL_PERMISSION, SkillError, ensureSkillTable, getRecord, isSkillName, putRecord } from './skillIndex'
import { confirmPhrase } from './skillLifecycle'
import { type SkillAdminStore, createSkillStore } from './skillStore'

const HUMAN = 'human:alice'
let root: string
let clock: number
let raw: ReturnType<typeof nodeSqlite>
let store: SkillAdminStore
const input = (over: Partial<{ name: string; description: string; body: string; caps: string[] }> = {}) => ({ name: 'webterm-demo', description: 'Summarize status. Use when asked.', body: '1. Read the portfolio.\n2. Write five lines.', caps: ['portfolio.read'], ...over })
const codeOf = (fn: () => unknown): string | undefined => { try { fn() } catch (err) { return err instanceof SkillError ? err.code : `other:${String(err)}` } return undefined }
const asyncCode = (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (err: unknown) => (err instanceof SkillError ? err.code : `other:${String(err)}`))
function activate(name: string, version: string): void {
  store.approve(name, version, HUMAN, confirmPhrase(name, version))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws14-'))
  clock = 1_700_000_000_000
  raw = nodeSqlite()
  store = createSkillStore({ db: raw.db, root, now: () => clock })
})
afterEach(() => { raw.raw.close(); rmSync(root, { recursive: true, force: true }) })

describe('builtin skills', () => {
  it('installs the shipped webterm-* skills as active, loadable, hash-locked and indexed', () => {
    const recs = store.installBuiltins()
    expect(recs.map((r) => r.name)).toEqual(['webterm-approval-flow', 'webterm-central-basics', 'webterm-project-status', 'webterm-skill-authoring'])
    expect(recs.every((r) => r.status === 'active' && r.origin === 'builtin' && /^[0-9a-f]{64}$/.test(r.sha256 ?? ''))).toBe(true)
    const loaded = store.load('webterm-central-basics')
    expect(loaded?.body).toContain('You propose; humans and the server decide.')
    expect(store.index().map((e) => e.name)).toHaveLength(4)
    expect(store.installBuiltins()).toHaveLength(4)
    expect(store.list('active')).toHaveLength(4)
  })

  it('cannot be replaced by a proposal or rolled back', async () => {
    store.installBuiltins()
    expect(await asyncCode(store.propose(input({ name: 'webterm-central-basics' }), 'central:c1'))).toBe('forbidden')
    expect(codeOf(() => store.rollback('webterm-central-basics', HUMAN))).toBe('forbidden')
  })
})

describe('permission allowlist', () => {
  it('only webterm-* names pass and the OpenCode permission denies the rest', () => {
    expect(isSkillName('webterm-ok')).toBe(true)
    for (const bad of ['frontend-design', '../webterm-x', 'webterm-', 'webterm-X', 'webterm-a/b', 42]) expect(isSkillName(bad)).toBe(false)
    expect(SKILL_PERMISSION).toEqual({ '*': 'deny', 'webterm-*': 'allow' })
  })
})

describe('lifecycle', () => {
  it('a proposal reaches pending_approval on its own and only activation makes it loadable', async () => {
    const rec = await store.propose(input(), 'central:c1')
    expect(rec).toMatchObject({ status: 'pending_approval', origin: 'central', version: '1', approvedBy: null, evalScore: 1 })
    expect(existsSync(join(root, 'proposed', 'webterm-demo', '1', 'SKILL.md'))).toBe(true)
    expect(store.load('webterm-demo')).toBeNull()
    expect(store.index()).toEqual([])
    const active = store.approve('webterm-demo', '1', HUMAN, confirmPhrase('webterm-demo', '1'))
    expect(active).toMatchObject({ status: 'active', approvedBy: HUMAN, approvedAt: clock })
    expect(readlinkSync(join(root, 'active', 'webterm-demo'))).toBe(join('..', 'versions', 'webterm-demo', '1'))
    expect(readFileSync(join(root, 'versions', 'webterm-demo', '1', 'SKILL.sha256'), 'utf8').trim()).toBe(active.sha256)
    expect(existsSync(join(root, 'proposed', 'webterm-demo', '1'))).toBe(false)
    expect(store.load('webterm-demo')?.body).toContain('Read the portfolio')
    expect(store.index()).toEqual([{ name: 'webterm-demo', description: 'Summarize status. Use when asked.' }])
  })

  it('activation needs a human actor and the exact typed confirmation (R3)', async () => {
    await store.propose(input(), 'central:c1')
    const phrase = confirmPhrase('webterm-demo', '1')
    expect(codeOf(() => store.approve('webterm-demo', '1', 'central:c1', phrase))).toBe('forbidden')
    expect(codeOf(() => store.approve('webterm-demo', '1', 'system:builtin', phrase))).toBe('forbidden')
    expect(codeOf(() => store.approve('webterm-demo', '1', HUMAN))).toBe('forbidden')
    expect(codeOf(() => store.approve('webterm-demo', '1', HUMAN, 'yes'))).toBe('forbidden')
    expect(codeOf(() => store.approve('webterm-demo', '1', HUMAN, confirmPhrase('webterm-demo', '2')))).toBe('forbidden')
    expect(getRecord(raw.db, 'webterm-demo', '1')?.status).toBe('pending_approval')
    expect(codeOf(() => store.approve('webterm-demo', '9', HUMAN, confirmPhrase('webterm-demo', '9')))).toBe('not_found')
    expect(store.approve('webterm-demo', '1', HUMAN, phrase).status).toBe('active')
  })

  it('a failing evaluator rejects with a reason, never breaks propose, and frees the name', async () => {
    const failing = createSkillStore({ db: raw.db, root, now: () => clock, evaluator: () => ({ passed: false, score: 0.2 }) })
    const rec = await failing.propose(input(), 'central:c1')
    expect(rec).toMatchObject({ status: 'rejected', evalScore: 0.2, rejectReason: 'evaluation did not pass (score 0.2)' })
    expect(codeOf(() => failing.submit('webterm-demo', '1'))).toBe('forbidden')
    expect((await store.propose(input(), 'central:c1')).version).toBe('2')
  })

  it('an evaluator that throws leaves the row rejected and propose resolves', async () => {
    const broken = createSkillStore({ db: raw.db, root, now: () => clock, evaluator: () => { throw new Error('boom') } })
    expect(await broken.propose(input(), 'central:c1')).toMatchObject({ status: 'rejected', rejectReason: 'evaluator failed: boom' })
  })

  it('only a human can reject, and a reject frees the name', async () => {
    await store.propose(input(), 'central:c1')
    expect(codeOf(() => store.reject('webterm-demo', '1', 'central:c1'))).toBe('forbidden')
    const rejected = store.reject('webterm-demo', '1', HUMAN)
    expect(rejected.status).toBe('rejected')
    expect(rejected).not.toHaveProperty('rejectReason')
    expect(store.load('webterm-demo')).toBeNull()
    expect((await store.propose(input(), 'central:c1')).version).toBe('2')
  })

  it('hash differs when content differs and is locked at proposal', async () => {
    const a = await store.propose(input(), 'central:c1')
    const b = await store.propose(input({ name: 'webterm-other', body: `${input().body}\n3. One more line.` }), 'central:c1')
    const c = await store.propose(input({ name: 'webterm-third' }), 'central:c1')
    expect(a.sha256).not.toBe(b.sha256)
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(c.sha256).not.toBe(a.sha256)
  })
})

describe('quarantine tamper checks', () => {
  async function pending() {
    await store.propose(input(), 'central:c1')
    return join(root, 'proposed', 'webterm-demo', '1')
  }
  it('editing the draft after review blocks approval (hash_mismatch)', async () => {
    const dir = await pending()
    appendFileSync(join(dir, 'SKILL.md'), 'Also do something else.\n')
    expect(codeOf(() => store.approve('webterm-demo', '1', HUMAN, confirmPhrase('webterm-demo', '1')))).toBe('hash_mismatch')
    expect(getRecord(raw.db, 'webterm-demo', '1')?.status).toBe('pending_approval')
  })
  it('a dropped-in script or symlink blocks approval', async () => {
    const dir = await pending()
    writeFileSync(join(dir, 'run.sh'), 'echo hi\n')
    expect(codeOf(() => store.approve('webterm-demo', '1', HUMAN, confirmPhrase('webterm-demo', '1')))).toBe('hash_mismatch')
    rmSync(join(dir, 'run.sh'))
    symlinkSync('/tmp', join(dir, 'link'))
    expect(codeOf(() => store.approve('webterm-demo', '1', HUMAN, confirmPhrase('webterm-demo', '1')))).toBe('invalid')
    expect(existsSync(join(root, 'active', 'webterm-demo'))).toBe(false)
  })
})

describe('rows stuck in proposed', () => {
  const stick = (name: string) => raw.db.query("UPDATE central_skill SET status = 'proposed' WHERE name = ?").run(name)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('advance once when the store is created', async () => {
    await store.propose(input(), 'central:c1')
    stick('webterm-demo')
    createSkillStore({ db: raw.db, root, now: () => clock })
    await settle()
    expect(getRecord(raw.db, 'webterm-demo', '1')?.status).toBe('pending_approval')
  })

  it('a draft edited after propose is rejected with the reason, and the sweep survives it', async () => {
    await store.propose(input(), 'central:c1')
    await store.propose(input({ name: 'webterm-ok' }), 'central:c1')
    stick('webterm-demo')
    stick('webterm-ok')
    appendFileSync(join(root, 'proposed', 'webterm-demo', '1', 'SKILL.md'), 'x\n')
    createSkillStore({ db: raw.db, root, now: () => clock })
    await settle()
    expect(getRecord(raw.db, 'webterm-demo', '1')).toMatchObject({ status: 'rejected', rejectReason: expect.stringContaining('content changed') })
    expect(getRecord(raw.db, 'webterm-ok', '1')?.status).toBe('pending_approval')
  })

  it('adds the reason column to a table created before it existed, idempotently', () => {
    raw.db.exec('DROP TABLE central_skill')
    raw.db.exec(DDL_SKILL)
    ensureSkillTable(raw.db)
    ensureSkillTable(raw.db)
    const columns = raw.db.query('PRAGMA table_info(central_skill)').all() as Array<{ name: string }>
    expect(columns.filter((c) => c.name === 'reject_reason')).toHaveLength(1)
  })
})

describe('rollback and active-state tamper', () => {
  it('v2 replaces v1, rollback restores v1 by repointing, a second rollback has nowhere to go', async () => {
    await store.propose(input(), 'central:c1')
    activate('webterm-demo', '1')
    const v2 = await store.propose(input({ body: '1. Newer procedure.' }), 'central:c1')
    expect(v2.version).toBe('2')
    activate('webterm-demo', '2')
    expect(getRecord(raw.db, 'webterm-demo', '1')?.status).toBe('archived')
    expect(store.load('webterm-demo')?.body).toContain('Newer procedure')
    expect(codeOf(() => store.rollback('webterm-demo', 'central:c1'))).toBe('forbidden')
    expect(store.rollback('webterm-demo', HUMAN)).toMatchObject({ version: '1', status: 'active' })
    expect(readlinkSync(join(root, 'active', 'webterm-demo'))).toBe(join('..', 'versions', 'webterm-demo', '1'))
    expect(store.load('webterm-demo')?.body).toContain('Read the portfolio')
    expect(getRecord(raw.db, 'webterm-demo', '2')?.status).toBe('archived')
    expect(readdirSync(join(root, 'versions', 'webterm-demo')).sort()).toEqual(['1', '2'])
    expect(codeOf(() => store.rollback('webterm-demo', HUMAN))).toBe('not_found')
  })

  it('rollback refuses a target whose hash no longer matches', async () => {
    await store.propose(input(), 'central:c1')
    activate('webterm-demo', '1')
    await store.propose(input({ body: '1. Newer procedure.' }), 'central:c1')
    activate('webterm-demo', '2')
    appendFileSync(join(root, 'versions', 'webterm-demo', '1', 'SKILL.md'), 'tampered\n')
    expect(codeOf(() => store.rollback('webterm-demo', HUMAN))).toBe('hash_mismatch')
    expect(store.load('webterm-demo')?.record.version).toBe('2')
  })

  it.each([
    ['edited content', (d: string) => appendFileSync(join(d, 'SKILL.md'), 'new instruction\n')],
    ['added script', (d: string) => writeFileSync(join(d, 'run.sh'), 'echo hi\n')],
    ['deleted folder', (d: string) => rmSync(d, { recursive: true })],
  ])('load disables a skill after %s', async (_label, tamper) => {
    await store.propose(input(), 'central:c1')
    activate('webterm-demo', '1')
    tamper(join(root, 'versions', 'webterm-demo', '1'))
    expect(store.load('webterm-demo')).toBeNull()
    expect(getRecord(raw.db, 'webterm-demo', '1')?.status).toBe('disabled')
    expect(store.index()).toEqual([])
  })

  it('load disables a skill whose active pointer was redirected', async () => {
    await store.propose(input(), 'central:c1')
    activate('webterm-demo', '1')
    await store.propose(input({ body: '1. Other.' }), 'central:c1')
    const other = join(root, 'proposed', 'webterm-demo', '2')
    rmSync(join(root, 'active', 'webterm-demo'))
    symlinkSync(other, join(root, 'active', 'webterm-demo'))
    expect(store.load('webterm-demo')).toBeNull()
    expect(getRecord(raw.db, 'webterm-demo', '1')?.status).toBe('disabled')
  })
})

describe('propose guards', () => {
  it('lint failures throw invalid with codes only and write nothing', async () => {
    const err = await store.propose(input({ body: 'Run rm -rf build and open ../x' }), 'central:c1').then(() => null, (e: SkillError) => e)
    expect(err?.code).toBe('invalid')
    expect(err?.issues).toEqual(expect.arrayContaining(['danger', 'traversal']))
    expect(existsSync(join(root, 'proposed'))).toBe(false)
    expect(store.list()).toEqual([])
  })
  it('rejects traversal and non-webterm names before touching the filesystem', async () => {
    for (const name of ['../evil', 'webterm-../x', 'frontend-design', 'webterm-a/b', '']) expect(await asyncCode(store.propose(input({ name }), 'central:c1'))).toBe('invalid')
    expect(await asyncCode(store.propose({ ...input(), caps: 'x' as never }, 'central:c1'))).toBe('invalid')
    expect(readdirSync(root)).toEqual([])
  })
  it('allows one open proposal per name and 3 central proposals per day', async () => {
    await store.propose(input(), 'central:c1')
    expect(await asyncCode(store.propose(input(), 'central:c1'))).toBe('limit')
    await store.propose(input({ name: 'webterm-b' }), 'central:c1')
    await store.propose(input({ name: 'webterm-c' }), 'central:c1')
    expect(await asyncCode(store.propose(input({ name: 'webterm-d' }), 'central:c1'))).toBe('limit')
    expect((await store.propose(input({ name: 'webterm-d' }), `${HUMAN}`)).origin).toBe('human')
    clock += DAY_MS + 1
    expect((await store.propose(input({ name: 'webterm-e' }), 'central:c1')).status).toBe('pending_approval')
  })
  it('caps the number of active skills', async () => {
    for (let i = 0; i < MAX_ACTIVE_SKILLS; i += 1) putRecord(raw.db, { name: `webterm-fill-${i}`, version: '1', sha256: null, status: 'active', origin: 'human', caps: [], createdAt: 1, proposedBy: null, approvedBy: HUMAN, approvedAt: 1, evalScore: null }, 'filler')
    await store.propose(input(), 'central:c1')
    expect(codeOf(() => store.approve('webterm-demo', '1', HUMAN, confirmPhrase('webterm-demo', '1')))).toBe('limit')
  })
})

describe('list and index', () => {
  it('filters by status, pages, and keeps the index inside its budget', async () => {
    for (const n of ['a', 'b', 'c']) await store.propose(input({ name: `webterm-${n}` }), HUMAN)
    expect(store.list('pending_approval')).toHaveLength(3)
    expect(store.list('active')).toHaveLength(0)
    expect(store.list(undefined, { limit: 2 })).toHaveLength(2)
    expect(store.list(undefined, { limit: 2, offset: 2 })).toHaveLength(1)
    for (let i = 0; i < 15; i += 1) putRecord(raw.db, { name: `webterm-long-${i}`, version: '1', sha256: null, status: 'active', origin: 'human', caps: [], createdAt: 1, proposedBy: null, approvedBy: HUMAN, approvedAt: 1, evalScore: null }, 'd'.repeat(280))
    const entries = store.index()
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.length).toBeLessThan(15)
    expect(entries.reduce((n, e) => n + e.name.length + e.description.length, 0)).toBeLessThanOrEqual(2000)
  })
})
