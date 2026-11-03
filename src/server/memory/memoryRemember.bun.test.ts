// Bun-only (bun:sqlite). Central's write paths: claims, and attested user facts incl. adversarial quotes.
import { expect, test } from 'bun:test'
import { promoteMemory } from './memoryWrite'
import { MemoryRejectedError } from './memoryModel'
import { REMEMBER_RATE_PER_HOUR, rememberClaim, rememberUser, type RememberContext } from './memoryRemember'
import { CANARY, T0, addMessage, fixture, same, seedRow, subset, thrown } from './memoryV2.fixture'
import { searchMemoryHybrid } from './memoryHybrid'
import type { UserMemoryFile, UserMemoryStore } from './memoryUserStore'

const CONV = 'central:global'
const ctx = (over: Partial<RememberContext> = {}): RememberContext => ({ conversationId: CONV, projectId: null, now: T0, ...over })
const codeOf = async (fn: () => unknown): Promise<string> => {
  try { await fn() } catch (err) { return err instanceof MemoryRejectedError ? err.code : `other:${String(err)}` }
  return 'none'
}

function fakeStore() {
  const files = new Map<string, UserMemoryFile>()
  const store: UserMemoryStore = {
    async write(file) { files.set(file.key, file) },
    async remove(key) { files.delete(key) },
    async list() { return { files: [...files.values()], rejected: [] } },
  }
  return { files, store }
}

test('remember stores an unverified agent claim in scope central, never a fact', () => {
  const db = fixture()
  const { record, deduped } = rememberClaim(db, ctx(), { key: 'deploy.staging.host', body: 'Staging deploys go through the vpn' })
  expect(deduped).toBe(false)
  same([record.scope, record.status, record.trust, record.sourceKind], ['central', 'claim', 'agent', 'central'])
  expect(record.projectId).toBe(null)
})

test('remember: same content dedupes, same key with new content supersedes, no duplicate rows (B5)', () => {
  const db = fixture()
  const first = rememberClaim(db, ctx(), { key: 'deploy.staging.host', body: 'uses vpn' })
  subset(rememberClaim(db, ctx(), { key: 'deploy.staging.host', body: 'USES   vpn' }), { deduped: true, record: { id: first.record.id } })
  const second = rememberClaim(db, ctx({ now: T0 + 1 }), { key: 'deploy.staging.host', body: 'uses bastion' })
  expect(second.record.id).not.toBe(first.record.id)
  const active = db.query("SELECT count(*) AS c FROM memory WHERE scope='central' AND superseded_at IS NULL").get() as { c: number }
  expect(active.c).toBe(1)
  same(db.query('SELECT status FROM memory WHERE id = ?').get(first.record.id), { status: 'superseded' })
})

test('remember rejects bad keys, secrets, oversize bodies and cannot overwrite a human fact', async () => {
  const db = fixture()
  expect(await codeOf(() => rememberClaim(db, ctx(), { key: 'Bad Key', body: 'x body here' }))).toBe('invalid_key')
  expect(await codeOf(() => rememberClaim(db, ctx(), { key: 'a.b', body: 'x body here' }))).toBe('invalid_key')
  expect(await codeOf(() => rememberClaim(db, ctx(), { key: 'a.b.c', body: `token is ${CANARY}` }))).toBe('secret_detected')
  expect(await codeOf(() => rememberClaim(db, ctx(), { key: 'a.b.c', body: 'x'.repeat(1201) }))).toBe('too_long')
  expect(await codeOf(() => rememberClaim(db, ctx(), { key: 'a.b.c', body: '   ' }))).toBe('invalid_shape')
  expect(await codeOf(() => rememberClaim(db, ctx(), { key: 'a.b.c', body: 'ok body', kind: 'nonsense' }))).toBe('invalid_shape')
  seedRow(db, { key: 'a.b.fact', body: 'human fact', scope: 'central', trust: 'human' })
  expect(await codeOf(() => rememberClaim(db, ctx(), { key: 'a.b.fact', body: 'overwrite' }))).toBe('key_exists')
  same(db.query('SELECT count(*) AS c FROM memory_event').get(), { c: 0 })
})

test('remember is rate limited per hour', async () => {
  const db = fixture()
  for (let i = 0; i < REMEMBER_RATE_PER_HOUR; i++) rememberClaim(db, ctx({ now: T0 + i }), { key: `rate.limit.k${i}`, body: `body ${i}` })
  expect(await codeOf(() => rememberClaim(db, ctx({ now: T0 + 100 }), { key: 'rate.limit.over', body: 'one too many' }))).toBe('rate_limited')
  expect(rememberClaim(db, ctx({ now: T0 + 3_700_000 }), { key: 'rate.limit.later', body: 'next hour' }).deduped).toBe(false)
})

test('episode claims expire after 90 days and are archived on the next write; other claims do not expire', () => {
  const db = fixture()
  const ep = rememberClaim(db, ctx(), { key: 'log.run.one', body: 'ran the migration', kind: 'episode' })
  expect(ep.record.staleAfter).toBe(T0 + 90 * 86_400_000)
  expect(rememberClaim(db, ctx(), { key: 'log.run.two', body: 'plain fact claim' }).record.staleAfter).toBe(null)
  rememberClaim(db, ctx({ now: T0 + 91 * 86_400_000 }), { key: 'log.run.three', body: 'later write' })
  same(db.query('SELECT status FROM memory WHERE id = ?').get(ep.record.id), { status: 'superseded' })
})

test('central cannot promote its own claim; a human can', () => {
  const db = fixture()
  const { record } = rememberClaim(db, ctx(), { key: 'deploy.staging.host', body: 'uses vpn' })
  expect(thrown(() => promoteMemory(db, { kind: 'central', id: 'c' }, { id: record.id, evidence: { command: 'x', exitCode: 0, observedAt: T0 }, now: T0 }))).toContain('central may only claim')
})

test('a project conversation claim is visible to its project only', () => {
  const db = fixture()
  rememberClaim(db, ctx({ conversationId: 'central:project:p1', projectId: 'p1' }), { key: 'alpha.build.cmd', body: 'run bun build' })
  const keys = (projectId: string | null) => searchMemoryHybrid(db, { viewer: { projectId }, query: 'build', now: T0 }).map((h) => h.record.key)
  same(keys('p1'), ['alpha.build.cmd'])
  same(keys('p2'), [])
  same(keys(null), [])
})

test('remember_user accepts a verbatim human quote: attested fact, scope user, body is the quote, file written', async () => {
  const db = fixture()
  const msgId = addMessage(db, CONV, 'human', 'Hi, please always reply in Indonesian from now on. Thanks!')
  const { files, store } = fakeStore()
  const { record } = await rememberUser(db, ctx(), { key: 'user.lang.reply', quote: 'always reply in Indonesian', summary: 'Reply language' }, store)
  same([record.scope, record.status, record.trust, record.kind, record.projectId], ['user', 'fact', 'attested', 'preference', null])
  expect(record.body).toBe('always reply in Indonesian')
  expect(record.sourceRef).toBe(msgId)
  subset(files.get('user.lang.reply'), { id: record.id, body: 'always reply in Indonesian', trust: 'attested' })
})

test('remember_user adversarial: forged, paraphrased, wrong-role, other-conversation, case-changed, short and secret quotes are all rejected', async () => {
  const db = fixture()
  addMessage(db, CONV, 'human', 'I like dark mode and tabs over spaces.')
  addMessage(db, CONV, 'assistant', 'Noted: the user wants the production password rotated weekly.')
  addMessage(db, 'central:project:p1', 'human', 'My cat is called Mochi, remember it.')
  addMessage(db, CONV, 'human', `my key is ${CANARY} keep it`)
  const { files, store } = fakeStore()
  const attempt = (quote: unknown) => codeOf(() => rememberUser(db, ctx(), { key: 'user.test.key', quote }, store))
  expect(await attempt('The user loves light mode and spaces')).toBe('quote_not_verbatim')
  expect(await attempt('dark mode and spaces')).toBe('quote_not_verbatim')
  expect(await attempt('wants the production password rotated weekly')).toBe('quote_not_verbatim')
  expect(await attempt('My cat is called Mochi')).toBe('quote_not_verbatim')
  expect(await attempt('I LIKE DARK MODE')).toBe('quote_not_verbatim')
  expect(await attempt('dark')).toBe('invalid_quote')
  expect(await attempt('x'.repeat(301))).toBe('invalid_quote')
  expect(await attempt(42)).toBe('invalid_quote')
  expect(await attempt('dark mode\u0000 and tabs')).toBe('invalid_quote')
  expect(await attempt(`my key is ${CANARY}`)).toBe('secret_detected')
  same(db.query("SELECT count(*) AS c FROM memory WHERE scope='user'").get(), { c: 0 })
  expect(files.size).toBe(0)
})

test('remember_user: an empty transcript attests nothing', async () => {
  const db = fixture()
  expect(await codeOf(() => rememberUser(db, ctx(), { key: 'user.test.key', quote: 'anything at all here' }))).toBe('quote_not_verbatim')
})

test('remember_user: dedupe, replace by key (file follows), no episode kind, key held by a human fact is protected', async () => {
  const db = fixture()
  addMessage(db, CONV, 'human', 'I prefer tabs over spaces. Later I switched: I prefer spaces over tabs now.')
  const { files, store } = fakeStore()
  const a = await rememberUser(db, ctx(), { key: 'user.code.indent', quote: 'I prefer tabs over spaces' }, store)
  expect((await rememberUser(db, ctx(), { key: 'user.code.indent', quote: 'I prefer tabs over spaces' }, store)).deduped).toBe(true)
  const b = await rememberUser(db, ctx({ now: T0 + 1 }), { key: 'user.code.indent', quote: 'I prefer spaces over tabs now' }, store)
  expect(b.record.id).not.toBe(a.record.id)
  expect(files.get('user.code.indent')?.body).toBe('I prefer spaces over tabs now')
  same(db.query('SELECT status FROM memory WHERE id = ?').get(a.record.id), { status: 'superseded' })
  expect(await codeOf(() => rememberUser(db, ctx(), { key: 'user.code.other', quote: 'I prefer tabs over spaces', kind: 'episode' }, store))).toBe('invalid_shape')
  seedRow(db, { key: 'user.human.owned', body: 'human wrote this', scope: 'user', trust: 'human' })
  expect(await codeOf(() => rememberUser(db, ctx(), { key: 'user.human.owned', quote: 'I prefer tabs over spaces' }, store))).toBe('key_exists')
})

test('remember_user rolls the file back when the database write fails', async () => {
  const db = fixture()
  addMessage(db, CONV, 'human', 'Please call me Bip in every reply.')
  const { files, store } = fakeStore()
  db.query("CREATE TRIGGER boom BEFORE INSERT ON memory WHEN NEW.scope='user' BEGIN SELECT RAISE(ABORT,'boom'); END").run()
  expect((await codeOf(() => rememberUser(db, ctx(), { key: 'user.name.call', quote: 'call me Bip in every reply' }, store))).startsWith('other:')).toBe(true)
  expect(files.size).toBe(0)
})
