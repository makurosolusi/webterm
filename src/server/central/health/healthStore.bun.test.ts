import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { FindingDraft, HealthRule } from '../../../shared/centralHealth'
import { migrate } from '../../ledger/migration'
import { HEALTH_PAGE_MAX, createHealthStore } from './healthStore'

/** The thrown error as `Name: message` (the local bun:test typings have no toThrow). */
const thrown = (fn: () => unknown): string => { try { fn() } catch (err) { return err instanceof Error ? `${err.name}: ${err.message}` : String(err) } return 'did not throw' }

const T0 = 1_800_000_000_000 // test-only fixed clock
const ALL: HealthRule[] = ['file_size', 'todo_no_context']

function setup() {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  db.exec(`INSERT INTO central_task (id, project_id, title, objective, created_by, created_at, updated_at) VALUES ('t1', 'p', 't', 'o', 'central', 0, 0), ('t2', 'p', 't', 'o', 'central', 0, 0)`)
  const clock = { t: T0 }
  const store = createHealthStore(db, () => clock.t++)
  const scan = (drafts: FindingDraft[], opts: { rules?: HealthRule[]; truncated?: boolean; origin?: 'scan' | 'review'; taskId?: string | null } = {}) => {
    const s = store.startScan('p', opts.origin ?? 'scan')
    return store.finishScan(s.id, { drafts, rules: opts.rules ?? ALL, filesScanned: 3, truncated: opts.truncated ?? false, taskId: opts.taskId ?? null })
  }
  const byFp = (fp: string) => store.list({ projectId: 'p', limit: 200 }).find((f) => f.fingerprint === fp)!
  const events = (kind: string) => (db.query('SELECT COUNT(*) AS n FROM event WHERE kind = ?').get(kind) as { n: number }).n
  return { db, store, scan, byFp, events }
}

const draft = (fp: string, over: Partial<FindingDraft> = {}): FindingDraft => ({
  rule: 'file_size', severity: 'medium', confidence: 'high', file: `${fp}.ts`, line: 1, title: `big ${fp}`,
  evidence: '600 lines', source: 'CLAUDE.md Rule 8', suggestion: 'split it', fingerprint: fp, ...over,
})

test('a new draft opens; a rescan refreshes it without counting it again', () => {
  const { scan, byFp, events } = setup()
  const first = scan([draft('a')])
  expect(first.opened.map((f) => f.fingerprint)).toEqual(['a'])
  expect(first.scan).toMatchObject({ status: 'done', opened: 1, fixed: 0, filesScanned: 3, truncated: false })
  const firstSeen = byFp('a').firstSeenAt
  const second = scan([draft('a', { line: 9, evidence: '700 lines' })])
  expect(second.opened).toEqual([])
  expect(byFp('a')).toMatchObject({ status: 'open', line: 9, evidence: '700 lines', firstSeenAt: firstSeen })
  expect(byFp('a').lastSeenAt).toBeGreaterThan(firstSeen)
  expect(events('health.finding.opened')).toBe(1)
  expect(events('health.scan.finished')).toBe(2)
})

test('a finding missing from a full scan is fixed, and reopens when it comes back', () => {
  const { scan, byFp, events } = setup()
  scan([draft('a'), draft('b')])
  const r = scan([draft('b')])
  expect(r.fixed.map((f) => f.fingerprint)).toEqual(['a'])
  expect(r.scan.fixed).toBe(1)
  expect(byFp('a').status).toBe('fixed')
  expect(byFp('a').fixedAt).not.toBeNull()
  const back = scan([draft('a'), draft('b')])
  expect(back.opened.map((f) => f.fingerprint)).toEqual(['a'])
  expect(byFp('a')).toMatchObject({ status: 'open', fixedAt: null })
  expect(events('health.finding.fixed')).toBe(1)
})

test('a truncated scan never auto-fixes', () => {
  const { scan, byFp } = setup()
  scan([draft('a')])
  const r = scan([], { truncated: true })
  expect(r.fixed).toEqual([])
  expect(r.scan.truncated).toBe(true)
  expect(byFp('a').status).toBe('open')
})

test('a rule that did not run is not auto-fixed', () => {
  const { scan, byFp } = setup()
  scan([draft('a'), draft('todo', { rule: 'todo_no_context' })])
  const r = scan([], { rules: ['todo_no_context'] })
  expect(r.fixed.map((f) => f.fingerprint)).toEqual(['todo'])
  expect(byFp('a').status).toBe('open')
})

test('auto-fix stays inside its origin, and a review stays inside its task', () => {
  const { scan, byFp } = setup()
  scan([draft('s')])
  scan([draft('r1')], { origin: 'review', taskId: 't1' })
  scan([draft('r2')], { origin: 'review', taskId: 't2' })
  const r = scan([], { origin: 'review', taskId: 't1' })
  expect(r.fixed.map((f) => f.fingerprint)).toEqual(['r1'])
  expect(byFp('r2').status).toBe('open')
  expect(byFp('s').status).toBe('open')
  expect(byFp('r2').taskId).toBe('t2')
})

test('dismiss needs a reason, stays dismissed across rescans, and reopen brings it back', () => {
  const { store, scan, byFp, events } = setup()
  scan([draft('a')])
  const id = byFp('a').id
  expect(thrown(() => store.dismiss(id, '   ', 'human'))).toMatch(/^HealthStoreError/)
  expect(thrown(() => store.dismiss(id, 'x'.repeat(501), 'human'))).toMatch(/500/)
  const d = store.dismiss(id, '  generated file  ', 'human')
  expect(d).toMatchObject({ status: 'dismissed', dismissedReason: 'generated file', dismissedBy: 'human' })
  expect(thrown(() => store.dismiss(id, 'again', 'human'))).toMatch(/only open/)
  const seenBefore = byFp('a').lastSeenAt
  const again = scan([draft('a', { evidence: 'changed' })])
  expect(again.opened).toEqual([])
  expect(byFp('a')).toMatchObject({ status: 'dismissed', evidence: '600 lines' })
  expect(byFp('a').lastSeenAt).toBeGreaterThan(seenBefore)
  expect(scan([]).fixed).toEqual([])
  expect(byFp('a').status).toBe('dismissed')
  const o = store.reopen(id, 'human')
  expect(o).toMatchObject({ status: 'open', dismissedReason: null, dismissedBy: null })
  expect(thrown(() => store.reopen(id, 'human'))).toMatch(/only dismissed/)
  expect(events('health.finding.dismissed')).toBe(1)
  expect(events('health.finding.reopened')).toBe(1)
})

test('a scan finishes once; failScan records the error; unknown ids say which id', () => {
  const { store } = setup()
  const s = store.startScan('p', 'scan')
  store.finishScan(s.id, { drafts: [], rules: ALL, filesScanned: 0, truncated: false })
  expect(thrown(() => store.finishScan(s.id, { drafts: [], rules: ALL, filesScanned: 0, truncated: false }))).toMatch(/already done/)
  const f = store.failScan(store.startScan('p', 'scan').id, 'git ls-files failed')
  expect(f).toMatchObject({ status: 'failed', error: 'git ls-files failed' })
  expect(f.finishedAt).not.toBeNull()
  expect(thrown(() => store.failScan('nope', 'x'))).toMatch(/scan not found: nope/)
  expect(thrown(() => store.dismiss('nope', 'r', 'h'))).toMatch(/finding not found: nope/)
  expect(thrown(() => store.startScan('missing', 'scan'))).toMatch(/project missing/)
  expect(store.get('nope')).toBeNull()
})

test('list orders by severity then recency, filters, and caps the page', () => {
  const { store, scan } = setup()
  scan([draft('low', { severity: 'low' }), draft('high', { severity: 'high' }), draft('med', { severity: 'medium', rule: 'todo_no_context' })])
  expect(store.list({ projectId: 'p' }).map((f) => f.fingerprint)).toEqual(['high', 'med', 'low'])
  expect(store.list({ projectId: 'p', severities: ['low', 'high'] }).map((f) => f.fingerprint)).toEqual(['high', 'low'])
  expect(store.list({ projectId: 'p', rules: ['todo_no_context'] }).map((f) => f.fingerprint)).toEqual(['med'])
  expect(store.list({ projectId: 'p', statuses: ['fixed'] })).toEqual([])
  expect(store.list({ projectId: 'p', limit: 1, offset: 1 }).map((f) => f.fingerprint)).toEqual(['med'])
  expect(thrown(() => store.list({ projectId: 'p', limit: 0 }))).toMatch(/^HealthStoreError/)
  scan(Array.from({ length: 250 }, (_, i) => draft(`bulk${i}`)), { rules: [] })
  expect(store.list({ projectId: 'p', limit: 10_000 }).length).toBe(HEALTH_PAGE_MAX)
  expect(store.list({ projectId: 'p' }).length).toBe(50)
})

test('opened events are capped per scan; the summary event carries the full count', () => {
  const { scan, db, events } = setup()
  const r = scan(Array.from({ length: 150 }, (_, i) => draft(`f${i}`)))
  expect(r.opened.length).toBe(150)
  expect(events('health.finding.opened')).toBe(100)
  const payload = JSON.parse((db.query(`SELECT payload_json FROM event WHERE kind = 'health.scan.finished'`).get() as { payload_json: string }).payload_json)
  expect(payload.opened).toBe(150)
})

test('summary counts open findings by severity with the latest project scan; lastScanAt is per origin', () => {
  const { store, scan, byFp } = setup()
  expect(store.summary('p')).toEqual({ open: 0, high: 0, medium: 0, low: 0, lastScan: null })
  expect(store.lastScanAt('p', 'scan')).toBeNull()
  const first = scan([draft('a', { severity: 'high' }), draft('b'), draft('c', { severity: 'low' })])
  store.dismiss(byFp('c').id, 'fine', 'human')
  const last = scan([draft('a', { severity: 'high' }), draft('b'), draft('c', { severity: 'low' })], { origin: 'review', taskId: 't1' })
  const s = store.summary('p')
  expect(s).toMatchObject({ open: 2, high: 1, medium: 1, low: 0 })
  expect(s.lastScan?.id).toBe(first.scan.id) // a newer review is not the project's last scan
  expect(store.lastScanAt('p', 'review')).toBe(last.scan.startedAt)
  expect(last.scan.startedAt).toBeGreaterThan(store.lastScanAt('p', 'scan') ?? Infinity)
})

test('latestScan filters by origin; without one it returns the newest of any origin', () => {
  const { store, scan } = setup()
  const full = scan([draft('a')])
  const review = scan([draft('r')], { origin: 'review', taskId: 't1' })
  const analysis = store.startScan('p', 'analysis')
  expect(store.latestScan('p')?.id).toBe(analysis.id)
  expect(store.latestScan('p', 'scan')?.id).toBe(full.scan.id)
  expect(store.latestScan('p', 'review')?.id).toBe(review.scan.id)
  expect(store.latestScan('p', 'analysis')?.id).toBe(analysis.id)
  expect(store.summary('p').lastScan?.id).toBe(full.scan.id)
  expect(store.latestScan('other', 'scan')).toBeNull()
})

test('deleting the project cascades findings and scans; deleting a task keeps its findings', () => {
  const { db, store, scan, byFp } = setup()
  scan([draft('r')], { origin: 'review', taskId: 't1' })
  db.exec(`DELETE FROM central_task WHERE id = 't1'`)
  expect(byFp('r').taskId).toBeNull()
  db.exec(`DELETE FROM event WHERE project_id = 'p'`)
  db.exec(`DELETE FROM project WHERE id = 'p'`)
  expect(store.list({ projectId: 'p' })).toEqual([])
  expect(store.latestScan('p')).toBeNull()
})
