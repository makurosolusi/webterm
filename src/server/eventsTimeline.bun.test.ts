// GET /api/events/history: newest page first, walking back with beforeSeq, skipping legacy
// (hash NULL) ledger rows, root-only like the rest of /api/events.
import { expect, test } from 'bun:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { openLedgerDb } from './ledger/migration'
import { createEventLog } from './events/eventLog'
import { createEventBus } from './events/eventBus'
import { historyPage, timelineRoute } from './events/timelineApi'
import { isNodeTokenPath } from './auth'

const ev = (kind: string) => ({ kind, source: 'test', trust: 'trusted' as const })

test('historyPage walks back in pages and ignores unchained rows', () => {
  const db = openLedgerDb(':memory:')
  const log = createEventLog(db, { bus: createEventBus() })
  for (let i = 1; i <= 5; i++) {
    log.append(ev(`test.e${i}`))
    // Legacy ledger audit row in between: no hash, must never surface or shrink a page.
    db.exec(`INSERT INTO event (ts, kind, actor, payload_json) VALUES (${i}, 'legacy', 'test', NULL)`)
  }
  const first = historyPage({ db, log }, undefined, 2)
  expect(first.events.map((e) => e.kind)).toEqual(['test.e4', 'test.e5'])
  expect(first.more).toBe(true)
  const second = historyPage({ db, log }, first.events[0]!.seq, 2)
  expect(second.events.map((e) => e.kind)).toEqual(['test.e2', 'test.e3'])
  const last = historyPage({ db, log }, second.events[0]!.seq, 2)
  expect(last).toMatchObject({ more: false })
  expect(last.events.map((e) => e.kind)).toEqual(['test.e1'])
  expect(historyPage({ db, log }, last.events[0]!.seq, 2)).toEqual({ events: [], more: false })
})

test('route validates the page, answers 503 with no ledger, and is not a node-token path', async () => {
  const db = openLedgerDb(':memory:')
  const log = createEventLog(db, { bus: createEventBus() })
  log.append(ev('hook.Stop'))
  let deps: { db: typeof db; log: typeof log } | null = { db, log }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    if (!timelineRoute(req, res, url, req.method || 'GET', () => deps)) { res.statusCode = 404; res.end() }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events/history`
  try {
    const ok = await (await fetch(`${base}?limit=10`)).json()
    expect(ok).toMatchObject({ more: false, events: [{ kind: 'hook.Stop' }] })
    for (const bad of ['?beforeSeq=x', '?limit=0', '?limit=-1']) expect((await fetch(base + bad)).status).toBe(400)
    expect((await fetch(base, { method: 'POST' })).status).toBe(405)
    deps = null
    expect((await fetch(base)).status).toBe(503)
    expect(isNodeTokenPath('/api/events/history')).toBe(false)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
