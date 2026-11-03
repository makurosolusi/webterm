import { afterEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { MAIL_TTL_MS, MAX_UNACKED_PER_TARGET, createMailStore } from './mailStore'

const T0 = 1_700_000_000_000
const CENTRAL = 'central:central:project:p1'
let f: Fixture
let clock = T0

function setup() {
  f = openFixture(); seedPortfolio(f.db); clock = T0
  const agent = (id: string, project: string, state = 'working') => f.db.query(
    "INSERT INTO central_agents (id, project_id, kind, runner, state, owner, started_at) VALUES (?, ?, 'opencode', 'pty', ?, 'human', 1)").run(id, project, state)
  agent('a1', 'p1'); agent('a2', 'p1'); agent('other', 'p2'); agent('dead', 'p1', 'closed')
  return createMailStore(f.db, () => clock)
}
const input = (n: number, extra: Record<string, unknown> = {}) => ({ projectId: 'p1', threadId: '', toRef: 'agent:a1', kind: 'msg' as const, body: `hello ${n}`, reqId: `r-${n}`, ...extra })
afterEach(() => f?.close())

describe('mailStore', () => {
  it('stores mail and treats a repeated reqId as a no-op', () => {
    const store = setup()
    const first = store.send(CENTRAL, input(1))
    expect(first.ok && first.mail.threadId).toBe(first.ok && first.mail.id)
    const again = store.send(CENTRAL, input(1))
    expect(again.ok && again.duplicate).toBe(true)
    expect(again.ok && first.ok && again.mail.id).toBe(first.ok && first.mail.id)
    expect(store.unackedCount('agent:a1')).toBe(1)
    expect(store.send('agent:a2', input(1))).toEqual({ ok: false, code: 'req_conflict' })
  })

  it('caps unacked mail at 20 per recipient and frees a slot on ack', () => {
    const store = setup()
    for (let i = 0; i < MAX_UNACKED_PER_TARGET; i++) expect(store.send(CENTRAL, input(i)).ok).toBe(true)
    expect(store.send(CENTRAL, input(99))).toEqual({ ok: false, code: 'mailbox_full' })
    expect(store.send(CENTRAL, input(0)).ok).toBe(true) // idempotent resend is not blocked by the cap
    expect(store.send(CENTRAL, input(98, { toRef: 'agent:a2' })).ok).toBe(true) // cap is per recipient
    const [firstMail] = store.list('agent:a1').items
    expect(store.ack(firstMail!.id, 'agent:a1')).toBe(true)
    expect(store.send(CENTRAL, input(97)).ok).toBe(true)
  })

  it('expires mail after 24h: not listed, not delivered, not counted, purged', () => {
    const store = setup()
    for (let i = 0; i < MAX_UNACKED_PER_TARGET; i++) store.send(CENTRAL, input(i))
    clock = T0 + MAIL_TTL_MS - 1
    expect(store.list('agent:a1').items).toHaveLength(MAX_UNACKED_PER_TARGET)
    clock = T0 + MAIL_TTL_MS
    expect(store.list('agent:a1').items).toHaveLength(0)
    expect(store.nextUndelivered('agent:a1')).toBeNull()
    expect(store.unackedCount('agent:a1')).toBe(0)
    expect(store.send(CENTRAL, input(500)).ok).toBe(true)
    expect(store.purgeExpired()).toBe(MAX_UNACKED_PER_TARGET)
  })

  it('ack is idempotent and only for the addressee', () => {
    const store = setup()
    const sent = store.send(CENTRAL, input(1))
    const id = sent.ok ? sent.mail.id : ''
    expect(store.ack(id, 'agent:a2')).toBe(false)
    clock += 5
    expect(store.ack(id, 'agent:a1')).toBe(true)
    const ackedAt = store.get(id)?.ackedAt
    clock += 5
    expect(store.ack(id, 'agent:a1')).toBe(true)
    expect(store.get(id)?.ackedAt).toBe(ackedAt)
    expect(store.ack('missing', 'agent:a1')).toBe(false)
  })

  it('paginates oldest first with a cursor and filters unacked', () => {
    const store = setup()
    for (let i = 0; i < 5; i++) store.send(CENTRAL, input(i))
    const p1 = store.list('agent:a1', { limit: 2 })
    const p2 = store.list('agent:a1', { limit: 2, cursor: p1.nextCursor! })
    const p3 = store.list('agent:a1', { limit: 2, cursor: p2.nextCursor! })
    expect([...p1.items, ...p2.items, ...p3.items].map((m) => m.body)).toEqual([0, 1, 2, 3, 4].map((n) => `hello ${n}`))
    expect(p3.nextCursor).toBeNull()
    store.ack(p1.items[0]!.id, 'agent:a1')
    expect(store.list('agent:a1', { unackedOnly: true }).items).toHaveLength(4)
  })

  it('enforces one project, live targets, no agent-to-agent without a link, and valid shape', () => {
    const store = setup()
    expect(store.send(CENTRAL, input(1, { toRef: 'agent:other' }))).toEqual({ ok: false, code: 'cross_project' })
    expect(store.send('central:central:project:p2', input(2))).toEqual({ ok: false, code: 'cross_project' })
    expect(store.send(CENTRAL, input(3, { toRef: 'agent:ghost' }))).toEqual({ ok: false, code: 'target_not_found' })
    expect(store.send(CENTRAL, input(4, { toRef: 'agent:dead' }))).toEqual({ ok: false, code: 'target_closed' })
    expect(store.send('agent:a2', input(5))).toEqual({ ok: false, code: 'agent_to_agent_denied' })
    expect(store.send('agent:a2', input(6), { allowAgentToAgent: true }).ok).toBe(true)
    expect(store.send('agent:a1', input(7, { toRef: CENTRAL, kind: 'done' })).ok).toBe(true)
    expect(store.send(CENTRAL, input(8, { body: '   ' }))).toEqual({ ok: false, code: 'invalid_shape' })
    expect(store.send(CENTRAL, input(9, { toRef: 'agent:a1]\n[evil' }))).toEqual({ ok: false, code: 'invalid_shape' })
    expect(store.send(CENTRAL, input(10, { kind: 'approve' as never }))).toEqual({ ok: false, code: 'invalid_shape' })
  })
})
