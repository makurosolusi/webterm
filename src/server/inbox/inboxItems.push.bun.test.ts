// Bun-only (bun:sqlite): inbox push to Telegram over the real ledger schema. Gate cards (Approve
// once / Deny only, fake fetch, never the network), the push sweep and its paging, per-node
// attention, and the channels runtime pushing on its own. The inbox items and their actions live
// in inboxItems.bun.test.ts.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rows, T0 } from '../central/guard/controlGuard.testutil'
import { parseApprovalCallback } from '../channels/channelCallback'
import { renderInboxCard, sendTelegramCard, type TelegramCard } from '../channels/telegramCards'
import { attentionFor } from './inboxAttention'
import { UNPUSHED_PAGE, createInboxItem, listInboxItems } from './inboxItemStore'
import { createPresenceTracker } from '../channels/channelPresence'
import { approverChats, approverProjects, sweepInboxPush, watchingFrom, type PushDeps } from './inboxPush'
import { R3, gate, setup } from './inboxItems.testutil'

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
