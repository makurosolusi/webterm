// Bun-only: channels.json -> ledger `channel_store` (F2-g). One idempotent import with a backup,
// then the ledger row is the only store, across restarts. Also: /status counts == world view.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { openDb } from '../db'
import { openLedgerDb } from '../ledger/migration'
import { worldCounts } from '../worldView'
import { ChannelStore, ChannelStoreError } from './channelStore'
import { STORE_IMPORT_BACKUP_SUFFIX, ledgerPersistence } from './channelStoreLedger'
import { runCommand } from './channelCommands'
import { renderWorldLine } from './channelWorld'

const root = mkdtempSync(join(tmpdir(), 'chstore-ledger-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const close = (db: Database): void => (db as unknown as { close(): void }).close()
let n = 0
function fresh(): { ledger: string; json: string } {
  const dir = join(root, String(++n))
  mkdirSync(join(dir, 'channels'), { recursive: true })
  return { ledger: join(dir, 'ledger.db'), json: join(dir, 'channels', 'channels.json') }
}
const V2 = {
  version: 2,
  accounts: {},
  bindings: { 'telegram:default:42': { projectId: 'p1', role: 'owner', userId: '7' } },
  processed: { 'telegram:default:55': Date.now() },
  cursor: 55,
  outbox: [{ key: 'k1', channel: 'telegram', chatId: '42', text: 'queued', createdAt: 1, attempts: 0, nextAt: 1, state: 'pending' }],
}
const rowCount = (db: Database): number => Number((db.query('SELECT COUNT(*) AS n FROM channel_store').get() as { n: number }).n)

test('imports channels.json once, keeps a backup, then survives restarts from the ledger only', () => {
  const p = fresh()
  writeFileSync(p.json, JSON.stringify(V2))
  const original = readFileSync(p.json, 'utf8')
  let db = openLedgerDb(p.ledger)
  const store = new ChannelStore(ledgerPersistence(db, p.json))
  expect(store.binding('telegram', '42')).toEqual({ projectId: 'p1', role: 'owner', userId: '7' })
  expect(store.claimUpdate(55)).toBe(false) // dedupe record imported
  expect(store.pendingReplies().map((r) => r.key)).toEqual(['k1'])
  expect(existsSync(p.json)).toBe(false)
  expect(readFileSync(`${p.json}${STORE_IMPORT_BACKUP_SUFFIX}`, 'utf8')).toBe(original)
  expect((db.query('SELECT imported_from FROM channel_store').get() as { imported_from: string }).imported_from).toBe(p.json)
  store.bind('telegram', '43', { projectId: 'p2', role: 'viewer' })
  close(db)

  // Restart: a stale channels.json reappearing must not be re-imported over the ledger row.
  writeFileSync(p.json, JSON.stringify({ ...V2, bindings: {} }))
  db = openLedgerDb(p.ledger)
  const again = new ChannelStore(ledgerPersistence(db, p.json))
  expect(again.binding('telegram', '42')?.projectId).toBe('p1')
  expect(again.binding('telegram', '43')?.projectId).toBe('p2')
  expect(rowCount(db)).toBe(1)
  expect(existsSync(p.json)).toBe(true) // ignored, untouched
  again.setForwardAwayMinutes(7)
  close(db)
  db = openLedgerDb(p.ledger)
  expect(new ChannelStore(ledgerPersistence(db, p.json)).forwardAwayMinutes).toBe(7)
  close(db)
})

test('no legacy file: starts empty, writes only the ledger', () => {
  const p = fresh()
  const db = openLedgerDb(p.ledger)
  const store = new ChannelStore(ledgerPersistence(db, p.json))
  expect(store.forwardAwayMinutes).toBe(3)
  expect(rowCount(db)).toBe(0)
  store.bind('telegram', '1', { projectId: 'p', role: 'owner' })
  expect(rowCount(db)).toBe(1)
  expect(existsSync(p.json)).toBe(false)
  close(db)
})

test('a v1 file is migrated and imported; a corrupt file fails closed and is never imported', () => {
  const p = fresh()
  const db = openLedgerDb(p.ledger)
  writeFileSync(p.json, JSON.stringify({ version: 1, bindings: { 'telegram:9': { projectId: 'p', role: 'owner' } }, processed: {}, cursor: 0, outbox: [] }))
  expect(new ChannelStore(ledgerPersistence(db, p.json)).binding('telegram', '9')?.projectId).toBe('p')
  expect(existsSync(`${p.json}${STORE_IMPORT_BACKUP_SUFFIX}`)).toBe(true)
  close(db)

  const q = fresh()
  const db2 = openLedgerDb(q.ledger)
  writeFileSync(q.json, '{"version": 2, "bindings": ')
  let thrown: unknown = null
  try {
    new ChannelStore(ledgerPersistence(db2, q.json))
  } catch (err) {
    thrown = err
  }
  expect(thrown instanceof ChannelStoreError && thrown.code === 'corrupt').toBe(true)
  expect(rowCount(db2)).toBe(0)
  expect(readFileSync(q.json, 'utf8')).toBe('{"version": 2, "bindings": ')
  close(db2)
})

test('/status counts equal the world view (same numbers as the canvas)', async () => {
  const dir = join(root, 'world')
  mkdirSync(dir, { recursive: true })
  const paths = { webterm: join(dir, 'webterm.db'), ledger: join(dir, 'ledger.db') }
  const w = openDb(paths.webterm)
  const ins = w.query('INSERT INTO workspace (id, name, nodes, updated_at) VALUES (?, ?, ?, 1)')
  ins.run('ws-a', 'A', JSON.stringify([{ id: 'n1', kind: 'terminal', agentId: 'claude' }, { id: 'n2', kind: 'terminal', agentId: 'codex' }]))
  ins.run('ws-b', 'B', '[]')
  close(w)
  const l = openLedgerDb(paths.ledger)
  l.query("INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('ws-a', 'ws-a', 'A', '/a', 1, 1)").run()
  const task = l.query('INSERT INTO task (id, project_id, spec, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
  task.run('t1', 'ws-a', 's', 'pending')
  task.run('t2', 'ws-a', 's', 'verified')
  close(l)

  const counts = worldCounts(paths)
  const text = await runCommand(
    { world: () => worldCounts(paths), approval: { listApprovals: () => [], getApproval: () => null, decideApproval: () => undefined, consumeApproval: () => false } },
    { updateId: 1, chatId: '1', userId: '7', isGroup: false, text: '/status' },
    { projectId: 'ws-a', role: 'owner' },
    { kind: 'status' }
  )
  expect(text.split('\n')[0]).toBe(renderWorldLine(counts))
  expect(text.split('\n')[0]).toBe('Canvas: 2 projects, 2 agents, 1 open of 2 tasks.')
  expect(counts.workspaces).toBe(2)
  expect(counts.agentNodes).toBe(2)
})

test('the channel runtime uses the ledger row by default, importing <dataDir>/channels/channels.json', async () => {
  const { startChannelsRuntime } = await import('./channelsRuntime')
  const { harnessLedger } = await import('./channelsRuntimeHarness')
  const dir = join(root, 'runtime')
  mkdirSync(join(dir, 'channels'), { recursive: true })
  writeFileSync(join(dir, 'channels', 'channels.json'), JSON.stringify(V2))
  const before = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = dir // test-only: never touch the real data dir
  const db = openLedgerDb(join(dir, 'ledger.db'))
  try {
    const runtime = startChannelsRuntime(harnessLedger(), {
      env: { WEBTERM_TELEGRAM: 'on' } as NodeJS.ProcessEnv,
      ledgerDb: db,
      sender: { intervalMs: 60_000 },
      subscribe: () => () => {},
    })
    expect(runtime?.store.storePath).toBe('ledger:channel_store')
    expect(runtime?.store.binding('telegram', '42')?.projectId).toBe('p1')
    expect(existsSync(join(dir, 'channels', `channels.json${STORE_IMPORT_BACKUP_SUFFIX}`))).toBe(true)
    runtime?.stop()
  } finally {
    if (before === undefined) delete process.env.WEBTERM_DATA_DIR
    else process.env.WEBTERM_DATA_DIR = before
    close(db)
  }
})
