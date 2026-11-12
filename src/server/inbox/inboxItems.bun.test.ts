// Bun-only (bun:sqlite): the unified inbox (F3-a) over the real ledger schema. Kinds and their
// actions, coalescing, snooze, edit-then-approve, reply via the outbox, batch with the R3 guard,
// mirrored Claude permission gates, the daily digest, the UI-only HTTP seam, and the same decision
// event from Telegram and the canvas. Telegram cards, the push sweep and the attention policy live
// in inboxItems.push.bun.test.ts.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { expect, test } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { approvalHumanRoute } from '../approvalHumanApi'
import { rows, T0 } from '../central/guard/controlGuard.testutil'
import { handleApprove } from '../channels/channelApprovals'
import { ledgerChallengePort } from '../channels/channelButtons'
import { ledgerApprovalPort } from '../channels/channelsRuntime.types'
import type { AppendEventInput } from '../events/eventModel'
import { createLedger } from '../ledger/ledger'
import { requestApproval } from '../ledger/ledgerApproval'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { PERMISSION_KIND } from '../permission/permission.model'
import { actOnItem, actOnItems } from './inboxActions'
import { INBOX_DECISION_EVENT } from './inboxItemModel'
import { approvedArgsFor, createInboxItem, getInboxItem, listInboxItems } from './inboxItemStore'
import { R2, R3, gate, setup } from './inboxItems.testutil'

const permission = (s: ReturnType<typeof setup>, command: string) =>
  requestApproval(s.ctx, { projectId: 'p1', kind: PERMISSION_KIND, id: `perm_${command.length}${command[0]}`, ttlMs: 60_000,
    request: { nodeId: 'a1', node: 'brisk-otter', tool: 'Bash', label: `Bash(${command})`, pattern: command, input: { command } } })

test('each kind lists with its Agent Inbox actions; gates first', () => {
  const s = setup()
  createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: 'Build finished' })
  createInboxItem(s.ctx, { kind: 'review', source: 'diff', title: 'Review diff notes', nodeId: 'a1' })
  createInboxItem(s.ctx, { kind: 'question', source: 'agent', title: 'Which branch?', nodeId: 'a1' })
  gate(s)
  const items = listInboxItems(s.ctx)
  expect(items.map((i) => i.kind)).toEqual(['gate', 'question', 'review', 'notify'])
  expect(items.map((i) => i.actions.join(','))).toEqual([
    'approve,edit,deny,ignore,snooze', 'reply,ignore,snooze', 'approve,reply,ignore,snooze', 'ignore,snooze',
  ])
  expect(items[0].impact).toEqual(R2)
})

test('the same news coalesces into one row with a count', () => {
  const s = setup()
  createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: 'Tests red', dedupeKey: 'red:w1' })
  const again = createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: 'Tests red', dedupeKey: 'red:w1' })
  expect(again.count).toBe(2)
  expect(listInboxItems(s.ctx)).toHaveLength(1)
})

test('snooze hides the item and it resurfaces by itself when the time passes', async () => {
  const s = setup()
  const q = createInboxItem(s.ctx, { kind: 'question', source: 'agent', title: 'Which branch?', nodeId: 'a1' })
  expect((await actOnItem(s.deps, q.id, { type: 'snooze', until: T0 + 3_600_000 })).status).toBe(200)
  expect(listInboxItems(s.ctx)).toHaveLength(0)
  s.clock.t = T0 + 3_600_000
  expect(listInboxItems(s.ctx).map((i) => i.id)).toEqual([q.id])
  expect((await actOnItem(s.deps, q.id, { type: 'snooze', until: T0 - 1 })).status).toBe(400)
})

test('edit-then-approve approves the ledger approval and stores the edited args', async () => {
  const s = setup()
  const g = gate(s)
  const r = await actOnItem(s.deps, g.id, { type: 'edit', args: { table: 'users', dryRun: true } })
  expect(r).toEqual({ status: 200, body: { id: g.id, resolution: 'approved' } })
  expect(rows(s.db, 'SELECT status FROM approval WHERE id = ?', g.approvalId)[0].status).toBe('approved')
  expect(approvedArgsFor(s.db, g.approvalId!)).toEqual({ table: 'users', dryRun: true })
  expect(s.events.at(-1)).toMatchObject({ kind: INBOX_DECISION_EVENT, payload: { decision: 'approve', edited: true } })
  // Answered once: a second click is refused instead of deciding twice.
  expect((await actOnItem(s.deps, g.id, { type: 'approve' })).status).toBe(409)
})

test('reply goes to the agent through the outbox, exactly once', async () => {
  const s = setup()
  const q = createInboxItem(s.ctx, { kind: 'question', source: 'agent', title: 'Which branch?', nodeId: 'a1' })
  expect((await actOnItem(s.deps, q.id, { type: 'reply', text: 'use main' })).body).toEqual({ id: q.id, resolution: 'replied' })
  const mail = s.outbox.queued('a1')
  expect(mail).toHaveLength(1)
  expect(mail[0]).toMatchObject({ kind: 'visible', operationId: `inbox:${q.id}:reply`, createdBy: 'human-ui' })
  expect(mail[0].body).toContain('use main')
  expect((await actOnItem(s.deps, q.id, { type: 'reply', text: 'again' })).status).toBe(409)
  const lost = createInboxItem(s.ctx, { kind: 'question', source: 'agent', title: 'Hello?', nodeId: 'gone' })
  expect((await actOnItem(s.deps, lost.id, { type: 'reply', text: 'hi' })).body).toMatchObject({ error: 'bad_target' })
})

test('ignore closes; actions a kind does not allow are refused', async () => {
  const s = setup()
  const n = createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: 'Build finished' })
  expect((await actOnItem(s.deps, n.id, { type: 'approve' })).body).toMatchObject({ error: 'action_not_allowed' })
  expect((await actOnItem(s.deps, n.id, { type: 'ignore' })).status).toBe(200)
  expect(getInboxItem(s.db, n.id)?.status).toBe('ignored')
  const r = createInboxItem(s.ctx, { kind: 'review', source: 'diff', title: 'Review', nodeId: 'a1' })
  expect((await actOnItem(s.deps, r.id, { type: 'approve' })).body).toEqual({ id: r.id, resolution: 'accepted' })
})

test('batch approve decides similar gates but never an R3 gate that cannot be rewound', async () => {
  const s = setup()
  const a = gate(s)
  const b = gate(s)
  const risky = gate(s, R3)
  const results = await actOnItems(s.deps, [a.id, b.id, risky.id], { type: 'approve' })
  expect(results.map((r) => r.status)).toEqual([200, 200, 409])
  expect(results[2].body).toMatchObject({ error: 'needs_individual_review' })
  expect(rows(s.db, "SELECT COUNT(*) AS n FROM approval WHERE status = 'approved'")[0].n).toBe(2)
  expect(listInboxItems(s.ctx).map((i) => i.id)).toEqual([risky.id])
})

test('a held Claude permission prompt is mirrored as a gate with impact and the UI-only "always"', async () => {
  const s = setup()
  permission(s, 'git push origin main')
  const [item] = listInboxItems(s.ctx)
  expect(item).toMatchObject({ kind: 'gate', source: 'approval', approvalKind: PERMISSION_KIND, nodeId: 'a1', title: 'brisk-otter wants to run: Bash(git push origin main)' })
  expect(item.impact).toMatchObject({ tier: 'R3', rewindable: false })
  expect(item.actions).toEqual(['approve', 'edit', 'deny', 'ignore', 'snooze', 'always'])
  expect(item.args).toEqual({ command: 'git push origin main' })
  expect((await actOnItem(s.deps, item.id, { type: 'edit', args: 'rm -rf /' })).body).toMatchObject({ error: 'invalid_args' })
  expect((await actOnItem(s.deps, item.id, { type: 'deny' })).body).toEqual({ id: item.id, resolution: 'denied' })
  expect(rows(s.db, 'SELECT status FROM approval WHERE id = ?', item.approvalId)[0].status).toBe('rejected')
})

test('Telegram and the canvas produce the same decision event', async () => {
  const s = setup()
  const viaUi = permission(s, 'ls')
  const viaTg = permission(s, 'pwd')
  const [uiItem] = listInboxItems(s.ctx).filter((i) => i.approvalId === viaUi.id)
  await actOnItem(s.deps, uiItem.id, { type: 'approve' })
  const challenge = ledgerChallengePort(s.db).challengeFor(viaTg.id)!
  const reply = handleApprove({ approval: ledgerApprovalPort(createLedger(s.db, { now: s.ctx.now })), record: (e) => { s.events.push(e) } },
    { updateId: 1, chatId: '42', userId: '7', text: '', isGroup: false }, { projectId: 'p1', role: 'approver' },
    { kind: 'approve', approvalId: viaTg.id, ...challenge })
  expect(reply).toContain('Approved')
  const [ui, tg] = s.events.filter((e) => e.kind === INBOX_DECISION_EVENT)
  const shape = (e: AppendEventInput) => ({ ...e, actor: undefined, subject: undefined, payload: { ...(e.payload as object), approvalId: undefined } })
  expect(shape(tg)).toEqual(shape(ui))
  expect([ui.actor, tg.actor]).toEqual(['human:loopback', 'telegram:7'])
  // The mirrored row closes on the next read, whichever surface decided.
  expect(listInboxItems(s.ctx)).toHaveLength(0)
})

test('a daily digest sums up yesterday\'s notify news once per day, without spend warnings', () => {
  const s = setup()
  createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: 'Build finished', dedupeKey: 'build' })
  createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: 'Build finished', dedupeKey: 'build' })
  createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: 'Tests green' })
  createInboxItem(s.ctx, { kind: 'notify', source: 'cost', title: "Today's spend passed $10", dedupeKey: 'cost:day-warning:x' })
  s.clock.t = T0 + 1000
  const digest = listInboxItems(s.ctx).filter((i) => i.source === 'digest')
  expect(digest).toHaveLength(1)
  expect(digest[0].title).toBe('Daily digest: 2 updates')
  expect(digest[0].body).toContain('Build finished (×2)')
  expect(digest[0].body).not.toContain('spend') // spend warnings never ride in the digest
  expect(listInboxItems(s.ctx).filter((i) => i.source === 'digest')).toHaveLength(1)
})

test('HTTP /api/approvals/inbox: the page lists, acts and batches; an agent credential is refused', async () => {
  const s = setup()
  const g = gate(s)
  const runtime = { mode: 'on', path: ':memory:', db: s.db, ledger: createLedger(s.db, { now: s.ctx.now }), close() {} } as unknown as LedgerRuntime
  const call = async (path: string, headers: Record<string, string>, payload?: unknown) => {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage
    req.method = payload === undefined ? 'GET' : 'POST'
    req.headers = headers
    const out = { statusCode: 0, payload: '', setHeader() {}, end(d = '') { out.payload = d } }
    await approvalHumanRoute(req, out as unknown as ServerResponse, new URL(`http://x${path}`), { runtime, now: s.ctx.now, isNodeToken: (t) => t === 'node-tok', record: s.deps.record, outbox: s.deps.outbox })
    return { status: out.statusCode, json: JSON.parse(out.payload || '{}') as Record<string, unknown> }
  }
  const page = { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE }
  expect(((await call('/api/approvals/inbox', page)).json.items as unknown[]).length).toBe(1)
  expect((await call('/api/approvals/inbox/act', { ...page, 'x-webterm-token': 'node-tok' }, { id: g.id, action: { type: 'approve' } })).status).toBe(403)
  expect((await call('/api/approvals/inbox/act', page, { id: g.id, action: { type: 'nope' } })).status).toBe(400)
  expect((await call('/api/approvals/inbox/batch', page, { ids: [g.id], action: { type: 'always' } })).status).toBe(400)
  const batch = await call('/api/approvals/inbox/batch', page, { ids: [g.id], action: { type: 'approve' } })
  expect(batch.json).toEqual({ results: [{ id: g.id, status: 200, body: { id: g.id, resolution: 'approved' } }] })
})
