// Retention rules beyond the original registry test: audit events (with the newest setting rows kept
// forever), forgotten-memory events, rejected skills and their folders, ledger usage/run, ended agents,
// the five Central tables that had a rule but no test, and the per-table summary a sweep returns.
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureSkillTable } from '../central/skills/skillIndex'
import { migrate } from './migration'
import { sweepRetention } from './ledgerRetention'
import { FORGOTTEN_MEMORY_EVENT_RETENTION_MS, LEDGER_RUN_RETENTION_MS, LEDGER_USAGE_RETENTION_MS, SETTLED_RETENTION_MS } from './ledgerRetention.policy'
import { AUDIT_EVENT_MAX_AGE_MS, KEEP_LATEST_KINDS } from './ledgerRetentionEvent'
import { SKILL_REJECTED_RETENTION_MS, proposedDirInside, sweepRejectedSkills } from './ledgerRetentionSkill'

const NOW = 1_800_000_000_000 // test-only fixed clock
const OLD = NOW - SETTLED_RETENTION_MS - 1
const tmp = mkdtempSync(join(tmpdir(), 'retention-skills-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function seeded(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  return db
}
const run = (db: Database) => sweepRetention({ db, now: () => NOW }, NOW)
const ids = (db: Database, sql: string): string[] => (db.query(sql).all() as { id: string | number }[]).map((r) => String(r.id)).sort()
const task = (db: Database, id: string, status: string, updated: number) => db.query(`INSERT INTO central_task
  (id, project_id, title, objective, status, created_by, created_at, updated_at) VALUES (?, 'p', 't', 'o', ?, 'u', 0, ?)`).run(id, status, updated)

test('audit events: past 90 days go, with or without a project; the newest setting row per kind and an existing task timeline stay', () => {
  const db = seeded()
  const old = NOW - AUDIT_EVENT_MAX_AGE_MS - 1
  task(db, 'task-live', 'running', NOW)
  const ev = (kind: string, ts: number, opts: { project?: string; corr?: string } = {}) =>
    db.query(`INSERT INTO event (ts, project_id, actor, kind, correlation_id) VALUES (?, ?, 'a', ?, ?)`).run(ts, opts.project ?? null, kind, opts.corr ?? null)
  ev('central.halt', old); ev('central.halt', old) // the second is the newest halt: kept
  ev('central.control', old); ev('central.breaker', old)
  ev('autonomy.run', old); ev('central.agent', old, { project: 'p' }); ev('work.move', old, { corr: 'task-gone' })
  ev('work.move', old, { corr: 'task-live' }); ev('tool.audit', NOW)
  expect(run(db).changed['event']).toBe(4)
  const left = db.query('SELECT kind, correlation_id AS c FROM event ORDER BY seq').all()
  expect(left).toEqual([
    { kind: 'central.halt', c: null }, { kind: 'central.control', c: null }, { kind: 'central.breaker', c: null },
    { kind: 'work.move', c: 'task-live' }, { kind: 'tool.audit', c: null },
  ])
  expect(KEEP_LATEST_KINDS).toContain('policy.classifier_switch')
})

test('a chained classifier switch outlives the 30-day chain prune; an older switch below the base is dropped later', () => {
  const db = seeded()
  let prev = 'GENESIS'
  const chained = (kind: string, ts: number) => {
    const hash = `h${ts}-${kind}`
    db.query(`INSERT INTO event (ts, actor, kind, prev_hash, hash) VALUES (?, 'a', ?, ?, ?)`).run(ts, kind, prev, hash)
    prev = hash
  }
  chained('policy.classifier_switch', OLD - 3); chained('hook.Stop', OLD - 2); chained('hook.Stop', OLD - 1); chained('hook.Stop', NOW)
  run(db)
  expect(ids(db, `SELECT kind || ':' || ts AS id FROM event`)).toEqual([`hook.Stop:${NOW}`, `policy.classifier_switch:${OLD - 3}`])
  expect(db.query('SELECT seq, pruned FROM event_chain_base').get()).toEqual({ seq: 3, pruned: 2 })
  chained('policy.classifier_switch', NOW); chained('hook.Stop', NOW + 1)
  run(db)
  expect(ids(db, `SELECT kind || ':' || ts AS id FROM event`)).toEqual([`hook.Stop:${NOW}`, `hook.Stop:${NOW + 1}`, `policy.classifier_switch:${NOW}`])
})

test('memory events: a forgotten memory loses its trail after 90 days; live memories keep theirs', () => {
  const db = seeded()
  const old = NOW - FORGOTTEN_MEMORY_EVENT_RETENTION_MS - 1
  const mem = (id: string, key: string) => db.query(`INSERT INTO memory (id, project_id, key, title, body, created_at, updated_at) VALUES (?, 'p', ?, 't', 'b', 0, 0)`).run(id, key)
  mem('gone', 'forgotten:gone'); mem('live', 'k')
  const me = (memory: string, ts: number) => db.query(`INSERT INTO memory_event (memory_id, ts, actor, kind) VALUES (?, ?, 'a', 'memory.update')`).run(memory, ts)
  me('gone', old); me('gone', NOW); me('live', old)
  expect(run(db).changed['memory_event']).toBe(1)
  expect(ids(db, `SELECT memory_id || ':' || (ts = ${NOW}) AS id FROM memory_event`)).toEqual(['gone:1', 'live:0'])
})

test('skills: rejected proposals 30+ days old go with their proposed/ folder; other rows and folders stay', () => {
  const db = seeded()
  ensureSkillTable(db)
  const root = join(tmp, 'skills')
  const old = NOW - SKILL_REJECTED_RETENTION_MS - 1
  const skill = (name: string, version: string, status: string, at: number) => {
    db.query(`INSERT INTO central_skill (name, version, status, origin, created_at) VALUES (?, ?, ?, 'central', ?)`).run(name, version, status, at)
    mkdirSync(join(root, 'proposed', name, version), { recursive: true })
    writeFileSync(join(root, 'proposed', name, version, 'SKILL.md'), 'x')
  }
  skill('webterm-a', '1', 'rejected', old); skill('webterm-a', '2', 'pending_approval', old); skill('webterm-b', '1', 'rejected', NOW)
  expect(sweepRejectedSkills({ db, now: () => NOW }, NOW, 100, root)).toBe(1)
  expect(ids(db, `SELECT name || '@' || version AS id FROM central_skill`)).toEqual(['webterm-a@2', 'webterm-b@1'])
  expect(existsSync(join(root, 'proposed', 'webterm-a', '1'))).toBe(false)
  expect(existsSync(join(root, 'proposed', 'webterm-a', '2'))).toBe(true)
  expect(existsSync(join(root, 'proposed', 'webterm-b', '1'))).toBe(true)
})

test('skills: a row whose name or version would leave the skills root never reaches the disk', () => {
  const root = join(tmp, 'skills2')
  expect(proposedDirInside(root, 'webterm-a', '3')).toBe(join(root, 'proposed', 'webterm-a', '3'))
  expect(proposedDirInside(root, '../../etc', '1')).toBe(null)
  expect(proposedDirInside(root, 'webterm-a', '../../..')).toBe(null)
  const outside = join(tmp, 'outside')
  mkdirSync(outside, { recursive: true })
  const db = seeded()
  ensureSkillTable(db)
  db.query(`INSERT INTO central_skill (name, version, status, origin, created_at) VALUES ('../outside', '1', 'rejected', 'central', 0)`).run()
  expect(sweepRejectedSkills({ db, now: () => NOW }, NOW, 100, root)).toBe(1)
  expect(existsSync(outside)).toBe(true)
})

test('ledger usage and runs age out after their caps; an old run keeps living while it still has recent usage', () => {
  const db = seeded()
  const runRow = (id: string, started: number) => db.query(`INSERT INTO run (id, project_id, started_at) VALUES (?, 'p', ?)`).run(id, started)
  const use = (id: string, runId: string, ts: number) => db.query(`INSERT INTO usage (id, run_id, ts) VALUES (?, ?, ?)`).run(id, runId, ts)
  runRow('r-old', NOW - LEDGER_RUN_RETENTION_MS - 1); runRow('r-old-busy', NOW - LEDGER_RUN_RETENTION_MS - 1); runRow('r-new', NOW)
  use('u-old', 'r-old', NOW - LEDGER_USAGE_RETENTION_MS - 1); use('u-busy-old', 'r-old-busy', NOW - LEDGER_USAGE_RETENTION_MS - 1)
  use('u-busy-new', 'r-old-busy', NOW); use('u-new', 'r-new', NOW)
  run(db)
  expect(ids(db, 'SELECT id FROM usage')).toEqual(['u-busy-new', 'u-new'])
  expect(ids(db, 'SELECT id FROM run')).toEqual(['r-new', 'r-old-busy'])
})

test('central agents: ended 30+ days ago go; live and recently ended stay', () => {
  const db = seeded()
  const agent = (id: string, ended: number | null) => db.query(`INSERT INTO central_agents (id, project_id, kind, runner, state, owner, started_at, ended_at)
    VALUES (?, 'p', 'k', 'pty', ?, 'human', 0, ?)`).run(id, ended === null ? 'running' : 'ended', ended)
  agent('old', OLD); agent('live', null); agent('recent', NOW)
  run(db)
  expect(ids(db, 'SELECT id FROM central_agents')).toEqual(['live', 'recent'])
})

test('central tasks, reminders, check-in reasons, findings and health scans follow their rules', () => {
  const db = seeded()
  task(db, 'done-old', 'done', OLD); task(db, 'failed-old', 'failed', OLD); task(db, 'running-old', 'running', OLD)
  task(db, 'assigned-old', 'done', OLD); task(db, 'blocker-old', 'done', OLD); task(db, 'waiting', 'todo', NOW); task(db, 'done-new', 'done', NOW)
  db.exec(`INSERT INTO central_assignment (id, task_id, project_id, node_id, channel, instruction, attempt, started_at) VALUES ('as', 'assigned-old', 'p', 'n', 'chat', 'i', 1, 0);
    INSERT INTO central_task_dep (task_id, blocked_by_id) VALUES ('waiting', 'blocker-old'), ('done-new', 'done-old')`)
  const reminder = (id: string, status: string, at: number) => db.query(`INSERT INTO central_reminder (id, text, due_at, status, created_by, created_at) VALUES (?, 't', 0, ?, 'u', ?)`).run(id, status, at)
  reminder('fired-old', 'fired', OLD); reminder('cancelled-old', 'cancelled', OLD); reminder('pending-old', 'pending', OLD); reminder('fired-new', 'fired', NOW)
  const reason = (id: string, kind: string, sent: number | null, taskId: string | null = null) => db.query(`INSERT INTO central_checkin_reason
    (id, dedupe_key, kind, task_id, text, created_at, sent_at) VALUES (?, ?, ?, ?, 't', 0, ?)`).run(id, id, kind, taskId, sent)
  reason('sent-old', 'task_duty', OLD); reason('unsent', 'task_duty', null); reason('overdue-old', 'task_overdue', OLD, 'running-old'); reason('sent-new', 'task_duty', NOW)
  const finding = (id: string, status: string, fixed: number | null) => db.query(`INSERT INTO central_finding (id, project_id, fingerprint, origin, rule, severity, confidence, file,
    title, evidence, source, suggestion, status, first_seen_at, last_seen_at, fixed_at) VALUES (?, 'p', ?, 'scan', 'r', 'low', 'low', 'f', 't', 'e', 's', 'x', ?, 0, 0, ?)`).run(id, id, status, fixed)
  finding('fixed-old', 'fixed', OLD); finding('open', 'open', null); finding('dismissed-old', 'dismissed', OLD); finding('fixed-new', 'fixed', NOW)
  const scan = (id: string, origin: string, at: number) => db.query(`INSERT INTO central_health_scan (id, project_id, origin, status, started_at) VALUES (?, 'p', ?, 'done', ?)`).run(id, origin, at)
  scan('scan-older', 'scan', OLD - 10); scan('scan-latest-old', 'scan', OLD); scan('review-only-old', 'review', OLD); scan('scan-new', 'analysis', NOW)
  run(db)
  expect(ids(db, 'SELECT id FROM central_task')).toEqual(['assigned-old', 'blocker-old', 'done-new', 'running-old', 'waiting']) // done-old: its dependent is settled
  expect(ids(db, 'SELECT id FROM central_reminder')).toEqual(['fired-new', 'pending-old'])
  expect(ids(db, 'SELECT id FROM central_checkin_reason')).toEqual(['overdue-old', 'sent-new', 'unsent'])
  expect(ids(db, 'SELECT id FROM central_finding')).toEqual(['dismissed-old', 'fixed-new', 'open'])
  expect(ids(db, 'SELECT id FROM central_health_scan')).toEqual(['review-only-old', 'scan-latest-old', 'scan-new'])
})

test('a sweep returns what it removed per table (only tables that changed)', () => {
  const db = seeded()
  db.query(`INSERT INTO central_reminder (id, text, due_at, status, created_by, created_at) VALUES ('r', 't', 0, 'fired', 'u', ?)`).run(OLD)
  db.query(`INSERT INTO central_agents (id, project_id, kind, runner, state, owner, started_at, ended_at) VALUES ('a1', 'p', 'k', 'pty', 'ended', 'human', 0, ?), ('a2', 'p', 'k', 'pty', 'ended', 'human', 0, ?)`).run(OLD, OLD)
  expect(run(db)).toEqual({ changed: { central_reminder: 1, central_agents: 2 }, more: false })
  expect(run(db)).toEqual({ changed: {}, more: false })
})
