// Bun-only: policy engine over the real ledger schema (v11) — rules, tier data, cable grants,
// attenuation, K3/K4 refusals, decision events, persistence across a reopen, and the guard wiring.
import { afterAll, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { Workspace, WsNode } from '../../shared/workspace'
import { createControlGuard } from '../central/guard/controlGuard'
import { freshDb, T0 } from '../central/guard/controlGuard.testutil'
import { openLedgerDb } from '../ledger/migration'
import { createPolicy, DECISION_EVENT, GRANT_EVENT, TELEGRAM_GRANT_MAX_MS } from './policy.decide'
import { handlePolicyApi, POLICY_GRANTS_PATH } from './policy.api'
import { activePolicy, resetActivePolicyForTest } from './policy.runtime'
import { harness } from '../control/fakeControlDeps'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { resetActiveLedgerRuntimeForTest, setActiveLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { resetEventsRuntimeForTest } from '../events/eventsRuntime'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'policy-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const node = (id: string, kind: WsNode['kind']): WsNode => ({ id, kind, x: 0, y: 0 })
const board = (bridges: Workspace['bridges']): Workspace[] =>
  [{ id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('a1', 'agent'), node('a2', 'agent'), node('b1', 'browser')], bridges, updatedAt: 0 }]
const close = (db: Database): void => (db as unknown as { close(): void }).close()
const chained = (db: Database, kind: string): Record<string, unknown>[] =>
  (db.query('SELECT payload_json, actor FROM event WHERE hash IS NOT NULL AND kind = ? ORDER BY seq').all(kind) as { payload_json: string; actor: string }[])
    .map((r) => ({ ...JSON.parse(r.payload_json), actor: r.actor }))

function setup(bridges: Workspace['bridges'] = []) {
  const db = freshDb()
  let t = T0
  let edges = bridges
  const policy = createPolicy({ db, now: () => t, workspaces: () => board(edges) })
  return { db, policy, setEdges: (b: Workspace['bridges']) => { edges = b }, advance: (ms: number) => { t += ms } }
}

test('defaults reproduce pre-policy behaviour: human-ui and central allowed, nodes denied, telegram asks', () => {
  const { policy } = setup()
  expect(policy.decide('human-ui', 'node.close').effect).toBe('allow')
  expect(policy.decide('central', 'node.close', { resource: 'node:x' }).effect).toBe('allow')
  expect(policy.decide('node:a1', 'browser.act', { resource: 'node:b1' }).effect).toBe('deny')
  expect(policy.decide('telegram:42', 'node.prompt').effect).toBe('ask')
  expect(policy.decide('root', 'node.read')).toEqual({ effect: 'deny', reason: 'unknown principal' })
})

test('persisted human rules are last-match-wins over builtin rows', () => {
  const { policy } = setup()
  expect(policy.createGrant('human-ui', { subject: 'central', capability: 'node.*', effect: 'deny' }).ok).toBe(true)
  expect(policy.createGrant('human-ui', { subject: 'central', capability: 'node.read', effect: 'allow' }).ok).toBe(true)
  expect(policy.decide('central', 'node.close').effect).toBe('deny')
  expect(policy.decide('central', 'node.read').effect).toBe('allow')
  expect(policy.decide('central', 'approval.read').effect).toBe('allow')
})

test('cable grant appears and disappears with the edge, scoped to that browser', () => {
  const { policy, setEdges } = setup()
  const act = () => policy.decide('node:a1', 'browser.act', { resource: 'node:b1' })
  expect(act().effect).toBe('deny')
  setEdges([{ id: 'e1', source: 'a1', target: 'b1', kind: 'context' }])
  expect(act()).toMatchObject({ effect: 'allow', origin: 'cable' })
  expect(policy.decide('node:a1', 'node.close', { resource: 'node:b1' }).effect).toBe('deny')
  expect(policy.decide('node:a2', 'browser.act', { resource: 'node:b1' }).effect).toBe('deny')
  setEdges([])
  expect(act().effect).toBe('deny')
})

test('a human deny rule beats a cable grant (rules after cables)', () => {
  const { policy } = setup([{ id: 'e1', source: 'a1', target: 'b1', kind: 'context' }])
  policy.createGrant('human-ui', { subject: 'node:a1', capability: 'browser.act', effect: 'deny' })
  expect(policy.decide('node:a1', 'browser.act', { resource: 'node:b1' }).effect).toBe('deny')
  expect(policy.decide('node:a1', 'browser.read', { resource: 'node:b1' }).effect).toBe('allow')
})

test('attenuation: a spawned child never gets more than its parent (K3)', () => {
  const { policy } = setup([{ id: 'e1', source: 'a2', target: 'b1', kind: 'context' }])
  policy.registerSpawn('node:a1', 'node:a2')
  // The child is wired to the browser, its parent is not: the parent's deny caps the child.
  const d = policy.decide('node:a2', 'browser.act', { resource: 'node:b1' })
  expect(d.effect).toBe('deny')
  expect(d.reason).toContain('attenuated by parent node:a1')
  // Once the parent holds the grant too, the child keeps its own.
  policy.createGrant('human-ui', { subject: 'node:a1', capability: 'browser.*', effect: 'allow' })
  expect(policy.decide('node:a2', 'browser.act', { resource: 'node:b1' }).effect).toBe('allow')
  // A grant to the parent does not flow down to a child that has none.
  expect(policy.decide('node:a2', 'memory.search').effect).toBe('deny')
})

test('agents can never mint grants; telegram cannot write a permanent rule (K3, K4)', () => {
  const { policy } = setup()
  for (const agent of ['central', 'node:a1', 'routine:nightly']) {
    expect(policy.createGrant(agent, { subject: agent, capability: '*', effect: 'allow' })).toEqual({ ok: false, status: 403, code: 'agent_cannot_grant' })
  }
  expect(policy.createGrant('telegram:42', { subject: 'node:a1', capability: 'node.prompt', effect: 'allow' })).toEqual({ ok: false, status: 403, code: 'permanent_rule_ui_only' })
  expect(policy.createGrant('telegram:42', { subject: 'node:a1', capability: 'node.prompt', effect: 'allow', expiresAt: T0 + TELEGRAM_GRANT_MAX_MS + 1 })).toMatchObject({ code: 'permanent_rule_ui_only' })
  const once = policy.createGrant('telegram:42', { subject: 'node:a1', capability: 'node.prompt', effect: 'allow', expiresAt: T0 + 60_000 })
  expect(once).toMatchObject({ ok: true, grant: { origin: 'telegram' } })
  expect(policy.createGrant('human-ui', { subject: 'node:a1', capability: 'node.prompt', effect: 'allow' })).toMatchObject({ ok: true, grant: { expiresAt: null, origin: 'human-ui' } })
  expect(policy.revokeGrant('node:a1', 'builtin-node')).toMatchObject({ status: 403 })
})

test('a telegram "allow once" expires, and never auto-allows a destructive capability', () => {
  const { policy, advance } = setup()
  policy.createGrant('telegram:42', { subject: 'node:a1', capability: 'node.prompt', effect: 'allow', expiresAt: T0 + 60_000 })
  policy.createGrant('telegram:42', { subject: 'node:a1', capability: 'fs.delete', effect: 'allow', expiresAt: T0 + 60_000 })
  expect(policy.decide('node:a1', 'node.prompt').effect).toBe('allow')
  expect(policy.decide('node:a1', 'fs.delete', { destructive: true }).effect).toBe('ask')
  advance(60_000)
  expect(policy.decide('node:a1', 'node.prompt').effect).toBe('deny')
})

test('every decision and grant change is appended to the chained event log', () => {
  const { db, policy } = setup()
  policy.decide('central', 'node.close', { resource: 'node:x' })
  policy.decide('node:a1', 'browser.act')
  const created = policy.createGrant('human-ui', { subject: 'central', capability: 'node.close', effect: 'deny' })
  if (!created.ok) throw new Error('grant not created')
  policy.revokeGrant('human-ui', created.grant.id)
  expect(chained(db, DECISION_EVENT)).toMatchObject([
    { capability: 'node.close', effect: 'allow', ruleId: 'builtin-central', actor: 'central' },
    { capability: 'browser.act', effect: 'deny', ruleId: 'builtin-node', actor: 'node:a1' },
  ])
  expect(chained(db, GRANT_EVENT)).toMatchObject([{ op: 'create', id: created.grant.id, actor: 'human-ui' }, { op: 'revoke', id: created.grant.id }])
})

test('grants, lineage, tier data and principal tokens survive a restart', () => {
  const path = join(root, 'ledger.db')
  const db1 = openLedgerDb(path)
  const p1 = createPolicy({ db: db1, now: () => T0 })
  p1.createGrant('human-ui', { subject: 'central', capability: 'node.close', effect: 'deny' })
  p1.registerSpawn('node:a1', 'node:a2')
  p1.store.setTierMinimum('R1', 'act_gated')
  const token = p1.store.issueToken('node:a2')
  const expiring = p1.store.issueToken('node:a3', 1000)
  close(db1)

  const db2 = openLedgerDb(path)
  const p2 = createPolicy({ db: db2, now: () => T0 + 5000 })
  expect(p2.decide('central', 'node.close').effect).toBe('deny')
  expect(p2.store.ancestors('node:a2')).toEqual(['node:a1'])
  expect(p2.store.tierMinimum('R1')).toBe('act_gated')
  expect(p2.store.verifyToken(token)).toBe('node:a2')
  expect(p2.store.verifyToken(expiring)).toBe(undefined)
  expect(p2.store.verifyToken('wpt_forged')).toBe(undefined)
  expect(p2.store.revokeTokensOf('node:a2')).toBe(1)
  expect(p2.store.verifyToken(token)).toBe(undefined)
  // The raw token is never stored.
  expect((db2.query('SELECT count(*) AS c FROM policy_token WHERE token_hash = ?').get(token) as { c: number }).c).toBe(0)
  close(db2)
})

test('controlGuard reads the tier minimum from data and obeys a human rule for central', () => {
  const db = freshDb()
  const guard = createControlGuard({ db, now: () => T0, env: {} })
  const req = { action: 'tool' as const, projectId: 'p1', tool: 'goal.propose', tier: 'R1' as const }
  expect(guard.check(req).verdict).toBe('allow')
  guard.policy.store.setTierMinimum('R1', 'act_gated')
  expect(guard.check(req)).toMatchObject({ verdict: 'deny', code: 'level_denied', reason: 'level propose is below act_gated' })
  guard.policy.store.setTierMinimum('R1', 'propose')
  guard.policy.createGrant('human-ui', { subject: 'central', capability: 'goal.*', scope: 'project:p1', effect: 'ask' })
  expect(guard.check(req).verdict).toBe('needs_approval')
  expect(guard.check({ ...req, projectId: 'p2' }).verdict).toBe('allow')
  guard.policy.createGrant('human-ui', { subject: 'central', capability: 'goal.propose', effect: 'deny' })
  expect(guard.check(req)).toMatchObject({ verdict: 'deny', code: 'policy_denied' })
})

test('HTTP: an agent credential cannot create grants (403); the same-origin UI can', () => {
  const { policy } = setup()
  const call = (method: string, headers: Record<string, string>, body?: unknown, path = POLICY_GRANTS_PATH) =>
    handlePolicyApi({ method, headers } as unknown as IncomingMessage, new URL(`http://127.0.0.1:8700${path}`), body, { policy, isNodeToken: (t) => t === 'node-tok' })
  const ui = { host: '127.0.0.1:8700', origin: 'http://127.0.0.1:8700', 'sec-fetch-site': 'same-origin' }
  const rule = { subject: 'node:a1', capability: 'browser.*', effect: 'allow' }
  expect(call('POST', { ...ui, 'x-webterm-capability': 'wcap_x' }, rule)).toEqual({ status: 403, body: { error: 'agent_cannot_grant' } })
  expect(call('POST', { ...ui, 'x-webterm-token': 'node-tok' }, rule)).toEqual({ status: 403, body: { error: 'agent_cannot_grant' } })
  expect(call('POST', { host: '127.0.0.1:8700' }, rule)).toEqual({ status: 403, body: { error: 'approval_browser_only' } })
  const ok = call('POST', ui, rule)
  expect(ok).toMatchObject({ status: 201, body: { grant: { subject: 'node:a1', origin: 'human-ui', expiresAt: null } } })
  expect(call('POST', ui, { subject: '', capability: '*', effect: 'allow' })).toEqual({ status: 400, body: { error: 'invalid_grant' } })
  const id = (ok?.body as { grant: { id: string } }).grant.id
  expect((call('GET', ui)?.body as { grants: { id: string }[] }).grants.some((g) => g.id === id)).toBe(true)
  expect(call('DELETE', ui, undefined, `${POLICY_GRANTS_PATH}/${id}`)).toEqual({ status: 200, body: { ok: true } })
  expect(call('DELETE', ui, undefined, `${POLICY_GRANTS_PATH}/${id}`)).toEqual({ status: 404, body: { error: 'not_found' } })
  expect(call('GET', ui, undefined, '/api/other')).toBeNull()
})

test('control API: capability tokens act as central; a human deny rule now refuses with 403, default unchanged', async () => {
  const db = freshDb()
  // The process events runtime writes its anchor under the data dir: keep it in the temp root.
  const prevDir = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = root
  setActiveLedgerRuntime({ mode: 'on', path: ':memory:', db } as unknown as LedgerRuntime)
  try {
    const h = harness()
    const tok = h.token('node.close', 'node:n1')
    const close = () => h.call('POST', 'close', { requestId: `req-${Math.random()}`, nodeId: 'n1' }, { 'x-webterm-capability': tok })
    expect((await close())?.status).toBe(200)
    activePolicy()!.createGrant('human-ui', { subject: 'central', capability: 'node.close', scope: 'node:n1', effect: 'deny' })
    expect(await close()).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    expect(chained(db, DECISION_EVENT).map((e) => e.effect)).toEqual(['allow', 'deny'])
  } finally {
    resetActivePolicyForTest()
    resetEventsRuntimeForTest()
    resetActiveLedgerRuntimeForTest()
    if (prevDir === undefined) delete process.env.WEBTERM_DATA_DIR
    else process.env.WEBTERM_DATA_DIR = prevDir
  }
})
