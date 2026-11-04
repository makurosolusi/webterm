// Bun-only: real git fixture repo, real bun:sqlite repo-map cache, real ledger for the tool def.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry } from '../central/tools/toolRegistry'
import { NOW, makeLedger, put, sh } from './knowledgeFixture.testutil'
import { createRepoMapDef } from './repoMap.def'
import { buildRepoMap, openRepoMapDb } from './repoMapCache'
import { rankFiles, renderMap } from './repoMapRank'
import { type FileSymbols, extractSymbols } from './repoMapSymbols'

/** test-only: one hub file whose symbols every other file uses, plus leaves in three languages. */
function hubRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rmfx-'))
  sh(dir, 'init', '-q')
  put(dir, {
    'src/hub.ts': 'export function formatHubPayload(x: number) { return x }\nexport class HubRegistry {}\n',
    'src/a.ts': "import { formatHubPayload } from './hub'\nexport function alphaLeaf() { return formatHubPayload(1) }\n",
    'src/b.ts': "import { formatHubPayload, HubRegistry } from './hub'\nexport const betaLeaf = new HubRegistry() && formatHubPayload(2)\n",
    'src/c.ts': "import { formatHubPayload } from './hub'\nexport function gammaLeaf() { return formatHubPayload(3) }\n",
    'tools/run.py': 'class Runner:\n    def start(self):\n        return formatHubPayload(4)\n\nMAX_RUNS = 3\n',
    'cmd/main.go': 'package main\n\nfunc mainLoop() { formatHubPayload(5) }\ntype Config struct{}\n',
    'README.md': '# not code\n',
  })
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

test('symbols: regex ctags-lite per language, own definitions are not self-references', () => {
  expect(extractSymbols('export async function foo() { foo() }\nconst bar = 1\n', 'ts').defs).toEqual([
    { name: 'foo', line: 1, kind: 'function' }, { name: 'bar', line: 2, kind: 'const' }])
  const ts = extractSymbols('export async function foo() { foo() }\n', 'ts')
  expect(ts.refs.foo).toBe(1)
  expect(extractSymbols('class A:\n    def m(self):\n        pass\nLIMIT = 2\n', 'py').defs.map((d) => `${d.kind} ${d.name}`)).toEqual(['class A', 'def m', 'const LIMIT'])
  expect(extractSymbols('func (s *S) Serve() {}\ntype T int\nvar V = 1\n', 'go').defs.map((d) => `${d.kind} ${d.name}`)).toEqual(['func Serve', 'type T', 'var V'])
})

test('rank: the hub file every other file references comes first', async () => {
  const root = hubRepo()
  const db = openRepoMapDb(':memory:')
  const m = await buildRepoMap(db, root)
  const first = m.text.split('\n')[0]
  expect(first).toBe('src/hub.ts:')
  expect(m.text.split('\n')[1]).toContain('function formatHubPayload')
  expect(m.text).toContain('tools/run.py:')
  expect(m.text).toContain('cmd/main.go:')
  expect(m.text).not.toContain('README.md')
  expect(m.totalFiles).toBe(6)
  rmSync(root, { recursive: true, force: true })
})

test('rank: focus files personalize the walk toward what they use', () => {
  const files = new Map<string, FileSymbols>([
    ['x.ts', { defs: [{ name: 'xOnlyHelperFn', line: 1, kind: 'function' }], refs: {} }],
    ['y.ts', { defs: [{ name: 'yOnlyHelperFn', line: 1, kind: 'function' }], refs: {} }],
    ['use.ts', { defs: [{ name: 'user', line: 1, kind: 'const' }], refs: { yOnlyHelperFn: 1 } }],
    ['other.ts', { defs: [{ name: 'other', line: 1, kind: 'const' }], refs: { xOnlyHelperFn: 3 } }],
  ])
  expect(rankFiles(files)[0]?.path).toBe('x.ts')
  const order = rankFiles(files, ['use.ts']).map((f) => f.path)
  expect(order.indexOf('y.ts') < order.indexOf('x.ts')).toBe(true)
})

test('render: output stays within the token budget, whole files only', async () => {
  const root = hubRepo()
  const m = await buildRepoMap(openRepoMapDb(':memory:'), root, { maxTokens: 16 })
  expect(m.tokens <= 16).toBe(true)
  expect(m.truncated).toBe(true)
  expect(renderMap([], 100)).toEqual({ text: '', files: 0, totalFiles: 0, truncated: false, tokens: 0 })
  rmSync(root, { recursive: true, force: true })
})

test('cache: a second build re-reads only the edited and new files, deleted files leave the cache', async () => {
  const root = hubRepo()
  const db = openRepoMapDb(':memory:')
  expect((await buildRepoMap(db, root)).parsed).toBe(6)
  const again = await buildRepoMap(db, root)
  expect([again.parsed, again.cached]).toEqual([0, 6])
  put(root, { 'src/a.ts': 'export function alphaRenamed() { return 1 }\n', 'src/new.ts': 'export const freshThing = 1\n' })
  sh(root, 'rm', '-q', 'src/c.ts')
  const third = await buildRepoMap(db, root)
  expect([third.parsed, third.cached]).toEqual([2, 4])
  expect(third.text).toContain('alphaRenamed')
  expect(third.text).not.toContain('gammaLeaf')
  expect(db.query('SELECT COUNT(*) AS n FROM repomap_file').get()).toEqual({ n: 6 })
  rmSync(root, { recursive: true, force: true })
})

test('repo.map tool: root comes from the ledger project; not a repo is a coded failure', async () => {
  const root = hubRepo()
  const ledger = makeLedger(root)
  const def = createRepoMapDef(() => openRepoMapDb(':memory:'))
  const ctx = { db: ledger, registry: createRegistry(), guard: { check: () => ({ ok: true as const }) }, maxTier: 'R0' as const, conversationId: 'c', now: () => NOW }
  const ok = await def.handler(ctx, { maxTokens: 512 }, 'p1')
  expect(ok.ok).toBe(true)
  expect(String((ok as unknown as { data: { map: string } }).data.map).startsWith('src/hub.ts:')).toBe(true)
  expect(await def.handler(ctx, {}, 'nope')).toEqual({ ok: false, code: 'project_not_found' })
  expect(def.validate({ maxTokens: 5 }, ctx)).toBe('invalid_shape')
  const plain = mkdtempSync(join(tmpdir(), 'rmplain-'))
  expect(await def.handler({ ...ctx, db: makeLedger(plain, 'p2') }, {}, 'p2')).toEqual({ ok: false, code: 'not_git' })
  rmSync(root, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
})
