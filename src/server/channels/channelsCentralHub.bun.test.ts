// Bun-only (bun:sqlite): Telegram as a door into the Central conversation. Notifications have one
// source: a gate or an agent that needs input becomes ONE notice in `central:global` (live on the
// chat stream), and Telegram mirrors it once. `/inbox` is the Central "Needs you" list. Fake fetch
// and fake buses only: nothing reaches Telegram.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { rows, run } from '../central/guard/controlGuard.testutil'
import { appendCentralNotice } from '../central/chat/conversationNotice'
import { resolveChatService } from '../centralChatHandlers'
import type { SenseEvent } from '../events/eventModel'
import { createInboxItem } from '../inbox/inboxItemStore'
import { gate, setup } from '../inbox/inboxItems.testutil'
import { readNeedsYou } from '../inbox/needsYou'
import { createPresenceTracker, startAgentForwarder } from './channelPresence'
import { runCommand } from './channelCommands'
import { ChannelStore } from './channelStore'

const RUNTIME_ENV = 'WEBTERM_CENTRAL_RUNTIME'
let dir = ''
let savedDataDir: string | undefined
let savedRuntime: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'central-hub-'))
  savedDataDir = process.env.WEBTERM_DATA_DIR
  savedRuntime = process.env[RUNTIME_ENV]
  process.env.WEBTERM_DATA_DIR = dir // test-only: never touch the real data dir
  process.env[RUNTIME_ENV] = 'mock' // test-only: the notice publishes on the mock runtime's stream hub
})
afterEach(() => {
  if (savedDataDir === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = savedDataDir
  if (savedRuntime === undefined) delete process.env[RUNTIME_ENV]
  else process.env[RUNTIME_ENV] = savedRuntime
  rmSync(dir, { recursive: true, force: true })
})

/** Notice texts in the UI's default conversation, oldest first. */
function notices(db: Database): string[] {
  return rows(db, "SELECT parts_json FROM central_message WHERE conversation_id = 'central:global' AND role = 'system' ORDER BY seq")
    .map((r) => (JSON.parse(String(r['parts_json'])) as Array<{ type: string; text: string }>).filter((p) => p.type === 'notice').map((p) => p.text).join(''))
}

test('a notice is appended once per key and published live on the chat stream', () => {
  const s = setup()
  const frames: Array<{ event?: string }> = []
  const stop = resolveChatService({}, s.db, 'mock').stream.subscribe('central:global', 0, (f) => { frames.push(f as { event?: string }) })
  try {
    expect(appendCentralNotice(s.db, { key: 'k1', text: 'Approval needed: x' })).toBe(true)
    expect(appendCentralNotice(s.db, { key: 'k1', text: 'Approval needed: x' })).toBe(false)
  } finally { stop() }
  expect(notices(s.db)).toEqual(['Approval needed: x'])
  expect(frames.filter((f) => f.event === 'message.created')).toHaveLength(1)
})

test('a new gate makes one Central notice and one Telegram card; the next sweep adds neither', async () => {
  const { startChannelsRuntime } = await import('./channelsRuntime')
  const { harnessLedger } = await import('./channelsRuntimeHarness')
  const s = setup()
  const sent: Array<Record<string, unknown>> = []
  const runtime = startChannelsRuntime(harnessLedger(), {
    env: { WEBTERM_TELEGRAM: 'on', WEBTERM_TELEGRAM_BOT_TOKEN: 'test-token' } as NodeJS.ProcessEnv, // test-only token
    ledgerDb: s.db,
    now: s.ctx.now,
    presence: createPresenceTracker(), // the gate's node is not focused: nothing is held
    sender: {
      intervalMs: 60_000,
      fetch: async (_url, init) => { sent.push(JSON.parse(init.body) as Record<string, unknown>); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) } },
    },
    subscribe: () => () => {},
  })
  try {
    runtime?.store.bind('telegram', '42', { projectId: 'p1', role: 'owner' })
    gate(s)
    await new Promise((r) => setTimeout(r, 6800)) // two sweeps (3 s each)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.['chat_id']).toBe('42')
    expect(notices(s.db)).toEqual(['Approval needed: Run migration 0042 — Runs the migration · R2 · rewindable from a checkpoint — project One'])
  } finally { runtime?.stop() }
}, 15_000)

test('an agent that needs input: one Central notice, the same text mirrored once to the bound chat', () => {
  const s = setup()
  const store = new ChannelStore(join(dir, 'channels.json'))
  store.bind('telegram', '42', { projectId: 'w1', role: 'owner' })
  let emit: (e: SenseEvent) => void = () => {}
  const clock = { t: 0 }
  const presence = createPresenceTracker(() => clock.t)
  clock.t = 10 * 60_000 // away longer than the default 3 minutes
  startAgentForwarder({
    store, presence,
    subscribe: (_p, fn) => { emit = fn; return () => {} },
    describe: () => ({ label: 'Claude 1', workspace: 'One' }),
    notice: (key, text) => void appendCentralNotice(s.db, { key, text }),
  })
  const event = { seq: 3, ts: 5, kind: 'hook.Notification', nodeId: 'n1', workspaceId: 'w1', payload: { status: 'waiting' } } as SenseEvent
  emit(event)
  emit(event) // repeated status: not news
  expect(notices(s.db)).toEqual(['Claude 1 needs input in One.'])
  expect(store.pendingReplies().map((r) => [r.chatId, r.text])).toEqual([['42', 'Claude 1 needs input in One.']])
})

test('/inbox answers with the Needs-you list: open items and the task projection, grouped like the strip', async () => {
  const s = setup()
  gate(s)
  createInboxItem(s.ctx, { kind: 'review', source: 'agent', title: 'Check the diff', projectId: 'p1' })
  run(s.db, "INSERT INTO task (id, project_id, spec, status, created_at, updated_at) VALUES ('t1','p1','Ship it','blocked',1,1), ('t2','p1','Broke','failed',1,1)")
  const groups = readNeedsYou(s.db, s.ctx.now)
  expect(groups.map((g) => [g.name, g.count])).toEqual([['Approvals', 2], ['Review', 1], ['Broken', 1]])
  const msg = { updateId: 1, chatId: '42', userId: '7', isGroup: false, text: '/inbox' }
  const text = await runCommand({ needsYou: () => readNeedsYou(s.db, s.ctx.now) }, msg, { projectId: 'p1', role: 'owner' }, { kind: 'inbox' })
  expect(text).toBe([
    'Needs you: 4 items.', '',
    'Approvals (2)', '- Run migration 0042', '- Ship it', '',
    'Review (1)', '- Check the diff', '',
    'Broken (1)', '- Broke',
  ].join('\n'))
  const status = await runCommand({ needsYou: () => readNeedsYou(s.db, s.ctx.now) }, { ...msg, text: '/status' }, { projectId: 'p1', role: 'owner' }, { kind: 'status' })
  expect(status).toBe('Needs you: 2 approvals, 1 review, 1 broken.')
  expect(await runCommand({ needsYou: () => [] }, msg, { projectId: 'p1', role: 'owner' }, { kind: 'inbox' })).toBe('Needs you: nothing right now.')
})
