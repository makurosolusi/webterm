// Bun-only (bun:sqlite). Senses producers (F1-d) against a real ledger: rows land chained in the
// `event` table with the right kind/trust, and the bus still delivers them to subscribers.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'evprod-')) // test-only data dir, never the user's
process.env.WEBTERM_DATA_DIR = root

const { openLedgerDb } = await import('./ledger/migration')
const { setActiveLedgerRuntime } = await import('./ledger/ledgerRuntimeState')
const { activeEventLog, resetEventsRuntimeForTest } = await import('./events/eventsRuntime')
const { eventBus } = await import('./events/eventBus')
const { produceHookEvent, producePtyExit } = await import('./events/producers')
const { produceEdgeChange } = await import('./events/producers.edge')

afterAll(() => {
  resetEventsRuntimeForTest()
  setActiveLedgerRuntime(null)
  rmSync(root, { recursive: true, force: true })
})

test('producers append chained rows with kind/trust, and publish them', () => {
  const db = openLedgerDb(':memory:')
  setActiveLedgerRuntime({ db } as never)
  const seen: string[] = []
  const off = eventBus.subscribe('*', (e) => { seen.push(`${e.kind}#${e.seq}`) })

  produceHookEvent({ nodeId: 'a1', status: 'waiting', verified: true, body: { hook_event_name: 'Stop' } })
  producePtyExit({ nodeId: 'a1', code: 1, reason: 'self', durationMs: 5 })
  const ws = (bridges: unknown[]) => ({
    id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0, bridges,
    nodes: [{ id: 'a1', kind: 'agent', agentId: 'claude', title: 'Claude' }, { id: 'web1', kind: 'browser', title: 'B' }],
  }) as never
  produceEdgeChange(ws([]), ws([{ id: 'b', source: 'a1', target: 'web1', kind: 'context' }]))
  off()

  const rows = activeEventLog()!.list()
  expect(rows.map((r) => [r.kind, r.trust, r.source])).toEqual([
    ['hook.Stop', 'trusted', 'agentStatusApi'],
    ['pty.exit', 'trusted', 'pty'],
    ['edge.change', 'trusted', 'workspacesApi'],
  ])
  expect(rows.every((r) => r.seq > 0 && r.hash.length === 64)).toBe(true)
  expect(activeEventLog()!.verifyChain().ok).toBe(true)
  expect(seen).toEqual(rows.map((r) => `${r.kind}#${r.seq}`))
})
