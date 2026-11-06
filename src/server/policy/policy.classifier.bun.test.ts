// Bun-only (real ledger schema): F4-d switch default + persistence, the classifier hooked into Central's act_gated
// cards and into held Claude permission prompts, never-auto beating an `allow`, failure leaving the card to the
// human, the simulator's diff counts over a fixture event log, and the UI-only routes. The model is always a fake.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { IncomingMessage } from 'node:http'
import { createControlGuard, toToolGuard } from '../central/guard/controlGuard'
import { freshDb, HUMAN, T0 } from '../central/guard/controlGuard.testutil'
import { setLevel } from '../central/guard/levelStore'
import { createEventLog } from '../events/eventLog'
import type { AppendEventInput } from '../events/eventModel'
import { approvalDigest, getApproval, requestApproval } from '../ledger/ledgerApproval'
import { answerPermission, PERMISSION_DECISION_EVENT, PERMISSION_REQUEST_EVENT } from '../permission/permission.wait'
import { CLASSIFIER_ACTOR, classifierSwitch, setClassifierSwitch, type Classifier, type ClassifierInput } from './policy.classifier'
import { classifyCard } from './policy.classifier.card'
import { createPolicy, DECISION_EVENT } from './policy.decide'
import { handlePolicySimApi, POLICY_CLASSIFIER_PATH, POLICY_SIMULATE_PATH } from './policy.sim.api'
import { simulatePolicy } from './policy.simulate'

const allow = (seen: ClassifierInput[] = []): Classifier => async (i) => { seen.push(i); return { decision: 'allow', reason: 'routine docs page' } }
const fail: Classifier = async () => { throw new Error('model down') }
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function setup() {
  const db = freshDb()
  let t = T0
  const now = () => t
  const log = createEventLog(db, { now })
  const events: AppendEventInput[] = []
  const record = (e: AppendEventInput): void => { events.push(e); log.append(e) }
  return { db, now, log, events, record, advance: (ms: number) => { t += ms } }
}
const switchOn = (db: Database, record: (e: AppendEventInput) => void, central = true, permissions = true) => setClassifierSwitch(db, record, { central, permissions })

test('switch is OFF by default, persists in the event log, and survives a cache-cold read', () => {
  const s = setup()
  expect(classifierSwitch(s.db)).toEqual({ central: false, permissions: false })
  switchOn(s.db, s.record, true, false)
  const row = s.db.query("SELECT payload_json FROM event WHERE kind = 'policy.classifier_switch'").get() as { payload_json: string }
  expect(JSON.parse(row.payload_json)).toEqual({ central: true, permissions: false })
  expect(classifierSwitch(s.db)).toEqual({ central: true, permissions: false })
})

function centralCase(classifier: Classifier, tool = 'browser_act') {
  const s = setup()
  setLevel(s.db, { scope: 'global', level: 'act_gated', actor: HUMAN, now: s.now })
  const guard = createControlGuard({ db: s.db, now: s.now, env: { WEBTERM_CENTRAL_AGENTS: 'propose' }, classifier, record: s.record })
  const input = { projectId: 'p1', action: 'navigate', url: 'https://docs.example.com' }
  const req = { tool, tier: 'R2' as const, projectId: 'p1', input }
  // What mcp/mcp.central.ts does right after the guard says approval_required.
  const card = () => requestApproval({ db: s.db, now: s.now }, { id: 'ct-abc', projectId: 'p1', kind: tool, request: { tool, conversationId: 'c1', input, inputDigest: approvalDigest(input) } })
  return { ...s, guard, req, card }
}

test('central act_gated: switch off -> card stays pending and the classifier is never called', async () => {
  const seen: ClassifierInput[] = []
  const c = centralCase(allow(seen))
  expect(toToolGuard(c.guard).check(c.req)).toEqual({ ok: false, code: 'approval_required' })
  c.card()
  await pause(30)
  expect(getApproval({ db: c.db, now: c.now }, 'ct-abc')!.status).toBe('pending')
  expect(seen).toHaveLength(0)
})

test('central act_gated: switch on + allow -> the card is approved by the classifier, logged, inbox shows the reason', async () => {
  const seen: ClassifierInput[] = []
  const c = centralCase(allow(seen))
  switchOn(c.db, c.record)
  expect(toToolGuard(c.guard).check(c.req)).toEqual({ ok: false, code: 'approval_required' })
  c.card()
  await pause(30)
  const a = getApproval({ db: c.db, now: c.now }, 'ct-abc')!
  expect(a).toMatchObject({ status: 'approved', approvedBy: CLASSIFIER_ACTOR })
  expect(seen[0]).toMatchObject({ capability: 'browser_act', tier: 'R2', workspace: { projectId: 'p1', cwd: '/tmp/p1', workspaceId: 'w1' } })
  expect(c.events.find((e) => e.kind === 'policy.classifier')!.payload).toMatchObject({ effect: 'allow', by: 'classifier', approvalId: 'ct-abc' })
  const item = c.db.query('SELECT status, resolution FROM inbox_item WHERE approval_id = ?').get('ct-abc')
  expect(item).toEqual({ status: 'done', resolution: 'auto-approved by classifier: routine docs page' })
})

test('central: a human ask rule and a destructive tool never reach the classifier', async () => {
  const seen: ClassifierInput[] = []
  const c = centralCase(allow(seen))
  switchOn(c.db, c.record)
  expect(c.guard.policy.createGrant('human-ui', { subject: 'central', capability: 'browser_act', effect: 'ask' }).ok).toBe(true)
  const d = c.guard.check({ action: 'tool', tool: c.req.tool, tier: 'R2', projectId: 'p1' })
  c.card()
  expect(await c.guard.classifyLater!(c.req, d)).toBeNull()
  const out = await c.guard.classifyLater!({ ...c.req, tool: 'browser_act' }, { verdict: 'needs_approval', level: 'act_gated', tier: 'R3' })
  expect(out).toBeNull()
  expect(seen).toHaveLength(0)
  expect(getApproval({ db: c.db, now: c.now }, 'ct-abc')!.status).toBe('pending')
})

test('classifier failure -> ask: the card keeps waiting for the human', async () => {
  const c = centralCase(fail)
  switchOn(c.db, c.record)
  c.card()
  const o = await classifyCard({ db: c.db, now: c.now, classifier: fail, record: c.record }, { principal: 'central', capability: 'browser_act', tier: 'R2', args: c.req.input, approvalId: 'ct-abc', cwd: '/tmp/p1' })
  expect(o).toMatchObject({ effect: 'ask', by: 'failure' })
  expect(getApproval({ db: c.db, now: c.now }, 'ct-abc')!.status).toBe('pending')
})

function permissionCase(classifier: Classifier) {
  const s = setup()
  const policy = createPolicy({ db: s.db, now: s.now })
  const record = (e: AppendEventInput): void => { s.events.push(e) }
  return {
    ...s, policy,
    run: (command: string, rule = false) => {
      if (rule) expect(policy.createGrant('human-ui', { subject: 'node:*', capability: 'claude.tool:Bash', scope: `${command}*`, effect: 'ask' }).ok).toBe(true)
      return answerPermission({
        db: s.db, policy, projectId: 'p1', waitMs: 5_000, now: s.now, pollMs: 500, record,
        sleep: async (ms) => { await pause(5); s.advance(ms) },
        classify: (a) => classifyCard({ db: s.db, now: s.now, classifier, record }, a),
      }, { nodeId: 'a1', nodeTitle: 'brisk-otter', workspaceId: 'w1', body: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command }, cwd: '/tmp/p1' } as never })
    },
  }
}

test('permission prompt: classifier allow answers the hook with allow, by classifier', async () => {
  const p = permissionCase(allow())
  const out = await p.run('npm test')
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  expect(p.events.filter((e) => e.kind === PERMISSION_DECISION_EVENT).at(-1)!.payload).toMatchObject({ behavior: 'allow', by: CLASSIFIER_ACTOR })
})

test('permission prompt: never-auto (git push) and an explicit ask rule time out to the terminal prompt', async () => {
  const seen: ClassifierInput[] = []
  const p = permissionCase(allow(seen))
  expect(await p.run('git push origin main')).toBeNull()
  expect(await p.run('npm run deploy', true)).toBeNull()
  expect(seen).toHaveLength(0)
  expect(p.events.filter((e) => e.kind === 'policy.classifier').map((e) => (e.payload as { by: string }).by)).toEqual(['never_auto', 'never_auto'])
})

test('simulator: diff counts over a fixture event log, nothing executed', () => {
  const s = setup()
  const old = T0 - 8 * 24 * 3_600_000
  const ev = (kind: string, actor: string, subject: string | null, payload: Record<string, unknown>, ts = T0 - 1000) =>
    s.log.append({ kind, source: 'test', actor, subject, trust: 'trusted', payload, ts })
  ev(DECISION_EVENT, 'node:a1', 'node:b1', { capability: 'browser.read', effect: 'deny' })
  ev(DECISION_EVENT, 'node:a1', 'node:b1', { capability: 'browser.read', effect: 'deny' })
  ev(DECISION_EVENT, 'central', 'project:p1', { capability: 'memory.search', effect: 'allow' })
  ev(DECISION_EVENT, 'node:a1', null, { capability: 'browser.read', effect: 'deny' }, old) // outside the 7-day window
  ev(PERMISSION_REQUEST_EVENT, 'node:a1', 'node:a1', { tool: 'Bash', label: 'Bash(npm test)', approvalId: 'perm_1' })
  ev(PERMISSION_REQUEST_EVENT, 'node:a1', 'node:a1', { tool: 'Bash', label: 'Bash(git push origin main)', approvalId: 'perm_2' })
  ev(PERMISSION_DECISION_EVENT, 'human-ui', 'node:a1', { tool: 'Bash', label: 'Bash(npm test)', behavior: 'allow', by: 'human:x' }) // the human's answer: not a second prompt
  const policy = createPolicy({ db: s.db, now: s.now })
  const grants = policy.store.grants()
  const before = (s.db.query('SELECT count(*) AS c FROM event').get() as { c: number }).c

  const r = simulatePolicy(s.db, grants, { add: [{ subject: 'node:*', capability: 'browser.read', scope: 'node:b1', effect: 'allow' }, { subject: 'node:*', capability: 'claude.tool:Bash', scope: 'npm test*', effect: 'allow' }] }, { now: s.now(), classifierOn: false })
  expect(r.total).toBe(5)
  expect(r.before).toEqual({ allow: 1, ask: 2, deny: 2, classifier: 0 })
  expect(r.after).toEqual({ allow: 4, ask: 1, deny: 0, classifier: 0 })
  expect(r.changed).toBe(3)
  expect(r.examples.some((x) => x.capability === 'claude.tool:Bash' && x.before === 'ask' && x.after === 'allow')).toBe(true)

  const c = simulatePolicy(s.db, grants, { classifier: true }, { now: s.now(), classifierOn: false })
  expect(c.after).toEqual({ allow: 1, ask: 1, deny: 2, classifier: 1 })
  expect(c.neverAutoHeld).toBe(1) // git push stays with the human
  expect((s.db.query('SELECT count(*) AS c FROM event').get() as { c: number }).c).toBe(before)
  let thrown: unknown = null
  try { simulatePolicy(s.db, grants, { add: [{ subject: '', capability: 'x', effect: 'allow' }] }, { now: s.now(), classifierOn: false }) } catch (err) { thrown = err }
  expect(thrown instanceof RangeError).toBe(true)
})

const req = (method: string, headers: Record<string, string> = {}): IncomingMessage => ({ method, headers: { host: '127.0.0.1:8700', origin: 'http://127.0.0.1:8700', 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE, ...headers } }) as unknown as IncomingMessage

test('routes: agents get 403, the page can flip the switch and simulate', () => {
  const s = setup()
  const policy = createPolicy({ db: s.db, now: s.now })
  const deps = { db: s.db, policy, append: s.record, isNodeToken: (t: string) => t === 'node-tok', now: s.now }
  const url = (p: string) => new URL(`http://127.0.0.1:8700${p}`)
  expect(handlePolicySimApi(req('PUT', { 'x-webterm-token': 'node-tok' }), url(POLICY_CLASSIFIER_PATH), { central: true, permissions: true }, deps).status).toBe(403)
  expect(classifierSwitch(s.db)).toEqual({ central: false, permissions: false })
  expect(handlePolicySimApi(req('GET'), url(POLICY_CLASSIFIER_PATH), undefined, deps)).toEqual({ status: 200, body: { central: false, permissions: false } })
  expect(handlePolicySimApi(req('PUT'), url(POLICY_CLASSIFIER_PATH), { central: true }, deps).status).toBe(400)
  expect(handlePolicySimApi(req('PUT'), url(POLICY_CLASSIFIER_PATH), { central: true, permissions: false }, deps)).toEqual({ status: 200, body: { central: true, permissions: false } })
  const sim = handlePolicySimApi(req('POST'), url(POLICY_SIMULATE_PATH), { add: [] }, deps)
  expect(sim.status).toBe(200)
  expect(handlePolicySimApi(req('POST'), url(POLICY_SIMULATE_PATH), { add: [{ subject: 1 }] }, deps).status).toBe(400)
})
