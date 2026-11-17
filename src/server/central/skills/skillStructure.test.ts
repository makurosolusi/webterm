// Title + body template at the store: required for new proposals, stored and listed, builtins conform, legacy rows still load.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeSqlite } from '../../nodeSqlite.testutil'
import { GOOD_BODY, GOOD_TITLE } from './skillDraft.testutil'
import { SkillError, ensureSkillTable, getRecord } from './skillIndex'
import { confirmPhrase } from './skillLifecycle'
import { BUILTIN_DIR, type SkillAdminStore, createSkillStore, readBuiltinDir } from './skillStore'
import { lintSkill } from './skillLint'

const HUMAN = 'human:alice'
let root: string
let raw: ReturnType<typeof nodeSqlite>
let store: SkillAdminStore
const draft = (over: Record<string, unknown> = {}) => ({ name: 'webterm-demo', title: GOOD_TITLE, description: 'Summarize status. Use when asked.', body: GOOD_BODY, caps: [], audience: 'central', ...over }) as never
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as SkillError)
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'structure-')); raw = nodeSqlite(); store = createSkillStore({ db: raw.db, root }) })
afterEach(() => { raw.raw.close(); rmSync(root, { recursive: true, force: true }) })

describe('proposal title and template', () => {
  it('stores the title, lists it and keeps it in the SKILL.md frontmatter', async () => {
    const rec = await store.propose(draft(), 'central:c1')
    expect(rec.title).toBe(GOOD_TITLE)
    expect(store.list('pending_approval')[0].title).toBe(GOOD_TITLE)
    expect(getRecord(raw.db, 'webterm-demo', '1')?.title).toBe(GOOD_TITLE)
    store.approve('webterm-demo', '1', HUMAN, confirmPhrase('webterm-demo', '1'))
    expect(store.load('webterm-demo')?.record.title).toBe(GOOD_TITLE)
  })

  it('refuses a missing or invalid title with the lint code title', async () => {
    for (const title of [undefined, '', 'ab', 'x'.repeat(81), 'two\nlines', '**bold**']) {
      const err = await failure(store.propose(draft({ title }), 'central:c1'))
      expect(err?.code).toBe('invalid')
      if (typeof title === 'string') expect(err?.issues).toContain('title')
    }
    expect(store.list()).toEqual([])
  })

  it('names each missing template section in the issues', async () => {
    const err = await failure(store.propose(draft({ body: '1. Do a thing.\n2. Do another.', audience: 'canvas' }), 'agent:n1'))
    expect(err).toBeInstanceOf(SkillError)
    expect(err?.issues).toContain('structure')
    for (const s of ['Purpose', 'When to use', 'Steps', 'Do not', 'Done when']) expect(err?.issues).toContain(`structure:missing ## ${s}`)
  })
})

describe('builtin and legacy skills', () => {
  it('every shipped builtin passes the strict lint (title and template) and is stored with its title', () => {
    for (const [name, text] of Object.entries(readBuiltinDir(BUILTIN_DIR))) {
      const r = lintSkill(text, { expectedName: name, requireStructure: true })
      expect([name, r.issues, r.structure]).toEqual([name, [], []])
    }
    store.installBuiltins()
    expect(store.list('active').every((r) => (r.title ?? '').length >= 3)).toBe(true)
  })

  it('the builtin skill-authoring text documents kind, title, template and the intake checklist', () => {
    const text = readBuiltinDir(BUILTIN_DIR)['webterm-skill-authoring']
    for (const word of ['kind', 'title', '## ', 'Purpose', 'When to use', 'Steps', 'Do not', 'Done when', 'name slug', 'trigger', 'constraints', 'success criteria']) expect(text.toLowerCase()).toContain(word.toLowerCase())
  })

  it('a legacy active skill without title or template still loads, and its title falls back to empty', () => {
    const legacy = '---\nname: webterm-old\ndescription: "Old skill."\nmetadata:\n  webterm.version: "1"\n---\n1. Do the old thing.\n'
    const s = createSkillStore({ db: raw.db, root, builtins: { 'webterm-old': legacy } })
    s.installBuiltins()
    expect(s.load('webterm-old')?.body).toContain('old thing')
    expect(s.load('webterm-old')?.record.title).toBe('')
  })

  it('adds the title column to an older table with default empty and is safe to run twice', () => {
    const old = nodeSqlite()
    old.db.exec(`CREATE TABLE central_skill (name TEXT NOT NULL, version TEXT NOT NULL, sha256 TEXT,
      status TEXT NOT NULL CHECK (status IN ('proposed','rejected','evaluated','pending_approval','active','disabled','archived')),
      origin TEXT NOT NULL CHECK (origin IN ('builtin','human','central','agent')), description TEXT NOT NULL DEFAULT '', caps TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, proposed_by TEXT, approved_by TEXT, approved_at INTEGER, eval_score REAL, reject_reason TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      audience TEXT NOT NULL DEFAULT 'central', PRIMARY KEY (name, version))`)
    old.db.exec("INSERT INTO central_skill (name, version, status, origin, created_at) VALUES ('webterm-old','1','active','human',1)")
    ensureSkillTable(old.db)
    ensureSkillTable(old.db)
    expect(getRecord(old.db, 'webterm-old', '1')?.title).toBe('')
    old.raw.close()
  })
})
