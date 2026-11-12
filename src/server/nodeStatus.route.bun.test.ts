// Bun-only: an in-memory ledger (no data dir, no ~/.webterm-server) and fake sessions.
import { describe, expect, it } from 'bun:test'
import { openLedgerDb } from './ledger/migration'
import { insertCostUsage } from './cost/costStore'
import { createOutboxStore } from './outbox/outboxStore'
import { NODE_STATUS_MAX_IDS } from '../shared/nodeStatusBar'
import { contextPercent, nodeStatusRoute, type NodeStatusSessions } from './nodeStatus.route'

const T0 = 1_700_000_000_000
const sessions: NodeStatusSessions = {
  ptyInfoOf: (id) => (id === 'live' ? { pid: 4242, startedAt: T0, cols: 80, rows: 24 } : undefined),
  statusEntryOf: (id) => (id === 'live' ? { status: 'working', updatedAt: T0 + 50, since: T0 + 10 } : undefined),
  getExit: (id) => (id === 'dead' ? { code: 137, reason: 'self', at: T0 + 99 } : undefined),
}
const get = (ids: string, db = openLedgerDb(':memory:')) =>
  nodeStatusRoute('/api/node-status', 'GET', new URLSearchParams({ ids }), { sessions: () => sessions, db: () => db })
const row = (o: Partial<Parameters<typeof insertCostUsage>[1]>) => ({
  key: 'k', ts: T0, source: 'agent' as const, workspaceId: 'w', nodeId: 'live', sessionId: 's1', model: 'claude-x',
  input: 0, output: 10, cacheRead: 0, write5m: 0, write1h: 0, costMicros: 0, ...o,
})

describe('GET /api/node-status', () => {
  it('reports pty, hook clocks, current-session cost/context and outbox counts', async () => {
    const db = openLedgerDb(':memory:')
    insertCostUsage(db, row({ key: 'old', ts: T0, sessionId: 's0', costMicros: 9_000_000 }))
    insertCostUsage(db, row({ key: 'a', ts: T0 + 1, costMicros: 250_000 }))
    insertCostUsage(db, row({ key: 'b', ts: T0 + 2, input: 10, cacheRead: 99_990, costMicros: 500_000 }))
    let clock = T0
    const outbox = createOutboxStore(db, () => clock)
    const one = outbox.enqueue({ to: 'live', body: 'secret prompt', kind: 'visible', operationId: 'op1', createdBy: 'test' }).message
    clock = T0 + 5
    outbox.enqueue({ to: 'live', body: 'x', kind: 'visible', operationId: 'op2', createdBy: 'test' })
    clock = T0 + 7
    outbox.markFailed([one.id], 'pty', 'boom')
    const res = await get('live,dead', db)
    expect(res?.status).toBe(200)
    const { nodes } = res!.body as { nodes: Record<string, Record<string, unknown>> }
    expect(nodes.live).toEqual({
      live: true, pid: 4242, startedAt: T0, status: 'working', lastHookAt: T0 + 50, statusSince: T0 + 10,
      model: 'claude-x', contextPct: 50, costUsd: 0.75,
      outbox: { queued: 1, oldestQueuedAt: T0 + 5, lastFailedAt: T0 + 7 },
    })
    expect(nodes.dead).toEqual({ live: false, exit: { code: 137, reason: 'self', at: T0 + 99 }, outbox: { queued: 0 } })
    expect(JSON.stringify(res!.body)).not.toContain('secret prompt')
  })

  it('without a ledger it still answers the PTY facts', async () => {
    const res = await nodeStatusRoute('/api/node-status', 'GET', new URLSearchParams({ ids: 'live' }), { sessions: () => sessions, db: () => null })
    expect((res!.body as { nodes: Record<string, unknown> }).nodes.live).toEqual({
      live: true, pid: 4242, startedAt: T0, status: 'working', lastHookAt: T0 + 50, statusSince: T0 + 10,
    })
  })

  it('refuses unsafe, empty or too many ids, and other methods', async () => {
    expect((await get(''))?.status).toBe(400)
    expect((await get('a b'))?.status).toBe(400)
    expect((await get(Array.from({ length: NODE_STATUS_MAX_IDS + 1 }, (_, i) => `n${i}`).join(',')))?.status).toBe(400)
    expect((await nodeStatusRoute('/api/node-status', 'POST', new URLSearchParams(), { sessions: () => sessions, db: () => null }))?.status).toBe(405)
    expect(await nodeStatusRoute('/api/other', 'GET', new URLSearchParams(), { sessions: () => sessions, db: () => null })).toBeNull()
  })

  it('takes the window from the model id, and the long one once a response read past 200K', () => {
    expect(contextPercent(180_000, 'claude-opus-4-7')).toBe(90)
    expect(contextPercent(180_000, 'sonnet[1m]')).toBe(18)
    expect(contextPercent(500_000, 'claude-opus-4-7')).toBe(50)
  })
})
