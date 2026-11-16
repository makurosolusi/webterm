// Bun-only (ledger): Fable needs a person's grant. Every path that resolves to Fable runs on Opus without one,
// the grant is scoped and revocable, and only a human actor can decide the `model.fable` card.
import { afterEach, expect, test } from 'bun:test'
import { freshDb } from '../central/guard/controlGuard.testutil'
import { APPROVAL_ROUTES, handleApproval, type ApprovalDeps } from '../control/approvalApi'
import { CapabilityStore, allows } from '../control/capabilities'
import { actOnItem } from '../inbox/inboxActions'
import { syncApprovalGates } from '../inbox/inboxItemStore'
import { consumeApproval, decideApproval, getApproval, listApprovals, requestApproval } from '../ledger/ledgerApproval'
import { getRow } from '../ledger/ledgerCore'
import { FABLE_KIND, isFableGranted, listFableGrants, requestFableGrant, revokeFableGrant, stampFableScope } from './fableGrant'
import { FABLE_NEEDS_APPROVAL } from './modelLadder'
import { registerModelSettings } from './modelOverride'
import { pickModel } from './modelPick'

afterEach(() => registerModelSettings(() => ({})))
// The bun:test typings here have no toThrow: the thrown message, or '' when nothing threw.
const thrown = (fn: () => unknown): string => { try { fn(); return '' } catch (err) { return err instanceof Error ? err.message : String(err) } }
const NOW = 1_700_000_000_000
type Db = ReturnType<typeof freshDb>
const ctxOf = (db: Db) => ({ db, now: () => NOW })
const conv = { kind: 'conversation', id: 'c1', projectId: 'w1' } as const
const challenge = (db: Db, id: string) => {
  const r = getRow(db, 'SELECT d.action_digest AS digest, d.nonce FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?', id)!
  return { digest: String(r['digest']), nonce: String(r['nonce']) }
}
const approve = (db: Db, id: string, actor: string) => decideApproval(ctxOf(db), id, { actor, approve: true, ...challenge(db, id), now: NOW })
const grant = (db: Db, id: string, scope: 'target' | 'project') => {
  approve(db, id, 'human:loopback')
  stampFableScope(ctxOf(db), id, 'human:loopback', scope)
}

test('an unanswered request grants nothing; one pending card per target, however often it is asked', () => {
  const db = freshDb()
  const id = requestFableGrant(ctxOf(db), conv)!
  expect(getApproval(ctxOf(db), id)).toMatchObject({ kind: FABLE_KIND, status: 'pending' })
  expect(requestFableGrant(ctxOf(db), conv)).toBeNull()
  expect(isFableGranted(db, conv)).toBe(false)
})

test('approving for this conversation grants only that conversation', () => {
  const db = freshDb()
  grant(db, requestFableGrant(ctxOf(db), conv)!, 'target')
  expect(isFableGranted(db, conv)).toBe(true)
  expect(isFableGranted(db, { kind: 'conversation', id: 'c2', projectId: 'w1' })).toBe(false)
  expect(isFableGranted(db, { kind: 'project', id: 'w1', projectId: 'w1' })).toBe(false)
})

test('a project grant covers every conversation, node and the project itself, and no other project', () => {
  const db = freshDb()
  const id = requestFableGrant(ctxOf(db), conv)!
  grant(db, id, 'project')
  expect(isFableGranted(db, { kind: 'conversation', id: 'c9', projectId: 'w1' })).toBe(true)
  expect(isFableGranted(db, { kind: 'node', id: 'n1', projectId: 'w1' })).toBe(true)
  expect(isFableGranted(db, { kind: 'project', id: 'w1', projectId: 'w1' })).toBe(true)
  expect(isFableGranted(db, { kind: 'conversation', id: 'c9', projectId: 'w2' })).toBe(false)
  expect(listFableGrants(db)).toMatchObject([{ id, scope: 'project', by: 'human:loopback' }])
})

test('a card approved on a surface that cannot pick a scope (Telegram) grants the narrowest scope', () => {
  const db = freshDb()
  approve(db, requestFableGrant(ctxOf(db), conv)!, 'telegram:42')
  expect(isFableGranted(db, conv)).toBe(true)
  expect(isFableGranted(db, { kind: 'conversation', id: 'c2', projectId: 'w1' })).toBe(false)
})

test('a denied card grants nothing and is not re-asked for a day', () => {
  const db = freshDb()
  const id = requestFableGrant(ctxOf(db), conv)!
  decideApproval(ctxOf(db), id, { actor: 'human:loopback', approve: false, ...challenge(db, id), now: NOW })
  expect(isFableGranted(db, conv)).toBe(false)
  expect(requestFableGrant(ctxOf(db), conv)).toBeNull()
  expect(requestFableGrant({ db, now: () => NOW + 25 * 3_600_000 }, conv)).not.toBeNull()
})

test('revoking takes the grant back, person-only', () => {
  const db = freshDb()
  const id = requestFableGrant(ctxOf(db), conv)!
  grant(db, id, 'target')
  expect(thrown(() => revokeFableGrant(ctxOf(db), id, 'central'))).toContain('only a person')
  expect(isFableGranted(db, conv)).toBe(true)
  expect(revokeFableGrant(ctxOf(db), id, 'human:loopback')).toBe(true)
  expect(isFableGranted(db, conv)).toBe(false)
  expect(revokeFableGrant(ctxOf(db), id, 'human:loopback')).toBe(false)
})

test('a non-human principal cannot decide the card: Central, a worker, the classifier, spoofed prefixes', () => {
  const db = freshDb()
  const id = requestFableGrant(ctxOf(db), conv)!
  for (const actor of ['central', 'agent:worker-1', 'classifier', 'humanoid', 'central:human:x']) {
    expect(thrown(() => approve(db, id, actor))).toContain('only be decided by a person')
  }
  expect(getApproval(ctxOf(db), id)!.status).toBe('pending')
  expect(thrown(() => stampFableScope(ctxOf(db), id, 'central', 'project'))).toContain('only a person')
  expect(isFableGranted(db, conv)).toBe(false)
})

test('the agent control API refuses the kind, whatever actor the body claims', async () => {
  const db = freshDb()
  const ctx = ctxOf(db)
  const id = requestFableGrant(ctx, conv)!
  const store = new CapabilityStore()
  const deps: ApprovalDeps = {
    capabilities: { verify: (token, now = NOW) => store.verify(token, now), allows },
    approval: {
      requestApproval: (i) => requestApproval(ctx, i), getApproval: (x) => getApproval(ctx, x), decideApproval: (x, i) => decideApproval(ctx, x, i),
      consumeApproval: (x, i) => consumeApproval(ctx, x, i), listApprovals: (o) => listApprovals(ctx, o),
    },
    now: () => NOW,
  }
  const projectId = getApproval(ctx, id)!.projectId!
  const token = store.mint({ verb: 'approval.decide', resource: `project:${projectId}` }, NOW)
  const res = await handleApproval({
    method: 'POST', path: APPROVAL_ROUTES.decide, headers: { 'x-webterm-capability': token },
    body: { requestId: 'req-00000001', id, approve: true, actor: 'human:root', ...challenge(db, id) },
  }, deps)
  expect(res?.status).toBe(403)
  expect(res?.body).toMatchObject({ error: 'human_only' })
  expect(getApproval(ctx, id)!.status).toBe('pending')
})

test('inbox: scope comes from the person, defaults to the narrowest, a bad scope is a 400, an agent actor is refused', async () => {
  const db = freshDb()
  const ctx = ctxOf(db)
  const act = (actor: string) => ({ ctx, actor, record: () => {}, outbox: async () => { throw new Error('unused') } })
  const cases: { scope?: string; want: string }[] = [{ scope: 'project', want: 'project' }, { want: 'target' }]
  for (const [i, tc] of cases.entries()) {
    const id = requestFableGrant(ctx, { kind: 'node', id: `n${i}`, projectId: 'w1' })!
    syncApprovalGates(ctx)
    const r = await actOnItem(act('human:loopback'), id, { type: 'approve', ...(tc.scope ? { scope: tc.scope } : {}) })
    expect(r.status).toBe(200)
    expect(listFableGrants(db).find((g) => g.id === id)!.scope).toBe(tc.want)
  }
  const id = requestFableGrant(ctx, { kind: 'node', id: 'n9', projectId: 'w1' })!
  syncApprovalGates(ctx)
  expect((await actOnItem(act('human:loopback'), id, { type: 'approve', scope: 'everything' })).status).toBe(400)
  expect((await actOnItem(act('central'), id, { type: 'approve', scope: 'target' })).status).toBe(409)
  expect(getApproval(ctx, id)!.status).toBe('pending')
})

test('pickModel: a saved projectModels=fable runs on Opus with one grant card, then on Fable once a person grants the project', () => {
  const db = freshDb()
  registerModelSettings(() => ({ projectModels: { w1: { model: 'fable' } } }))
  const input = { kind: 'agent-spawn' as const, workspaceId: 'w1', projectId: 'w1', runRef: 'a1' }
  expect(pickModel(db, input, () => NOW)).toMatchObject({ model: 'opus', reason: FABLE_NEEDS_APPROVAL, fableBlocked: true })
  pickModel(db, input, () => NOW)
  const cards = db.query(`SELECT id FROM approval WHERE kind = ? AND status = 'pending'`).all(FABLE_KIND) as { id: string }[]
  expect(cards.length).toBe(1)
  grant(db, cards[0]!.id, 'project')
  expect(pickModel(db, input, () => NOW)).toMatchObject({ model: 'fable', fableGranted: true })
  expect(pickModel(null, input, () => NOW)).toMatchObject({ model: 'opus', fableBlocked: true })
})
