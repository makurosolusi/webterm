// Bun-only (bun:sqlite): the unified inbox (F3-a) over the real ledger schema. Kinds and their
// actions, coalescing, snooze, edit-then-approve, reply via the outbox, batch with the R3 guard,
// mirrored Claude permission gates, Telegram cards (Approve once / Deny only, fake fetch, never the
// network), the attention policy, the daily digest, the UI-only HTTP seam, and the same decision
// event from Telegram and the canvas.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { approvalHumanRoute } from '../approvalHumanApi'
import { freshDb, rows, T0 } from '../central/guard/controlGuard.testutil'
import { handleApprove } from '../channels/channelApprovals'
import { ledgerChallengePort } from '../channels/channelButtons'
import { parseApprovalCallback } from '../channels/channelCallback'
import { ledgerApprovalPort } from '../channels/channelsRuntime.types'
import { renderInboxCard, sendTelegramCard, type TelegramCard } from '../channels/telegramCards'
import type { AppendEventInput } from '../events/eventModel'
import { createLedger } from '../ledger/ledger'
import { requestApproval } from '../ledger/ledgerApproval'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { createOutboxStore } from '../outbox/outboxStore'
import { PERMISSION_KIND } from '../permission/permission.model'
import { actOnItem, actOnItems, type InboxActDeps } from './inboxActions'
import { attentionFor } from './inboxAttention'
import { INBOX_DECISION_EVENT, type Impact } from './inboxItemModel'
import { UNPUSHED_PAGE, approvedArgsFor, createGate, createInboxItem, getInboxItem, listInboxItems } from './inboxItemStore'
import { createPresenceTracker } from '../channels/channelPresence'
import { approverChats, approverProjects, sweepInboxPush, watchingFrom, type PushDeps } from './inboxPush'

const R2: Impact = { what: 'Runs the migration', tier: 'R2', rewindable: true }
const R3: Impact = { what: 'Publishes the package', tier: 'R3', rewindable: false }

function setup() {
  const db = freshDb()
  const clock = { t: T0 }
  const ctx = { db, now: () => clock.t }
  const events: AppendEventInput[] = []
  const outbox = createOutboxStore(db, ctx.now)
  const deps: InboxActDeps = {
    ctx, actor: 'human:loopback', record: (e) => { events.push(e) },
    outbox: async () => ({ refusal: (to: string) => (to === 'gone' ? 'node gone is not an agent' : null), enqueue: (i) => outbox.enqueue(i) }),
  }
  return { db, ctx, clock, events, outbox, deps }
}

const gate = (s: ReturnType<typeof setup>, impact = R2, args: unknown = { table: 'users' }) =>
  createGate(s.ctx, { projectId: 'p1', source: 'central', title: 'Run migration 0042', args, impact, editable: true, nodeId: 'a1', workspaceId: 'w1' })

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

test('gate cards carry only Approve once / Deny; the sender posts that markup (fake fetch)', async () => {
  const s = setup()
  const g = gate(s, R3)
  const card = renderInboxCard(g, 'One')
  expect(card.buttons.map((b) => b.text)).toEqual(['Approve once', 'Deny'])
  expect(card.buttons.map((b) => parseApprovalCallback(b.data))).toEqual([{ approvalId: g.approvalId!, approve: true }, { approvalId: g.approvalId!, approve: false }])
  expect(card.html).toContain('cannot be rewound')
  expect(card.html.toLowerCase()).not.toContain('always')
  const sent: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetch = async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }
  }
  const ok = await sendTelegramCard('42', card, { fetch, env: { WEBTERM_TELEGRAM_BOT_TOKEN: 'test-token' }, apiBase: 'http://telegram.invalid' })
  expect(ok).toBe(true)
  expect(sent[0].url).toBe('http://telegram.invalid/bottest-token/sendMessage')
  expect(sent[0].body).toMatchObject({ chat_id: '42', parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Approve once' }, { text: 'Deny' }]] } })
  expect(await sendTelegramCard('42', card, { fetch, env: {} })).toBe(false) // no token: nothing sent
  expect(sent).toHaveLength(1)
})

function pushDeps(s: ReturnType<typeof setup>, opts: { watching?: boolean; muted?: string[] } = {}) {
  const cards: Array<{ chat: string; card: TelegramCard }> = []
  const bindings = [{ chatId: '42', binding: { projectId: 'p1', role: 'approver' as const } }, { chatId: '9', binding: { projectId: 'p1', role: 'viewer' as const } }]
  const deps: PushDeps = {
    ctx: s.ctx,
    chatsFor: (projectId) => approverChats(bindings, projectId),
    boundProjects: () => approverProjects(bindings),
    attention: { watching: () => opts.watching ?? false, muted: (ws) => (opts.muted ?? []).includes(ws) },
    send: async (chat, card) => { cards.push({ chat, card }); return true },
  }
  return { deps, cards }
}

test('every gate is pushed once to approver chats; watching holds it; mute and notify news never ping', async () => {
  const s = setup()
  const g = gate(s)
  const q = createInboxItem(s.ctx, { kind: 'question', source: 'agent', title: 'Which branch?', projectId: 'p1', workspaceId: 'w1', nodeId: 'a1' })
  createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: 'Build finished', projectId: 'p1', workspaceId: 'w1' })

  const looking = pushDeps(s, { watching: true })
  expect(await sweepInboxPush(looking.deps)).toEqual({ pushed: [], held: [g.id, q.id] })
  expect(looking.cards).toHaveLength(0)

  const away = pushDeps(s, { muted: ['w1'] })
  expect((await sweepInboxPush(away.deps)).pushed).toEqual([g.id]) // muted: the question is skipped, the gate is not
  expect(away.cards.map((c) => c.chat)).toEqual(['42'])
  expect(away.cards[0].card.buttons.map((b) => b.text)).toEqual(['Approve once', 'Deny'])
  expect((await sweepInboxPush(away.deps)).pushed).toEqual([]) // once only
  expect(attentionFor({ kind: 'notify', source: 'digest', nodeId: null, workspaceId: null }, away.deps.attention)).toBe('push')
})

test('N>LIMIT undeliverable items never block a deliverable one', async () => {
  const s = setup()
  for (let i = 0; i < UNPUSHED_PAGE + 5; i += 1) {
    s.clock.t += 1
    createInboxItem(s.ctx, { kind: 'review', source: 'routines', projectId: 'unbound', title: `routine ${i}` })
  }
  s.clock.t += 1
  const fresh = createInboxItem(s.ctx, { kind: 'question', source: 'agent', projectId: 'p1', title: 'p1 needs you' })
  const away = pushDeps(s)
  expect((await sweepInboxPush(away.deps)).pushed).toEqual([fresh.id])
  expect(away.cards.map((c) => c.chat)).toEqual(['42'])
  // Undeliverable rows stay unpushed, so binding their project later still delivers them.
  expect(rows(s.db, "SELECT COUNT(*) AS n FROM inbox_item WHERE project_id = 'unbound' AND pushed_at IS NULL")[0]?.['n']).toBe(UNPUSHED_PAGE + 5)
})

test('more held items than a page never hide a deliverable one behind them', async () => {
  const s = setup()
  for (let i = 0; i < UNPUSHED_PAGE + 5; i += 1) {
    s.clock.t += 1
    createInboxItem(s.ctx, { kind: 'question', source: 'agent', projectId: 'p1', nodeId: 'watched', title: `held ${i}` })
  }
  s.clock.t += 1
  const other = createInboxItem(s.ctx, { kind: 'question', source: 'agent', projectId: 'p1', nodeId: 'elsewhere', title: 'other node' })
  const away = pushDeps(s)
  away.deps.attention = { watching: (item) => item.nodeId === 'watched', muted: () => false }
  const result = await sweepInboxPush(away.deps)
  expect(result.pushed).toEqual([other.id])
  expect(result.held).toHaveLength(UNPUSHED_PAGE + 5)
})

test('a daily digest sums up yesterday\'s notify news once per day', () => {
  const s = setup()
  createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: 'Build finished', dedupeKey: 'build' })
  createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: 'Build finished', dedupeKey: 'build' })
  createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: 'Tests green' })
  s.clock.t = T0 + 1000
  const digest = listInboxItems(s.ctx).filter((i) => i.source === 'digest')
  expect(digest).toHaveLength(1)
  expect(digest[0].title).toBe('Daily digest: 2 updates')
  expect(digest[0].body).toContain('Build finished (×2)')
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

test('Diff "Send to agent" notes show up as one review item, and never ping Telegram', async () => {
  const s = setup()
  s.outbox.enqueue({ to: 'a1', kind: 'visible', createdBy: 'human-ui', operationId: 'diff-notes:a1:n1:2',
    body: '[webterm] Review notes on your working-tree diff (2):\n\nFile: a.ts' })
  s.outbox.enqueue({ to: 'a1', kind: 'visible', createdBy: 'human-ui', operationId: 'link-note:a1', body: 'not a review' })
  const items = listInboxItems(s.ctx)
  expect(items.map((i) => [i.kind, i.source, i.nodeId, i.title])).toEqual([['review', 'diff-notes', 'a1', 'Review notes sent to the agent (2)']])
  expect(listInboxItems(s.ctx)).toHaveLength(1) // mirrored once
  const away = pushDeps(s)
  expect((await sweepInboxPush(away.deps)).pushed).toEqual([])
  expect(away.cards).toHaveLength(0)
})

test('attention is per node: only the focused node is watched; a stale focus watches nothing', () => {
  const clock = { t: T0 }
  const p = createPresenceTracker(() => clock.t)
  p.note({ visible: true, nodeId: 'a1', workspaceId: 'w1' })
  expect(watchingFrom(p, { nodeId: 'a1' })).toBe(true)
  expect(watchingFrom(p, { nodeId: 'a2' })).toBe(false) // at the desk but on another node: still pushed
  expect(watchingFrom(p, { nodeId: null })).toBe(true)
  clock.t += 60_000
  expect(watchingFrom(p, { nodeId: 'a1' })).toBe(false)
  p.note({ visible: true, nodeId: null })
  expect(p.focusedNode()).toBeNull()
})

test('the channels runtime pushes gate cards on its own and stops with it (fake fetch, no network)', async () => {
  const { startChannelsRuntime } = await import('../channels/channelsRuntime')
  const { harnessLedger } = await import('../channels/channelsRuntimeHarness')
  const dir = mkdtempSync(join(tmpdir(), 'inbox-push-'))
  const before = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = dir // test-only: never touch the real data dir
  const s = setup()
  const sent: Array<Record<string, unknown>> = []
  try {
    const runtime = startChannelsRuntime(harnessLedger(), {
      env: { WEBTERM_TELEGRAM: 'on', WEBTERM_TELEGRAM_BOT_TOKEN: 'test-token' } as NodeJS.ProcessEnv, // test-only token
      ledgerDb: s.db,
      now: s.ctx.now, // the gates are created on the test clock; real time would see them expired
      sender: {
        intervalMs: 60_000,
        fetch: async (_url, init) => { sent.push(JSON.parse(init.body) as Record<string, unknown>); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) } },
      },
      subscribe: () => () => {},
    })
    expect(runtime).not.toBeNull()
    runtime?.store.bind("telegram", "42", { projectId: "p1", role: "owner" })
    const g = gate(s)
    await new Promise((r) => setTimeout(r, 3500))
    const keys = (b: Record<string, unknown>) => (b.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard[0].map((k) => k.text)
    expect(sent.map((b) => [b.chat_id, keys(b)])).toEqual([['42', ['Approve once', 'Deny']]])
    expect(rows(s.db, 'SELECT pushed_at FROM inbox_item WHERE id = ?', g.id)[0].pushed_at).not.toBeNull()
    runtime?.stop()
    gate(s)
    await new Promise((r) => setTimeout(r, 3500))
    expect(sent).toHaveLength(1) // stopped: no more cards
  } finally {
    if (before === undefined) delete process.env.WEBTERM_DATA_DIR
    else process.env.WEBTERM_DATA_DIR = before
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)
