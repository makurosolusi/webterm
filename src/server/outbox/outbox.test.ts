// Outbox delivery contract on the REAL store (node:sqlite bridge + the v12 DDL) with a fake session:
// exactly-once under a retried operationId, queued while busy and delivered on the idle hook, a
// draft in the composer waits, transport choice, queued rows survive a "restart", events recorded.
import { describe, expect, it } from 'vitest'
import type { AgentId, AgentStatus } from '../../shared/workspace'
import { DDL_V12 } from '../ledger/ledgerSchemaV12'
import { nodeSqlite } from '../nodeSqlite.testutil'
import { createEventBus } from '../events/eventBus'
import type { AppendEventInput, SenseEvent } from '../events/eventModel'
import { chooseTransport, OutboxDelivery, subscribeOutbox } from './outboxDelivery'
import { createOutboxStore } from './outboxStore'
import { outboxRoute } from './outbox.route'

const RULE = '─'.repeat(40)
/** A Claude Code bottom box; `draft` undefined = dim placeholder (empty composer). */
const box = (draft?: string): string =>
  ['', RULE, draft === undefined ? '❯ \x1b[2mTry "fix typecheck errors"\x1b[22m' : `❯ ${draft}`, RULE, '  ? for shortcuts'].join('\n')

function rig(agent: AgentId | null = 'claude', db = nodeSqlite().db) {
  const st = { status: undefined as AgentStatus | undefined, draft: undefined as string | undefined, live: true }
  const writes: string[] = []
  const events: AppendEventInput[] = []
  const make = () => new OutboxDelivery({
    store: createOutboxStore(db),
    agentOf: (id) => (id === 'gone' ? undefined : agent),
    sessions: {
      statusOf: () => st.status,
      screenSource: () => (st.live ? { data: '', seq: 1, cols: 80, rows: 24, pid: 1 } : undefined),
      input: (_id, data) => {
        writes.push(data)
        if (data === '\r') { st.draft = undefined; st.status = 'working' } else st.draft = (st.draft ?? '') + data
      },
    },
    record: (e) => { events.push(e) },
    render: async () => box(st.draft),
    sleep: async () => {},
  })
  db.exec(DDL_V12)
  return { db, st, writes, events, outbox: make(), make }
}
const msg = (op: string, over: Record<string, unknown> = {}) =>
  ({ to: 'a1', body: `hello ${op}`, kind: 'visible' as const, operationId: op, createdBy: 'test', ...over })
const hook = (nodeId: string, name: string): SenseEvent => ({
  seq: 0, ts: 0, kind: `hook.${name}`, source: 'test', actor: 'test', subject: null, workspaceId: null, nodeId,
  trust: 'trusted', dedupeKey: null, payload: null, prevHash: '', hash: '',
})

describe('outbox', () => {
  it('a retried operationId is enqueued and typed exactly once', async () => {
    const r = rig()
    r.st.status = 'working'
    const first = r.outbox.enqueue(msg('op-1'))
    const retry = r.outbox.enqueue(msg('op-1', { body: 'different body on retry' }))
    expect(first.deduped).toBe(false)
    expect(retry).toMatchObject({ deduped: true, message: { id: first.message.id, body: 'hello op-1' } })
    r.st.status = 'waiting'
    await r.outbox.kick('a1')
    r.outbox.enqueue(msg('op-1'))
    r.st.status = 'waiting'
    await r.outbox.kick('a1')
    expect(r.writes).toEqual(['hello op-1', '\r'])
    expect(r.outbox.list('a1')).toMatchObject([{ status: 'delivered', transport: 'pty' }])
  })

  it('queued while busy (working/blocked), delivered on the idle hook, not on other hooks', async () => {
    const r = rig()
    const bus = createEventBus()
    const off = subscribeOutbox(r.outbox, bus)
    r.st.status = 'working'
    r.outbox.enqueue(msg('busy'))
    await r.outbox.kick('a1')
    r.st.status = 'blocked'
    bus.publish(hook('a1', 'Notification'))
    await r.outbox.kick('a1')
    expect(r.writes).toEqual([])
    expect(r.outbox.list('a1')[0].status).toBe('queued')
    r.st.status = 'waiting'
    bus.publish(hook('a1', 'PostToolUse')) // not an idle edge
    await Promise.resolve()
    expect(r.writes).toEqual([])
    bus.publish(hook('a1', 'Stop'))
    await r.outbox.kick('a1')
    expect(r.writes).toEqual(['hello busy', '\r'])
    off()
  })

  it('a draft in the composer → waits; delivered once the input is empty again', async () => {
    const r = rig()
    r.st.draft = 'half-typed prompt'
    r.outbox.enqueue(msg('d'))
    await r.outbox.kick('a1')
    expect(r.writes).toEqual([])
    r.st.draft = undefined
    await r.outbox.kick('a1')
    expect(r.writes).toEqual(['hello d', '\r'])
  })

  it('batches queued items by priority into one paste + one Enter', async () => {
    const r = rig()
    r.st.status = 'working'
    r.outbox.enqueue(msg('low', { body: 'low' }))
    r.outbox.enqueue(msg('high', { body: 'high', priority: 5 }))
    r.st.status = 'waiting'
    await r.outbox.kick('a1')
    expect(r.writes).toEqual(['\x1b[200~high\n\nlow\x1b[201~', '\r'])
  })

  it('withholds the Enter and marks failed when the text never shows on screen', async () => {
    const r = rig()
    const ob = new OutboxDelivery({
      store: createOutboxStore(r.db), agentOf: () => 'claude', record: () => {},
      sessions: { statusOf: () => undefined, screenSource: () => ({ data: '', seq: 1, cols: 80, rows: 24, pid: 1 }), input: (_i, x) => { r.writes.push(x) } },
      render: async () => box(), sleep: async () => {},
    })
    ob.enqueue(msg('lost'))
    await ob.kick('a1')
    expect(r.writes).toEqual(['hello lost'])
    expect(ob.list('a1')[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('Enter withheld') })
  })

  it('transport: channel > hook (context-only, Claude) > typed PTY', () => {
    expect(chooseTransport('visible', { channel: true, hooks: true })).toBe('channel')
    expect(chooseTransport('context', { channel: false, hooks: true })).toBe('hook')
    expect(chooseTransport('visible', { channel: false, hooks: true })).toBe('pty')
    expect(chooseTransport('context', { channel: false, hooks: false })).toBe('pty')
  })

  it('context-only mail rides the next UserPromptSubmit additionalContext, never typed', async () => {
    const r = rig()
    r.outbox.enqueue(msg('ctx', { kind: 'context', body: 'FYI: CI is green' }))
    await r.outbox.kick('a1')
    expect(r.writes).toEqual([])
    expect(r.outbox.takeHookContext('a1', 'Stop')).toBeNull()
    expect(r.outbox.takeHookContext('a1', 'UserPromptSubmit')).toBe('FYI: CI is green')
    expect(r.outbox.takeHookContext('a1', 'UserPromptSubmit')).toBeNull()
    expect(r.outbox.list('a1')[0]).toMatchObject({ status: 'delivered', transport: 'hook' })
  })

  it('a non-Claude agent: context goes typed, Enter after the fixed gap (no composer to read)', async () => {
    const r = rig('codex')
    r.outbox.enqueue(msg('cx', { kind: 'context', body: 'note' }))
    await r.outbox.kick('a1')
    expect(r.writes).toEqual(['note', '\r'])
  })

  it('never types into a plain shell, nor to a node that no longer exists', async () => {
    const shell = rig(null)
    shell.outbox.enqueue(msg('sh'))
    await shell.outbox.kick('a1')
    expect(shell.writes).toEqual([])
    expect(shell.outbox.list('a1')[0]).toMatchObject({ status: 'failed', error: 'not an agent node' })
    const gone = rig()
    gone.outbox.enqueue(msg('g', { to: 'gone' }))
    await gone.outbox.kick('gone')
    expect(gone.outbox.list('gone')[0]).toMatchObject({ status: 'failed', error: 'node not found' })
  })

  it('a restart keeps queued items and redelivers them', async () => {
    const r = rig()
    r.st.status = 'working'
    r.outbox.enqueue(msg('persist'))
    await r.outbox.kick('a1')
    const reborn = r.make() // new process: same DB, fresh delivery object
    r.st.status = 'waiting'
    expect(reborn.queuedNodes()).toEqual(['a1'])
    await reborn.kickAll()
    expect(r.writes).toEqual(['hello persist', '\r'])
  })

  it('every enqueue/deliver/fail/cancel is recorded as an event, body never in the payload', async () => {
    const r = rig()
    r.outbox.enqueue(msg('e1', { body: 'secret-ish body' }))
    await r.outbox.kick('a1')
    r.st.status = 'working'
    r.outbox.enqueue(msg('e2'))
    r.outbox.cancel('a1', 'e2')
    expect(r.events.map((e) => e.kind)).toEqual(['outbox.enqueue', 'outbox.deliver', 'outbox.enqueue', 'outbox.cancel'])
    expect(r.events[1]).toMatchObject({ source: 'outbox', nodeId: 'a1', subject: 'node:a1', payload: { operationId: 'e1', transport: 'pty' } })
    expect(JSON.stringify(r.events)).not.toContain('secret-ish')
  })
})

describe('outbox route', () => {
  const route = (r: ReturnType<typeof rig>, method: string, body: unknown, q = '') =>
    outboxRoute('/api/outbox', method, new URLSearchParams(q), async () => JSON.stringify(body), async () => r.outbox)

  it('202 queued, 200 on a retried operationId, then the status is visible via GET', async () => {
    const r = rig()
    r.st.status = 'working'
    const a = await route(r, 'POST', { to: 'a1', body: 'notes', operationId: 'diff-notes:a1:n1:1' })
    const b = await route(r, 'POST', { to: 'a1', body: 'notes', operationId: 'diff-notes:a1:n1:1' })
    expect(a?.status).toBe(202)
    expect(b).toMatchObject({ status: 200, body: { deduped: true } })
    expect(await route(r, 'GET', null, 'node=a1')).toMatchObject({ status: 200, body: { messages: [{ status: 'queued', createdBy: 'human-ui' }] } })
  })

  it('rejects bad input at the boundary', async () => {
    const r = rig()
    expect((await route(r, 'POST', { to: '../x', body: 'b', operationId: 'o' }))?.status).toBe(400)
    expect((await route(r, 'POST', { to: 'a1', body: '', operationId: 'o' }))?.status).toBe(400)
    expect((await route(r, 'POST', { to: 'a1', body: 'b', operationId: 'bad op id' }))?.status).toBe(400)
    expect((await route(r, 'POST', { to: 'a1', body: 'b', operationId: 'o', kind: 'loud' }))?.status).toBe(400)
    expect((await route(r, 'POST', { to: 'a1', body: 'b', operationId: 'o', priority: 1.5 }))?.status).toBe(400)
    expect((await route(r, 'POST', { to: 'gone', body: 'b', operationId: 'o' }))?.status).toBe(404)
    expect((await route(r, 'GET', null, 'node=a1&limit=0'))?.status).toBe(400)
    expect(await outboxRoute('/api/other', 'GET', new URLSearchParams(), async () => '')).toBeNull()
  })
})
