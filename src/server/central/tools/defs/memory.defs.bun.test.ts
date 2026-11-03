// Bun-only (bun:sqlite). The four memory tools through the real execTool gate (flag, validate, tier, handler).
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

test('all four tools are registered with the right tiers and the memory flag', () => {
  const { ctx } = setup()
  same(ctx.registry.list().map((d) => [d.name, d.tier, d.flag, d.projectScoped]), [
    ['memory.search', 'R0', 'WEBTERM_CENTRAL_MEMORY', false], ['memory.get', 'R0', 'WEBTERM_CENTRAL_MEMORY', false],
    ['memory.remember', 'R1', 'WEBTERM_CENTRAL_MEMORY', false], ['memory.remember_user', 'R1', 'WEBTERM_CENTRAL_MEMORY', false],
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
