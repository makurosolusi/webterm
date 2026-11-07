// Bun-only. Approval cards reach their Central conversation live: `approval.requested` when a card is
// created, `approval.updated` when it is decided (chat/inbox act route, Telegram) or expires, with the
// frame `{ approvalId, state, title? }`; the approval part is persisted at request time.
import { expect, test } from 'bun:test'
import { handleApprove } from '../../channels/channelApprovals'
import { ledgerApprovalPort } from '../../channels/channelsRuntime.types'
import { inboxActRoute } from '../../inbox/inboxItemRoute'
import { createLedger } from '../../ledger/ledger'
import { expireApprovals, requestApproval } from '../../ledger/ledgerApproval'
import { getRow } from '../../ledger/ledgerCore'
import type { ControlGuard } from '../contracts'
import { appendMessage, getOrCreateConversation, listConversationEvents } from '../conversationStore'
import { freshDb, T0 } from '../guard/controlGuard.testutil'
import { type AgentHost, createAgentExecutor } from '../agents/agentExecutor'
import { agentReqId } from '../agents/agentStore'
import { registerApprovalStream } from './approvalPublish'
import { listMessages } from './turnPersistence'
import { StreamHub } from './streamHub'

const CONV = 'central:global'

function setup() {
  const db = freshDb()
  const clock = { t: T0 }
  const now = () => clock.t
  getOrCreateConversation(db, 'global', T0)
  const hub = new StreamHub({ replay: (id, after) => listConversationEvents(db, id, after, 500), heartbeatMs: 0 })
  registerApprovalStream(db, hub, now)
  const frames: { event: string; payload: unknown }[] = []
  hub.subscribe(CONV, 0, (f) => { if (f.kind === 'event') frames.push({ event: f.event, payload: (f.data as { payload: unknown }).payload }) })
  const card = (ttlMs?: number) => requestApproval({ db, now }, { projectId: 'p1', kind: 'goal.propose', request: { tool: 'goal.propose', conversationId: CONV, input: {} }, ...(ttlMs ? { ttlMs } : {}) })
  const approvalParts = () => listMessages(db, CONV).items.flatMap((m) => m.parts.filter((p) => p.type === 'approval'))
  return { db, clock, now, frames, card, approvalParts }
}

test('a new card emits approval.requested and is persisted as an approval part at once', () => {
  const s = setup()
  const c = s.card()
  expect(s.frames).toEqual([{ event: 'approval.requested', payload: { approvalId: c.id, state: 'pending', title: 'Run goal.propose' } }])
  expect(s.approvalParts()).toEqual([{ type: 'approval', approvalId: c.id, state: 'awaiting_approval', expiresAt: c.expiresAt }])
})

test('a card raised mid-turn lands in the streaming reply, not a message of its own', () => {
  const s = setup()
  const reply = appendMessage(s.db, { conversationId: CONV, role: 'assistant', parts: [{ type: 'text', text: 'Asking.' }], state: 'streaming', now: T0 }).message
  const c = s.card()
  const items = listMessages(s.db, CONV).items
  expect(items).toHaveLength(1)
  expect(items[0]!.id).toBe(reply.id)
  expect(items[0]!.parts.map((p) => p.type)).toEqual(['text', 'approval'])
  expect(items[0]!.parts[1]).toMatchObject({ approvalId: c.id })
})

test('a decision from the inbox act route emits approval.updated and updates the stored part', async () => {
  const s = setup()
  const c = s.card()
  const res = await inboxActRoute({ ctx: { db: s.db, now: s.now }, actor: 'human:loopback', record: () => undefined, outbox: async () => { throw new Error('test-only: no outbox') } }, { id: c.id, action: { type: 'deny' } })
  expect(res.status).toBe(200)
  expect(s.frames.at(-1)).toEqual({ event: 'approval.updated', payload: { approvalId: c.id, state: 'rejected', title: 'Run goal.propose' } })
  expect(s.approvalParts()).toMatchObject([{ approvalId: c.id, state: 'denied' }])
})

test('a decision from Telegram emits approval.updated', () => {
  const s = setup()
  const c = s.card()
  const port = ledgerApprovalPort(createLedger(s.db, { now: s.now }))
  const reply = handleApprove({ approval: port, record: () => undefined },
    { updateId: 1, chatId: 'c1', userId: '42', text: '', isGroup: false }, { projectId: 'p1', role: 'approver' },
    { kind: 'approve', approvalId: c.id, digest: c.digest, nonce: c.nonce })
  expect(reply.startsWith(`Approved ${c.id}`)).toBe(true)
  expect(s.frames.at(-1)).toEqual({ event: 'approval.updated', payload: { approvalId: c.id, state: 'approved', title: 'Run goal.propose' } })
  expect(s.approvalParts()).toMatchObject([{ approvalId: c.id, state: 'succeeded' }])
})

test('the expiry sweep emits approval.updated expired', () => {
  const s = setup()
  const c = s.card(1000)
  s.clock.t += 1001
  expect(expireApprovals({ db: s.db, now: s.now })).toBe(1)
  expect(s.frames.at(-1)).toEqual({ event: 'approval.updated', payload: { approvalId: c.id, state: 'expired', title: 'Run goal.propose' } })
  expect(s.approvalParts()).toMatchObject([{ approvalId: c.id, state: 'cancelled' }])
})

test('an agent spawn card reaches the conversation that owns the agent', async () => {
  const s = setup()
  const guard: ControlGuard = {
    check: () => ({ verdict: 'needs_approval', level: 'propose', tier: 'R2' }), effectiveLevel: () => 'propose', recordUsage: () => undefined,
    breaker: { allow: () => ({ allowed: true, state: 'closed' }), trip: () => 'closed', recordSuccess: () => undefined },
  }
  const host = { runnerFor: () => 'pty', spawnTier: () => 'R2' } as unknown as AgentHost // test-only: spawn never launches here
  const ex = createAgentExecutor({ db: s.db, guard, host, now: s.now })
  const res = await ex.spawn({ projectId: 'p1', kind: 'opencode', role: 'worker', title: 't', reqId: agentReqId('p1', 'r1'), owner: `central:${CONV}`, requireApproval: false })
  expect(s.frames.at(-1)).toEqual({ event: 'approval.requested', payload: { approvalId: res.data?.approvalId, state: 'pending', title: 'Start a opencode worker agent' } })
})

test('a card no conversation owns emits nothing', () => {
  const s = setup()
  requestApproval({ db: s.db, now: s.now }, { projectId: 'p1', kind: 'worker.run', request: { action: 'x' } })
  expect(s.frames).toEqual([])
  expect(getRow(s.db, 'SELECT COUNT(*) AS n FROM central_event WHERE conversation_id = ?', CONV)?.['n']).toBe(0)
})
