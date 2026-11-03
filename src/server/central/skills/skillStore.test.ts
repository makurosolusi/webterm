import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeSqlite } from '../../nodeSqlite.testutil'
import { DAY_MS, MAX_ACTIVE_SKILLS, SKILL_PERMISSION, SkillError, getRecord, isSkillName, putRecord } from './skillIndex'
import { confirmPhrase } from './skillLifecycle'
import { type SkillAdminStore, createSkillStore } from './skillStore'

const HUMAN = 'human:alice'
let root: string
let clock: number
let raw: ReturnType<typeof nodeSqlite>
let store: SkillAdminStore
const input = (over: Partial<{ name: string; description: string; body: string; caps: string[] }> = {}) => ({ name: 'webterm-demo', description: 'Summarize status. Use when asked.', body: '1. Read the portfolio.\n2. Write five lines.', caps: ['portfolio.read'], ...over })
const codeOf = (fn: () => unknown): string | undefined => { try { fn() } catch (err) { return err instanceof SkillError ? err.code : `other:${String(err)}` } return undefined }
async function activate(name: string, version: string): Promise<void> {
  await store.evaluate(name, version)
  store.submit(name, version)
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

  it('cannot be replaced by a proposal or rolled back', () => {
    store.installBuiltins()
    expect(codeOf(() => store.propose(input({ name: 'webterm-central-basics' }), 'central:c1'))).toBe('forbidden')
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
  it('walks proposed -> evaluated -> pending_approval -> active and only then loads', async () => {
    const rec = store.propose(input(), 'central:c1')
    expect(rec).toMatchObject({ status: 'proposed', origin: 'central', version: '1', approvedBy: null })
    expect(existsSync(join(root, 'proposed', 'webterm-demo', '1', 'SKILL.md'))).toBe(true)
    expect(store.load('webterm-demo')).toBeNull()
    expect(store.index()).toEqual([])
    expect(codeOf(() => store.approve('webterm-demo', '1', HUMAN, confirmPhrase('webterm-demo', '1')))).toBe('forbidden')
    expect((await store.evaluate('webterm-demo', '1')).status).toBe('evaluated')
    expect(codeOf(() => store.approve('webterm-demo', '1', HUMAN, confirmPhrase('webterm-demo', '1')))).toBe('forbidden')
    expect(store.submit('webterm-demo', '1').status).toBe('pending_approval')
    expect(store.load('webterm-demo')).toBeNull()
    const active = store.approve('webterm-demo', '1', HUMAN, confirmPhrase('webterm-demo', '1'))
    expect(active).toMatchObject({ status: 'active', approvedBy: HUMAN, approvedAt: clock })
    expect(readlinkSync(join(root, 'active', 'webterm-demo'))).toBe(join('..', 'versions', 'webterm-demo', '1'))
    expect(readFileSync(join(root, 'versions', 'webterm-demo', '1', 'SKILL.sha256'), 'utf8').trim()).toBe(active.sha256)
    expect(existsSync(join(root, 'proposed', 'webterm-demo', '1'))).toBe(false)
    expect(store.load('webterm-demo')?.body).toContain('Read the portfolio')
    expect(store.index()).toEqual([{ name: 'webterm-demo', description: 'Summarize status. Use when asked.' }])
  })

  it('activation needs a human actor and the exact typed confirmation (R3)', async () => {
    store.propose(input(), 'central:c1')
    await store.evaluate('webterm-demo', '1')
    store.submit('webterm-demo', '1')
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

  it('a failing evaluator or a human reject ends in rejected, never active', async () => {
    const failing = createSkillStore({ db: raw.db, root, now: () => clock, evaluator: () => ({ passed: false, score: 0.2 }) })
    failing.propose(input(), 'central:c1')
    expect(await failing.evaluate('webterm-demo', '1')).toMatchObject({ status: 'rejected', evalScore: 0.2 })
    expect(codeOf(() => failing.submit('webterm-demo', '1'))).toBe('forbidden')
    failing.propose(input({ name: 'webterm-two' }), 'central:c1')
    expect(codeOf(() => failing.reject('webterm-two', '1', 'central:c1'))).toBe('forbidden')
    expect(failing.reject('webterm-two', '1', HUMAN).status).toBe('rejected')
    expect(failing.load('webterm-two')).toBeNull()
  })

  it('hash differs when content differs and is locked at proposal', () => {
    const a = store.propose(input(), 'central:c1')
    const b = store.propose(input({ name: 'webterm-other', body: `${input().body}\n3. One more line.` }), 'central:c1')
    const c = store.propose(input({ name: 'webterm-third' }), 'central:c1')
    expect(a.sha256).not.toBe(b.sha256)
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(c.sha256).not.toBe(a.sha256)
  })
})

describe('quarantine tamper checks', () => {
  async function pending() {
    store.propose(input(), 'central:c1')
    await store.evaluate('webterm-demo', '1')
    store.submit('webterm-demo', '1')
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
  it('evaluate rejects a draft that was edited after propose', async () => {
    store.propose(input(), 'central:c1')
    appendFileSync(join(root, 'proposed', 'webterm-demo', '1', 'SKILL.md'), 'x\n')
    expect(await store.evaluate('webterm-demo', '1').catch((e: SkillError) => e.code)).toBe('hash_mismatch')
    expect(getRecord(raw.db, 'webterm-demo', '1')?.status).toBe('rejected')
  })
})

describe('rollback and active-state tamper', () => {
  it('v2 replaces v1, rollback restores v1 by repointing, a second rollback has nowhere to go', async () => {
    store.propose(input(), 'central:c1')
    await activate('webterm-demo', '1')
    const v2 = store.propose(input({ body: '1. Newer procedure.' }), 'central:c1')
    expect(v2.version).toBe('2')
    await activate('webterm-demo', '2')
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
    store.propose(input(), 'central:c1')
    await activate('webterm-demo', '1')
    store.propose(input({ body: '1. Newer procedure.' }), 'central:c1')
    await activate('webterm-demo', '2')
    appendFileSync(join(root, 'versions', 'webterm-demo', '1', 'SKILL.md'), 'tampered\n')
    expect(codeOf(() => store.rollback('webterm-demo', HUMAN))).toBe('hash_mismatch')
    expect(store.load('webterm-demo')?.record.version).toBe('2')
  })

  it.each([
    ['edited content', (d: string) => appendFileSync(join(d, 'SKILL.md'), 'new instruction\n')],
    ['added script', (d: string) => writeFileSync(join(d, 'run.sh'), 'echo hi\n')],
    ['deleted folder', (d: string) => rmSync(d, { recursive: true })],
  ])('load disables a skill after %s', async (_label, tamper) => {
    store.propose(input(), 'central:c1')
    await activate('webterm-demo', '1')
    tamper(join(root, 'versions', 'webterm-demo', '1'))
    expect(store.load('webterm-demo')).toBeNull()
    expect(getRecord(raw.db, 'webterm-demo', '1')?.status).toBe('disabled')
    expect(store.index()).toEqual([])
  })

  it('load disables a skill whose active pointer was redirected', async () => {
    store.propose(input(), 'central:c1')
    await activate('webterm-demo', '1')
    store.propose(input({ body: '1. Other.' }), 'central:c1')
    const other = join(root, 'proposed', 'webterm-demo', '2')
    rmSync(join(root, 'active', 'webterm-demo'))
    symlinkSync(other, join(root, 'active', 'webterm-demo'))
    expect(store.load('webterm-demo')).toBeNull()
    expect(getRecord(raw.db, 'webterm-demo', '1')?.status).toBe('disabled')
  })
})

describe('propose guards', () => {
  it('lint failures throw invalid with codes only and write nothing', () => {
    const err = (() => { try { store.propose(input({ body: 'Run rm -rf build and open ../x' }), 'central:c1') } catch (e) { return e as SkillError } return null })()
    expect(err?.code).toBe('invalid')
    expect(err?.issues).toEqual(expect.arrayContaining(['danger', 'traversal']))
    expect(existsSync(join(root, 'proposed'))).toBe(false)
    expect(store.list()).toEqual([])
  })
  it('rejects traversal and non-webterm names before touching the filesystem', () => {
    for (const name of ['../evil', 'webterm-../x', 'frontend-design', 'webterm-a/b', '']) expect(codeOf(() => store.propose(input({ name }), 'central:c1'))).toBe('invalid')
    expect(codeOf(() => store.propose({ ...input(), caps: 'x' as never }, 'central:c1'))).toBe('invalid')
    expect(readdirSync(root)).toEqual([])
  })
  it('allows one open proposal per name and 3 central proposals per day', async () => {
    store.propose(input(), 'central:c1')
    expect(codeOf(() => store.propose(input(), 'central:c1'))).toBe('limit')
    store.propose(input({ name: 'webterm-b' }), 'central:c1')
    store.propose(input({ name: 'webterm-c' }), 'central:c1')
    expect(codeOf(() => store.propose(input({ name: 'webterm-d' }), 'central:c1'))).toBe('limit')
    expect(store.propose(input({ name: 'webterm-d' }), `${HUMAN}`).origin).toBe('human')
    clock += DAY_MS + 1
    expect(store.propose(input({ name: 'webterm-e' }), 'central:c1').status).toBe('proposed')
  })
  it('caps the number of active skills', async () => {
    for (let i = 0; i < MAX_ACTIVE_SKILLS; i += 1) putRecord(raw.db, { name: `webterm-fill-${i}`, version: '1', sha256: null, status: 'active', origin: 'human', caps: [], createdAt: 1, proposedBy: null, approvedBy: HUMAN, approvedAt: 1, evalScore: null }, 'filler')
    store.propose(input(), 'central:c1')
    await store.evaluate('webterm-demo', '1')
    store.submit('webterm-demo', '1')
    expect(codeOf(() => store.approve('webterm-demo', '1', HUMAN, confirmPhrase('webterm-demo', '1')))).toBe('limit')
  })
})

describe('list and index', () => {
  it('filters by status, pages, and keeps the index inside its budget', () => {
    for (const n of ['a', 'b', 'c']) store.propose(input({ name: `webterm-${n}` }), HUMAN)
    expect(store.list('proposed')).toHaveLength(3)
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
