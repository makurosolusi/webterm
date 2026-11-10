// Bun-only (bun:sqlite). The memory tools through the real execTool gate (flag, validate, tier, handler).
import { expect, test } from 'bun:test'
import { CANARY, T0, addMessage, fixture, same, seedRow, subset } from '../../../memory/memoryV2.fixture'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { Tier, ToolCtx } from '../toolTypes'
import { createMemoryDefs } from './memory.defs'

function setup(conversationId = 'central:global', flag = 'on', maxTier: Tier = 'R1') {
  const db = fixture()
  const registry = createRegistry()
  for (const def of createMemoryDefs()) registry.register(def)
  const ctx: ToolCtx = { db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId, now: () => T0, env: { WEBTERM_CENTRAL_MEMORY: flag } }
  return { db, ctx }
}

test('all memory tools are registered with the right tiers and the memory flag', () => {
  const { ctx } = setup()
  same(ctx.registry.list().map((d) => [d.name, d.tier, d.flag, d.projectScoped]), [
    ['memory.search', 'R0', 'WEBTERM_CENTRAL_MEMORY', false], ['memory.get', 'R0', 'WEBTERM_CENTRAL_MEMORY', false],
    ['memory.remember', 'R1', 'WEBTERM_CENTRAL_MEMORY', false],
    ['memory.update', 'R1', 'WEBTERM_CENTRAL_MEMORY', false], ['memory.forget', 'R1', 'WEBTERM_CENTRAL_MEMORY', false], ['memory.remember_user', 'R1', 'WEBTERM_CENTRAL_MEMORY', false],
  ])
})

test('flag off: every tool answers flag_off and nothing is written', async () => {
  const { db, ctx } = setup('central:global', 'off')
  expect((await execTool(ctx, 'memory.remember', { key: 'a.b.c', body: 'some body' })).code).toBe('flag_off')
  same(db.query('SELECT count(*) AS c FROM memory').get(), { c: 0 })
})

test('remember then search/get round-trips; the claim is labelled unverified', async () => {
  const { ctx } = setup()
  const saved = await execTool(ctx, 'memory.remember', { key: 'deploy.staging.host', body: 'staging uses the vpn' })
  subset(saved, { ok: true, data: { deduped: false, status: 'claim', trust: 'agent' } })
  const found = await execTool(ctx, 'memory.search', { query: 'staging vpn' })
  const results = found.data?.results as Array<{ id: string; unverified: boolean }>
  same(results.map((r) => r.unverified), [true])
  const got = await execTool(ctx, 'memory.get', { id: results[0]!.id })
  expect(got.ok).toBe(true)
})

test('input allowlist: smuggled trust, scope, projectId, status or extra keys are refused', async () => {
  const { ctx, db } = setup()
  for (const extra of [{ trust: 'human' }, { scope: 'core' }, { projectId: 'p1' }, { status: 'fact' }, { foo: 1 }]) {
    const res = await execTool(ctx, 'memory.remember', { key: 'a.b.c', body: 'some body', ...extra })
    expect(res.ok).toBe(false)
    expect(['forbidden_key', 'invalid_shape']).toContain(res.code as string)
  }
  expect((await execTool(ctx, 'memory.search', { query: 'x', limit: 99 })).code).toBe('invalid_shape')
  expect((await execTool(ctx, 'memory.search', { query: 'x', scope: 'secret' })).code).toBe('invalid_shape')
  same(db.query('SELECT count(*) AS c FROM memory').get(), { c: 0 })
})

test('remember_user: verbatim human quote succeeds; forged quote returns a coded failure and writes nothing', async () => {
  const { ctx, db } = setup()
  addMessage(db, 'central:global', 'human', 'Please always answer briefly.')
  const forged = await execTool(ctx, 'memory.remember_user', { key: 'user.style.brevity', quote: 'The user wants long answers' })
  subset(forged, { ok: false, code: 'quote_not_verbatim' })
  same(db.query("SELECT count(*) AS c FROM memory WHERE scope='user'").get(), { c: 0 })
  const ok = await execTool(ctx, 'memory.remember_user', { key: 'user.style.brevity', quote: 'always answer briefly' })
  subset(ok, { ok: true, data: { status: 'fact', trust: 'attested' } })
  const again = await execTool(ctx, 'memory.search', { query: 'answer briefly' })
  expect((again.data?.results as unknown[]).length).toBe(1)
})

test('R1 writers are denied to an R0-only caller, readers are not', async () => {
  const { ctx } = setup('central:global', 'on', 'R0')
  expect((await execTool(ctx, 'memory.remember', { key: 'a.b.c', body: 'some body' })).code).toBe('tier_denied')
  expect((await execTool(ctx, 'memory.search', { query: 'anything' })).ok).toBe(true)
})

test('visibility follows the conversation: other-project rows are not_found by id, and canary is redacted in output', async () => {
  const { ctx, db } = setup('central:project:p1')
  const other = seedRow(db, { key: 'proj.beta.secret', body: 'beta only okapi', scope: 'project', projectId: 'p2' })
  seedRow(db, { key: 'global.leak.one', body: `okapi token ${CANARY}`, title: CANARY })
  subset(await execTool(ctx, 'memory.get', { id: other }), { ok: false, code: 'not_found' })
  subset(await execTool(ctx, 'memory.get', { id: 'does-not-exist' }), { ok: false, code: 'not_found' })
  const res = await execTool(ctx, 'memory.search', { query: 'okapi' })
  const out = JSON.stringify(res)
  expect(out).toContain('global.leak.one')
  expect(out).not.toContain('beta only')
  expect(out).not.toContain('CANARY')
})

test('audit rows carry ids and counts, never the remembered text', async () => {
  const { ctx, db } = setup()
  await execTool(ctx, 'memory.remember', { key: 'deploy.audit.check', body: 'distinctive-audit-body-text' })
  const rows = db.query("SELECT payload_json AS p FROM event WHERE kind = 'central.proposal'").all() as Array<{ p: string }>
  expect((rows.length) > 0).toBe(true)
  expect(rows.some((r) => r.p.includes('distinctive-audit-body-text'))).toBe(false)
})

const CLAIM = { scope: 'central', status: 'claim', trust: 'agent', verifiedAt: null } as const
const row = (db: ReturnType<typeof fixture>, id: string) => db.query('SELECT * FROM memory WHERE id = ?').get(id) as Record<string, unknown>
const events = (db: ReturnType<typeof fixture>, id: string) => db.query('SELECT actor, kind, payload_json AS p FROM memory_event WHERE memory_id = ?').all(id) as Array<{ actor: string; kind: string; p: string }>
const bodiesFor = async (ctx: ToolCtx, query: string) => ((await execTool(ctx, 'memory.search', { query })).data?.results as Array<{ body: string }>).map((r) => r.body)

test('update supersedes the claim, keeps its origin and history, and writes an event', async () => {
  const { ctx, db } = setup()
  const old = seedRow(db, { ...CLAIM, key: 'consolidate.add.new.abc', title: 'staging uses vpn', body: 'staging uses vpn', sourceKind: 'consolidator', sourceRef: 'node:a1', sourceEventId: 7 })
  const res = await execTool(ctx, 'memory.update', { id: old, text: 'staging uses wireguard' })
  subset(res, { ok: true, data: { deduped: false, status: 'claim', trust: 'agent' } })
  const id = res.data?.id as string
  subset(row(db, old), { status: 'superseded', superseded_by: id, valid_to: T0, body: 'staging uses vpn' })
  subset(row(db, id), { supersedes: old, key: 'consolidate.add.new.abc', title: 'staging uses wireguard', source_kind: 'consolidator', source_ref: 'node:a1', source_event_id: 7, scope: 'central' })
  same(events(db, id).map((e) => [e.actor, e.kind]), [['central:central:global', 'memory.update']])
  same(await bodiesFor(ctx, 'staging'), ['staging uses wireguard'])
  subset(await execTool(ctx, 'memory.update', { id, text: 'staging uses wireguard' }), { ok: true, data: { id, deduped: true } })
  subset(await execTool(ctx, 'memory.update', { id: old, text: 'anything else' }), { ok: false, code: 'not_found' })
})

test('update and forget refuse human-owned rows with a hint and change nothing', async () => {
  const { ctx, db } = setup()
  const owned = [
    seedRow(db, { key: 'global.a.human', body: 'human fact', trust: 'human' }),
    seedRow(db, { key: 'user.a.quote', body: 'quoted fact', scope: 'user', trust: 'attested' }),
    seedRow(db, { ...CLAIM, key: 'central.a.claim', body: 'human held claim', trust: 'human' }),
    seedRow(db, { key: 'central.a.fact', body: 'agent promoted fact', scope: 'central', trust: 'agent' }),
  ]
  for (const id of owned) {
    for (const res of [await execTool(ctx, 'memory.update', { id, text: 'rewritten' }), await execTool(ctx, 'memory.forget', { id, reason: 'wrong' })]) {
      subset(res, { ok: false, code: 'human_owned' })
      expect(String(res.data?.hint)).toContain('Ask the user')
    }
    expect(row(db, id)['superseded_at']).toBe(null)
    same(events(db, id), [])
  }
})

test('update and forget only reach rows visible to the conversation', async () => {
  const { ctx, db } = setup('central:project:p1')
  const hidden = [
    seedRow(db, { ...CLAIM, key: 'central.b.other', body: 'other project claim', projectId: 'p2' }),
    seedRow(db, { ...CLAIM, key: 'central.b.web', body: 'web text', trust: 'external' }),
  ]
  for (const id of hidden) {
    subset(await execTool(ctx, 'memory.update', { id, text: 'x y z' }), { ok: false, code: 'not_found' })
    subset(await execTool(ctx, 'memory.forget', { id, reason: 'x' }), { ok: false, code: 'not_found' })
  }
  const shared = seedRow(db, { ...CLAIM, key: 'central.b.shared', body: 'global conversation claim' })
  const res = await execTool(ctx, 'memory.update', { id: shared, text: 'corrected shared claim' })
  expect(res.ok).toBe(true)
  expect(row(db, res.data?.id as string)['project_id']).toBe(null)
  const own = seedRow(db, { ...CLAIM, key: 'central.b.own', body: 'own project claim', projectId: 'p1' })
  subset(await execTool({ ...ctx, conversationId: 'central:global' }, 'memory.forget', { id: own, reason: 'x' }), { ok: false, code: 'not_found' })
})

test('forget closes the window without scrubbing or tombstoning; the same text can be stored again', async () => {
  const { ctx, db } = setup()
  const saved = await execTool(ctx, 'memory.remember', { key: 'deploy.prod.region', body: 'prod runs in jakarta' })
  const id = saved.data?.id as string
  subset(await execTool(ctx, 'memory.forget', { id, reason: 'moved away' }), { ok: true, data: { id } })
  subset(row(db, id), { status: 'superseded', valid_to: T0, superseded_by: null, body: 'prod runs in jakarta' })
  expect(events(db, id).map((e) => e.kind)).toContain('memory.invalidate')
  expect(events(db, id).some((e) => e.p.includes('moved away'))).toBe(true)
  same(db.query('SELECT count(*) AS c FROM memory_tombstone').get(), { c: 0 })
  same(await bodiesFor(ctx, 'jakarta'), [])
  subset(await execTool(ctx, 'memory.get', { id }), { ok: false, code: 'not_found' })
  const again = await execTool(ctx, 'memory.remember', { key: 'deploy.prod.region', body: 'prod runs in jakarta' })
  subset(again, { ok: true, data: { deduped: false, status: 'claim' } })
  same(await bodiesFor(ctx, 'jakarta'), ['prod runs in jakarta'])
})

test('update and forget: strict keys, audit carries the id only, secrets refused, PII masked', async () => {
  const { ctx, db } = setup()
  const id = seedRow(db, { ...CLAIM, key: 'central.c.one', body: 'original claim' })
  for (const extra of [{ trust: 'human' }, { status: 'fact' }, { projectId: 'p1' }]) {
    expect((await execTool(ctx, 'memory.update', { id, text: 'x', ...extra })).ok).toBe(false)
    expect((await execTool(ctx, 'memory.forget', { id, reason: 'x', ...extra })).ok).toBe(false)
  }
  subset(await execTool(ctx, 'memory.update', { id, text: `token ${CANARY}` }), { ok: false, code: 'secret_detected' })
  const res = await execTool(ctx, 'memory.update', { id, text: 'ping admin@example.com distinctive-update-text' })
  expect(row(db, res.data?.id as string)['body']).toBe('ping [email] distinctive-update-text')
  const audit = db.query("SELECT payload_json AS p FROM event WHERE kind = 'central.proposal'").all() as Array<{ p: string }>
  expect(audit.some((r) => r.p.includes('distinctive-update-text'))).toBe(false)
})
