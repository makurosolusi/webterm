import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../../ledger/migration'
import { HEALTH_AUTO_SCAN_INTERVAL_MS, createHealthService, healthServiceFor } from './healthService'
import { createHealthStore } from './healthStore'
import type { ScanResult } from './healthScan'

const T0 = 1_800_000_000_000 // test-only fixed clock
const EMPTY: ScanResult = { drafts: [], rules: ['file_size'], filesScanned: 2, truncated: false }

function setup(paths: Record<string, string | null>) {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  for (const id of Object.keys(paths)) db.query(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES (?, ?, ?, '/x', 0, 0)`).run(id, id, id)
  const clock = { t: T0 }
  const now = () => clock.t
  const store = createHealthStore(db, now)
  const calls: string[] = []
  let release: (() => void) | null = null
  const scan = async (cwd: string): Promise<ScanResult> => {
    calls.push(cwd)
    if (cwd.endsWith('boom')) throw new Error('git exploded')
    if (cwd.endsWith('slow')) await new Promise<void>((r) => { release = r })
    return EMPTY
  }
  const service = createHealthService({ db, now, store, cwdOf: (id) => paths[id] ?? null, scan })
  return { db, clock, store, service, calls, release: () => release?.() }
}

const dir = (name: string): string => { const d = join(mkdtempSync(join(tmpdir(), 'wt-health-svc-')), name); mkdirSync(d); return d }

test('a scan finishes and records its counts', async () => {
  const r = setup({ p: '/repo' })
  expect(await r.service.runScan('p')).toMatchObject({ status: 'done', filesScanned: 2, origin: 'scan' })
  expect(r.calls).toEqual(['/repo'])
  expect(r.service.running('p')).toBe(false)
})

test('a second call while running joins the running scan', async () => {
  const r = setup({ p: '/slow' })
  const a = r.service.runScan('p')
  const b = r.service.runScan('p')
  expect(r.service.running('p')).toBe(true)
  expect(r.store.latestScan('p')?.status).toBe('running')
  r.release()
  expect(await a).toEqual(await b)
  expect(r.calls.length).toBe(1)
  expect(r.service.running('p')).toBe(false)
})

test('a missing repo folder or a throwing scanner fails the scan instead of rejecting', async () => {
  const r = setup({ none: null, bad: '/boom' })
  expect(await r.service.runScan('none')).toMatchObject({ status: 'failed', error: 'project none has no repository folder to scan' })
  expect(await r.service.runScan('bad')).toMatchObject({ status: 'failed', error: 'scan failed: git exploded' })
})

test('an unknown project throws synchronously', () => {
  const r = setup({})
  let error = ''
  try { void r.service.runScan('ghost') } catch (err) { error = err instanceof Error ? err.name : String(err) }
  expect(error).toBe('HealthStoreError')
})

test('auto-scan takes one due project per call, oldest first, then waits a day', async () => {
  const a = dir('a'), b = dir('b')
  const r = setup({ a, b, gone: '/does/not/exist', none: null })
  await r.service.autoScanDue(T0)
  await r.service.autoScanDue(T0)
  expect(r.calls).toEqual([a, b])
  await r.service.autoScanDue(T0 + 1000)
  expect(r.calls.length).toBe(2)
  r.clock.t = T0 + HEALTH_AUTO_SCAN_INTERVAL_MS
  await r.service.autoScanDue(r.clock.t)
  expect(r.calls).toEqual([a, b, a])
})

test('auto-scan starts nothing while a scan runs and never throws', async () => {
  const slow = dir('slow')
  const r = setup({ s: slow, t: slow })
  const running = r.service.runScan('s')
  await r.service.autoScanDue(T0)
  expect(r.calls).toEqual([slow])
  r.release()
  await running
  const broken = createHealthService({ db: r.db, now: () => T0, store: r.store, cwdOf: () => { throw new Error('lookup down') } })
  await broken.autoScanDue(T0) // logged, not thrown
})

test('healthServiceFor shares one instance per db', () => {
  const db = new Database(':memory:')
  migrate(db)
  expect(healthServiceFor(db, () => T0)).toBe(healthServiceFor(db, () => T0))
})
