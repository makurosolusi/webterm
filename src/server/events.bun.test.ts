// Bun-only (bun:sqlite). Senses event log (src/server/events/): hash chain, append-only triggers,
// dedupe, pub/sub, anchor, SSE + auth tier, and schema v10 on an existing v9 ledger file.
// Lives at src/server/ (not events/) so the `src/server/*.bun.test.ts` gate runs it.
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateWithBackup, openLedgerDb } from './ledger/migration'
import { MIGRATIONS } from './ledger/ledgerSchema'
import { applyV10 } from './ledger/ledgerSchemaV10'
import { createEventLog } from './events/eventLog'
import { createEventBus, eventBus } from './events/eventBus'
import { GENESIS_HASH, canonicalJson, chainHash, type HashedColumns } from './events/eventModel'
import { anchorStatus, readAnchor, writeAnchor } from './events/eventAnchor'
import { startEventsRuntime } from './events/eventsRuntime'
import { eventsRoute } from './events/eventsApi'
import { authorizeRequest, isNodeTokenPath } from './auth'
import { createLedger } from './ledger/ledger'
import { listEvents } from './ledger/ledgerEvent'

type Row = Record<string, unknown>
const q = (db: Database, sql: string) => db.query(sql) as unknown as { all(...p: unknown[]): Row[]; get(...p: unknown[]): Row | null; run(...p: unknown[]): unknown }
const close = (db: Database): void => (db as unknown as { close(): void }).close()
const count = (db: Database, sql: string): number => Number(q(db, sql).get()?.['c'])
function throwsWith(fn: () => unknown): string {
  try { fn() } catch (err) { return err instanceof Error ? err.message : String(err) }
  return ''
}

const root = mkdtempSync(join(tmpdir(), 'events-')) // test-only temp dir, never the user's data dir
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const tmp = (name: string): string => join(root, `${n++}-${name}`)

function fixture(now = { t: 1000 }) {
  const db = openLedgerDb(':memory:')
  const bus = createEventBus()
  const log = createEventLog(db, { now: () => now.t, bus })
  return { db, bus, log, now }
}
const ev = (kind: string, payload?: unknown) => ({ kind, source: 'test', trust: 'trusted' as const, payload })

/** What a same-uid attacker does: drop the triggers, edit, and optionally recompute hashes. */
function tamper(db: Database, sql: string): void {
  db.exec('DROP TRIGGER event_chain_no_update; DROP TRIGGER event_chain_no_delete;')
  db.exec(sql)
}
function recomputeChain(db: Database): void {
  let prev = GENESIS_HASH
  for (const row of q(db, 'SELECT * FROM event WHERE hash IS NOT NULL ORDER BY seq').all()) {
    const c: HashedColumns = {
      prev_hash: prev, ts: Number(row['ts']), kind: String(row['kind']), source: String(row['source']), actor: String(row['actor']),
      subject: (row['subject'] as string | null) ?? null, workspace_id: (row['workspace_id'] as string | null) ?? null,
      node_id: (row['node_id'] as string | null) ?? null, trust: String(row['trust']), dedupe_key: (row['dedupe_key'] as string | null) ?? null,
      payload_json: (row['payload_json'] as string | null) ?? null,
    }
    prev = chainHash(c)
    q(db, 'UPDATE event SET prev_hash = ?, hash = ? WHERE seq = ?').run(c.prev_hash, prev, row['seq'])
  }
}

test('canonicalJson sorts keys recursively and rejects non-JSON values', () => {
  expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' }, u: undefined })).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}')
  expect(throwsWith(() => canonicalJson({ x: Number.NaN }))).toContain('non-finite')
  expect(throwsWith(() => canonicalJson(() => 1))).toContain('unsupported')
})

test('append links each row to the previous hash and verifyChain passes', () => {
  const { db, log } = fixture()
  const a = log.append(ev('hook.SessionStart', { node: 'n1' })).event
  const b = log.append({ ...ev('pty.exit', { code: 0 }), actor: 'node:n1', nodeId: 'n1', workspaceId: 'w1', subject: 'node:n1' }).event
  const c = log.append({ ...ev('fs.change'), trust: 'untrusted' }).event
  expect(a.prevHash).toBe(GENESIS_HASH)
  expect(b.prevHash).toBe(a.hash)
  expect(c.prevHash).toBe(b.hash)
  expect(b).toMatchObject({ kind: 'pty.exit', actor: 'node:n1', nodeId: 'n1', workspaceId: 'w1', payload: { code: 0 } })
  expect(c.trust).toBe('untrusted')
  expect(log.verifyChain()).toEqual({ ok: true, checked: 3, head: { seq: c.seq, hash: c.hash } })
  expect(log.head()).toEqual({ seq: c.seq, hash: c.hash })
  expect(log.list(a.seq).map((e) => e.seq)).toEqual([b.seq, c.seq])
  for (const bad of [{ ...ev('NoDot') }, { ...ev('a.b'), source: '' }, { ...ev('a.b'), trust: 'maybe' }, ev('a.b', { x: 'y'.repeat(70_000) })]) {
    expect(throwsWith(() => log.append(bad as never))).toContain('appendEvent')
  }
  close(db)
})

test('verifyChain reports the first edited, deleted, or recomputed row', () => {
  const edited = fixture()
  const rows = [1, 2, 3].map((i) => edited.log.append(ev('test.row', { i })).event)
  tamper(edited.db, `UPDATE event SET payload_json = '{"i":99}' WHERE seq = ${rows[1]!.seq}`)
  expect(edited.log.verifyChain()).toMatchObject({ ok: false, checked: 1, brokenAt: { seq: rows[1]!.seq, reason: 'hash_mismatch' } })

  const deleted = fixture()
  const d = [1, 2, 3].map((i) => deleted.log.append(ev('test.row', { i })).event)
  tamper(deleted.db, `DELETE FROM event WHERE seq = ${d[1]!.seq}`)
  expect(deleted.log.verifyChain()).toMatchObject({ ok: false, brokenAt: { seq: d[2]!.seq, reason: 'prev_hash_mismatch' } })

  // A full recompute fools verifyChain; only the anchor catches it.
  const rewritten = fixture()
  const r = [1, 2].map((i) => rewritten.log.append(ev('test.row', { i })).event)
  const anchor = { seq: r[1]!.seq, hash: r[1]!.hash, at: 1 }
  tamper(rewritten.db, `UPDATE event SET payload_json = '{"i":7}' WHERE seq = ${r[0]!.seq}`)
  recomputeChain(rewritten.db)
  expect(rewritten.log.verifyChain().ok).toBe(true)
  expect(anchorStatus(anchor, (s) => rewritten.log.hashAt(s))).toBe('rewritten')
  rewritten.db.exec(`DELETE FROM event WHERE seq = ${r[1]!.seq}`)
  expect(anchorStatus(anchor, (s) => rewritten.log.hashAt(s))).toBe('truncated')
  for (const f of [edited, deleted, rewritten]) close(f.db)
})

test('UPDATE/DELETE of chained rows is blocked; legacy project rows still cascade', () => {
  const { db, log } = fixture()
  const e = log.append(ev('test.row')).event
  expect(throwsWith(() => q(db, `UPDATE event SET kind = 'x.y' WHERE seq = ${e.seq}`).run())).toContain('append-only')
  expect(throwsWith(() => q(db, `DELETE FROM event WHERE seq = ${e.seq}`).run())).toContain('append-only')
  expect(throwsWith(() => q(db, 'UPDATE event SET hash = NULL').run())).toContain('append-only')
  q(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','n','/p',1,1)").run()
  expect(throwsWith(() => q(db, `INSERT INTO event (ts, project_id, actor, kind, prev_hash, hash) VALUES (1,'p1','a','x.y','${GENESIS_HASH}','${GENESIS_HASH}')`).run())).toContain('must not reference')
  q(db, "INSERT INTO event (ts, project_id, actor, kind) VALUES (1,'p1','legacy','seed')").run()
  q(db, "DELETE FROM project WHERE id = 'p1'").run()
  expect(count(db, 'SELECT count(*) AS c FROM event')).toBe(1)
  expect(log.verifyChain().ok).toBe(true)
  close(db)
})

test('dedupe_key returns the earlier row inside the window and appends after it', () => {
  const { db, bus, log, now } = fixture()
  const seen: number[] = []
  bus.subscribe('*', (e) => seen.push(e.seq))
  const first = log.append({ ...ev('hook.Stop'), dedupeKey: 'stop:n1' })
  now.t += 59_999
  const again = log.append({ ...ev('hook.Stop'), dedupeKey: 'stop:n1' })
  expect(again).toEqual({ event: first.event, deduped: true })
  now.t += 2
  const later = log.append({ ...ev('hook.Stop'), dedupeKey: 'stop:n1' })
  expect(later.deduped).toBe(false)
  expect(seen).toEqual([first.event.seq, later.event.seq])
  expect(count(db, 'SELECT count(*) AS c FROM event')).toBe(2)
  close(db)
})

test('subscribe filters by kind pattern, isolates a throwing subscriber, and unsubscribes', () => {
  const { db, bus, log } = fixture()
  const hooks: string[] = []
  const exact: string[] = []
  const off = bus.subscribe('hook.*', (e) => hooks.push(e.kind))
  bus.subscribe('pty.exit', (e) => exact.push(e.kind))
  bus.subscribe('*', () => { throw new Error('boom') })
  expect(throwsWith(() => bus.subscribe('bad pattern', () => {}))).toContain('invalid kind pattern')
  log.append(ev('hook.PreToolUse'))
  log.append(ev('pty.exit'))
  expect(bus.subscriberCount).toBe(2)
  off()
  log.append(ev('hook.Stop'))
  expect(hooks).toEqual(['hook.PreToolUse'])
  expect(exact).toEqual(['pty.exit'])
  close(db)
})

test('anchor: written on start and append, divergence preserved on restart', () => {
  const db = openLedgerDb(':memory:')
  const file = tmp('anchor.json')
  const rt = startEventsRuntime(db, file, () => 5)
  expect(rt.startStatus).toBe('no_anchor')
  expect(existsSync(file)).toBe(false) // empty chain: nothing to anchor yet
  const e = rt.log.append(ev('test.row')).event
  rt.flushAnchor()
  expect(readAnchor(file)).toEqual({ seq: e.seq, hash: e.hash, at: 5 })
  rt.stop()
  expect(startEventsRuntime(db, file).startStatus).toBe('match')

  writeAnchor(file, { seq: e.seq, hash: 'f'.repeat(64), at: 1 })
  const restarted = startEventsRuntime(db, file, () => 9)
  expect(restarted.startStatus).toBe('rewritten')
  expect(restarted.divergedAnchorFile).toBe(`${file}.diverged-9`)
  expect(readAnchor(`${file}.diverged-9`)?.hash).toBe('f'.repeat(64))
  expect(readAnchor(file)?.hash).toBe(e.hash) // anchoring resumed from the current head
  writeFileSync(file, 'garbage')
  expect(startEventsRuntime(db, file, () => 10).startStatus).toBe('unreadable')
  close(db)
})

test('SSE replays from afterSeq, streams live by kind, releases on disconnect; head API reports anchor', async () => {
  const db = openLedgerDb(':memory:')
  const rt = startEventsRuntime(db, tmp('anchor.json'))
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    if (!eventsRoute(req, res, url, req.method || 'GET', () => rt)) { res.statusCode = 404; res.end() }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const waitFor = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)) }
  const open = (path: string) => new Promise<{ req: http.ClientRequest; res: http.IncomingMessage; text: () => string }>((resolve) => {
    const req = http.get(base + path, (res) => { let buf = ''; res.on('data', (c) => { buf += c }); resolve({ req, res, text: () => buf }) })
  })
  try {
    const old = rt.log.append(ev('hook.SessionStart')).event
    const replayed = rt.log.append(ev('hook.PreToolUse')).event
    rt.log.append(ev('pty.exit'))
    const baseline = eventBus.subscriberCount
    const s = await open(`/api/events/stream?kind=hook.*&afterSeq=${old.seq}`)
    expect(s.res.headers['content-type']).toBe('text/event-stream')
    await waitFor(() => s.text().includes('hook.PreToolUse'))
    expect(s.text()).toContain(`id: ${replayed.seq}\nevent: sense\n`)
    expect(s.text()).not.toContain('hook.SessionStart')
    expect(s.text()).not.toContain('pty.exit')
    rt.log.append(ev('pty.exit'))
    const live = rt.log.append(ev('hook.Stop')).event
    await waitFor(() => s.text().includes('hook.Stop'))
    expect(s.text()).toContain(`id: ${live.seq}\n`)
    expect(eventBus.subscriberCount).toBe(baseline + 1)
    s.req.destroy()
    await waitFor(() => eventBus.subscriberCount === baseline)
    expect(eventBus.subscriberCount).toBe(baseline)

    // Backpressure: a reader that never drains is cut off and its subscriber released.
    const stalled = await open('/api/events/stream')
    stalled.res.pause()
    for (let i = 0; i < 60; i++) rt.log.append(ev('test.big', { blob: 'x'.repeat(60_000), i }))
    await waitFor(() => eventBus.subscriberCount === baseline)
    expect(eventBus.subscriberCount).toBe(baseline)
    stalled.req.destroy()

    for (const bad of ['/api/events/stream?afterSeq=x', '/api/events/stream?kind=a%20b']) expect((await fetch(base + bad)).status).toBe(400)
    expect((await fetch(`${base}/api/events/head`, { method: 'POST' })).status).toBe(405)
    rt.flushAnchor()
    const head = await (await fetch(`${base}/api/events/head?verify=1`)).json()
    expect(head).toMatchObject({ head: rt.log.head(), anchorStatus: 'match', verify: { ok: true } })
  } finally {
    server.closeAllConnections()
    server.close()
    rt.stop()
    close(db)
  }
})

test('events endpoints refuse a per-node token (root / same-origin UI only)', () => {
  const gate = (pathname: string, token: string) => authorizeRequest({
    headers: {}, expectedToken: 'root-token-synthetic', queryToken: token, pathname, isNodeToken: (t) => t === 'node-token', // test-only tokens
  })
  for (const p of ['/api/events/stream', '/api/events/head']) {
    expect(isNodeTokenPath(p)).toBe(false)
    expect(gate(p, 'node-token')).toBe(false)
    expect(gate(p, 'root-token-synthetic')).toBe(true)
  }
  expect(eventsRoute({} as never, { setHeader() {}, end() {} } as never, new URL('http://x/api/events/head'), 'GET', () => null)).toBe(true)
})

test('v10 migrates an existing v9 ledger file idempotently and keeps legacy rows', () => {
  const path = tmp('ledger.sqlite')
  const db = new Database(path)
  db.exec('PRAGMA foreign_keys = ON')
  expect(migrateWithBackup(db, path, MIGRATIONS.filter((m) => m.version <= 9))).toBe(9)
  q(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','n','/p',1,1)").run()
  q(db, "INSERT INTO event (ts, project_id, actor, kind, payload_json) VALUES (1,'p1','legacy','seed','{}')").run()
  expect(migrateWithBackup(db, path)).toBe(11)
  expect(readdirSync(root).some((f) => f.endsWith('.v9.bak'))).toBe(true)
  applyV10(db) // re-running the step is a no-op
  applyV10(db)
  const cols = q(db, 'PRAGMA table_info(event)').all().map((r) => String(r['name']))
  for (const c of ['source', 'subject', 'workspace_id', 'node_id', 'trust', 'dedupe_key', 'prev_hash', 'hash']) expect(cols).toContain(c)
  expect(count(db, "SELECT count(*) AS c FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'event_chain_%'")).toBe(3)
  expect(q(db, 'SELECT actor, hash FROM event').get()).toEqual({ actor: 'legacy', hash: null })
  expect(throwsWith(() => q(db, "INSERT INTO event (ts, actor, kind, trust) VALUES (1,'a','x.y','maybe')").run())).toContain('CHECK')
  const log = createEventLog(db)
  log.append(ev('test.row'))
  expect(log.verifyChain()).toMatchObject({ ok: true, checked: 1 })
  q(db, "DELETE FROM project WHERE id = 'p1'").run() // legacy cascade unaffected
  expect(count(db, 'SELECT count(*) AS c FROM event')).toBe(1)
  close(db)
  const reopened = openLedgerDb(path)
  expect(Number(q(reopened, 'PRAGMA user_version').get()?.['user_version'])).toBe(11)
  close(reopened)
})

test('ledger listEvents excludes Senses rows unless includeSenses is set', () => {
  const { db, log } = fixture()
  const ledger = createLedger(db, { now: () => 1 })
  const audit = ledger.event.appendEvent({ actor: 'human', kind: 'task.created' })
  const sense = log.append(ev('hook.Stop')).event
  expect(ledger.event.listEvents().map((e) => e.seq)).toEqual([audit.seq])
  expect(listEvents({ db, now: () => 1 }, { includeSenses: true }).map((e) => e.seq)).toEqual([audit.seq, sense.seq])
  close(db)
})
