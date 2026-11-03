// Bun-only (fs + bun:sqlite). User memory files: outside git, rebuildable index, revoke.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryFilePort } from './memoryFilePath'
import { rebuildMemoryIndex } from './memoryFile'
import { rememberUser } from './memoryRemember'
import { createUserMemoryStore, parseUserMemoryFile, rebuildUserMemory, renderUserMemoryFile, revokeUserMemory, userMemoryRoot } from './memoryUserStore'
import { T0, addMessage, fixture, rejected, same, subset, thrown } from './memoryV2.fixture'

/** Runs `fn` with a fresh temp memory root, removed afterwards (bun:test shim has no beforeEach/afterEach). */
async function inRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wt-umem-'))
  try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

const FILE = { id: 'u1', key: 'user.lang.reply', title: 'Reply language', kind: 'preference' as const, trust: 'attested' as const, sourceRef: 'm1', updatedAt: T0, body: 'always reply in Indonesian' }
const HUMAN = { kind: 'human' as const, id: 'root' }

test('the file is written under user/, the root .gitignore excludes it, and the content round-trips', () => inRoot(async (root) => {
  const store = createUserMemoryStore(createMemoryFilePort(root))
  await store.write(FILE)
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('/user/')
  const text = await readFile(join(root, 'user', 'user.lang.reply.md'), 'utf8')
  expect(text).toContain('"formatVersion": 2')
  same(parseUserMemoryFile(text), FILE)
  await store.write({ ...FILE, body: 'changed' })
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('/user/\n')
}))

test('a v1 file without formatVersion still parses; a forged trust is read as attested; garbage is rejected', async () => {
  const v1 = renderUserMemoryFile(FILE).replace('"formatVersion": 2,\n', '').replace('"attested"', '"core"')
  expect(parseUserMemoryFile(v1).trust).toBe('attested')
  expect(thrown(() => parseUserMemoryFile('no frontmatter'))).toContain('frontmatter')
  expect(thrown(() => parseUserMemoryFile('---\n{bad json}\n---\nbody'))).toContain('not JSON')
  expect(thrown(() => parseUserMemoryFile(renderUserMemoryFile(FILE).replace('"scope": "user"', '"scope": "core"')))).toContain('scope')
})

test('file bodies are redacted on write (a hand-edited secret never re-enters the index)', () => {
  expect(renderUserMemoryFile({ ...FILE, body: 'token sk-CANARY0123456789abcdefghij here' })).not.toContain('CANARY')
})

test('rebuild imports unknown files as attested user facts, skips known ones, counts rejects', () => inRoot(async (root) => {
  const db = fixture()
  const store = createUserMemoryStore(createMemoryFilePort(root))
  await store.write(FILE)
  await mkdir(join(root, 'user'), { recursive: true })
  await writeFile(join(root, 'user', 'broken.md'), 'nothing here')
  same(await rebuildUserMemory(db, store, T0), { imported: 1, skipped: 0, rejected: 1 })
  same(db.query("SELECT scope, status, trust, project_id, body FROM memory WHERE id='u1'").get(), { scope: 'user', status: 'fact', trust: 'attested', project_id: null, body: FILE.body })
  same(await rebuildUserMemory(db, store, T0), { imported: 0, skipped: 1, rejected: 1 })
}))

test('revoke (human only) quarantines the row, deletes the file, and rebuild does not resurrect it', () => inRoot(async (root) => {
  const db = fixture()
  const store = createUserMemoryStore(createMemoryFilePort(root))
  addMessage(db, 'central:global', 'human', 'I am allergic to peanuts, mention it.')
  const { record } = await rememberUser(db, { conversationId: 'central:global', projectId: null, now: T0 }, { key: 'user.health.allergy', quote: 'allergic to peanuts' }, store)
  const path = join(root, 'user', 'user.health.allergy.md')
  expect(existsSync(path)).toBe(true)
  expect(await rejected(() => revokeUserMemory(db, store, { kind: 'central', id: 'c' }, record.id, 'no'))).toContain('MemoryAuthorityError')
  expect(existsSync(path)).toBe(true)
  const revoked = await revokeUserMemory(db, store, HUMAN, record.id, 'user asked to forget')
  expect(revoked.status).toBe('quarantine')
  expect(existsSync(path)).toBe(false)
  subset(await rebuildUserMemory(db, store, T0), { imported: 0 })
}))

test('the project-facts rebuild ignores user/ files and never touches them', () => inRoot(async (root) => {
  const db = fixture()
  const port = createMemoryFilePort(root)
  await createUserMemoryStore(port).write(FILE)
  const report = await rebuildMemoryIndex(db, port, undefined, true)
  same(report.rejected, [])
  expect(report.scanned).toBe(0)
}))

test('memory root: absolute WEBTERM_MEMORY_DIR wins, relative or empty falls back to <dataDir>/memory', () => {
  expect(userMemoryRoot({ WEBTERM_MEMORY_DIR: '/srv/mem' }, '/data')).toBe('/srv/mem')
  expect(userMemoryRoot({ WEBTERM_MEMORY_DIR: 'rel/mem' }, '/data')).toBe('/data/memory')
  expect(userMemoryRoot({}, '/data')).toBe('/data/memory')
})
