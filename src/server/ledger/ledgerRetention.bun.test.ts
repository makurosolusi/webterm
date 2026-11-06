// data-209-10 / agent-211-C4: each registry sweep drops only old, settled rows and never a row that
// is open, queued, pending, still consumable, or referenced by something live.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrate } from './migration'
import { APPROVAL_INPUT_GRACE_MS, SETTLED_RETENTION_MS, USAGE_RETENTION_MS } from './ledgerRetention.policy'
import { createRetention, sweepRetention } from './ledgerRetention'
import { startLedgerReaper } from './ledgerRuntime'

const NOW = 1_800_000_000_000 // test-only fixed clock
const OLD = NOW - SETTLED_RETENTION_MS - 1
const ANCIENT = NOW - USAGE_RETENTION_MS - 1

function seeded(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  return db
}
const ids = (db: Database, sql: string): string[] => (db.query(sql).all() as { id: string }[]).map((r) => r.id).sort()
const run = (db: Database) => sweepRetention({ db, now: () => NOW }, NOW)

test('outbox: settled 30+ days ago is deleted, queued and recently settled stay', () => {
  const db = seeded()
  const put = (id: string, status: string, settled: number | null) => db.query(`INSERT INTO agent_outbox
    (id, operation_id, to_node, kind, body, status, created_by, created_at, settled_at) VALUES (?, ?, 'n', 'visible', 'b', ?, 'u', 0, ?)`).run(id, `op-${id}`, status, settled)
  put('old-delivered', 'delivered', OLD); put('old-failed', 'failed', OLD); put('old-queued', 'queued', null)
  put('recent', 'delivered', NOW - 1000)
  expect(run(db).changed['agent_outbox']).toBe(2)
  expect(ids(db, 'SELECT id FROM agent_outbox')).toEqual(['old-queued', 'recent'])
})

test('inbox: resolved items age out; open ones and items of a still-pending approval stay', () => {
  const db = seeded()
  db.exec(`INSERT INTO approval (id, kind, status, created_at, updated_at) VALUES ('ap-pending', 'tool', 'pending', ${OLD}, ${OLD})`)
  const put = (id: string, status: string, at: number, approval: string | null = null) => db.query(`INSERT INTO inbox_item
    (id, kind, source, title, status, approval_id, created_at, updated_at) VALUES (?, 'notify', 's', 't', ?, ?, ?, ?)`).run(id, status, approval, at, at)
  put('old-done', 'done', OLD); put('old-ignored', 'ignored', OLD); put('old-open', 'open', OLD)
  put('ignored-pending', 'ignored', OLD, 'ap-pending'); put('recent-done', 'done', NOW)
  run(db)
  expect(ids(db, 'SELECT id FROM inbox_item')).toEqual(['ignored-pending', 'old-open', 'recent-done'])
})

test('approvals: input blanked after settling, rows deleted after 30 days unless pending, consumable or referenced', () => {
  const db = seeded()
  const input = JSON.stringify({ tool: 'Bash', input: { command: 'x'.repeat(1000) } })
  const decision = (id: string, singleUse: number) => db.query(`INSERT INTO decision (id, question, single_use, created_at) VALUES (?, 'q', ?, ?)`).run(id, singleUse, OLD)
  const put = (id: string, status: string, at: number, opts: { decision?: string; expires?: number } = {}) => db.query(`INSERT INTO approval
    (id, kind, request_json, status, decision_id, expires_at, created_at, updated_at) VALUES (?, 'tool', ?, ?, ?, ?, ?, ?)`).run(id, input, status, opts.decision ?? null, opts.expires ?? null, at, at)
  decision('d-spent', 0); decision('d-live', 1); decision('d-orphan', 0)
  put('rejected-old', 'rejected', OLD)
  put('expired-old', 'expired', OLD)
  put('spent-old', 'approved', OLD, { decision: 'd-spent' })
  put('consumable-old', 'approved', OLD, { decision: 'd-live' }) // approved, single_use = 1, no expiry: still a live consent
  put('pending-old', 'pending', OLD)
  put('rejected-2d', 'rejected', NOW - 2 * APPROVAL_INPUT_GRACE_MS)
  put('rejected-now', 'rejected', NOW)
  put('gated-old', 'rejected', OLD)
  put('agent-old', 'expired', OLD)
  db.exec(`INSERT INTO dag (id, project_id, title, repo, status, created_by, created_at, updated_at) VALUES ('dg', 'p', 't', 'r', 'active', 'u', ${NOW}, ${NOW});
    INSERT INTO dag_task (id, dag_id, key, kind, brief_json, created_at, updated_at) VALUES ('dt', 'dg', 'k', 'gate', '{}', ${NOW}, ${NOW});
    INSERT INTO dag_gate (id, dag_id, task_id, approval_id, question, created_at) VALUES ('g', 'dg', 'dt', 'gated-old', 'q', ${NOW});
    INSERT INTO central_agents (id, project_id, kind, runner, state, owner, approval_id, started_at) VALUES ('ag', 'p', 'k', 'pty', 'waiting', 'human', 'agent-old', ${NOW})`)
  run(db)
  expect(ids(db, 'SELECT id FROM approval')).toEqual(['agent-old', 'consumable-old', 'gated-old', 'pending-old', 'rejected-2d', 'rejected-now'])
  const hasInput = ids(db, "SELECT id FROM approval WHERE json_type(request_json, '$.input') IS NOT NULL")
  expect(hasInput).toEqual(['consumable-old', 'pending-old', 'rejected-now'])
  expect(JSON.parse(String((db.query("SELECT request_json AS j FROM approval WHERE id = 'rejected-2d'").get() as { j: string }).j))).toEqual({ tool: 'Bash' })
  // Decisions go once their approval is gone; the live consent keeps its decision.
  expect(ids(db, 'SELECT id FROM decision')).toEqual(['d-live'])
})

test('dag: finished dags age out with their tasks, gates and dispatches; active dags stay', () => {
  const db = seeded()
  const dag = (id: string, status: string, at: number) => db.exec(`INSERT INTO dag (id, project_id, title, repo, status, created_by, created_at, updated_at) VALUES ('${id}', 'p', 't', 'r', '${status}', 'u', ${at}, ${at});
    INSERT INTO dag_task (id, dag_id, key, kind, brief_json, created_at, updated_at) VALUES ('${id}-t', '${id}', 'k', 'work', '{}', ${at}, ${at});
    INSERT INTO dag_dispatch (id, task_id, node_id, started_at) VALUES ('${id}-d', '${id}-t', 'n', ${at});
    INSERT INTO dag_gate (id, dag_id, task_id, approval_id, question, created_at) VALUES ('${id}-g', '${id}', '${id}-t', 'a-${id}', 'q', ${at})`)
  dag('done-old', 'done', OLD); dag('failed-old', 'failed', OLD); dag('active-old', 'active', OLD); dag('done-new', 'done', NOW)
  run(db)
  expect(ids(db, 'SELECT id FROM dag')).toEqual(['active-old', 'done-new'])
  expect(ids(db, 'SELECT id FROM dag_task')).toEqual(['active-old-t', 'done-new-t'])
  expect(ids(db, 'SELECT id FROM dag_dispatch')).toEqual(['active-old-d', 'done-new-d'])
  expect(ids(db, 'SELECT id FROM dag_gate')).toEqual(['active-old-g', 'done-new-g'])
})

test('central events of settled turns age out; events of a running turn, mail before expiry, recent spend stay', () => {
  const db = seeded()
  db.exec(`INSERT INTO central_turn (id, conversation_id, message_id, status, started_at) VALUES ('t-done', 'c', 'm', 'succeeded', ${OLD}), ('t-run', 'c', 'm2', 'running', ${OLD})`)
  const ev = (seq: number, turn: string | null, at: number) => db.query(`INSERT INTO central_event (conversation_id, seq, type, turn_id, payload_json, created_at) VALUES ('c', ?, 'x', ?, '{}', ?)`).run(seq, turn, at)
  ev(1, null, OLD); ev(2, 't-done', OLD); ev(3, 't-run', OLD); ev(4, 't-done', NOW)
  const mail = (id: string, expires: number) => db.query(`INSERT INTO agent_mail (id, project_id, from_ref, to_ref, kind, body, created_at, expires_at) VALUES (?, 'p', 'a', 'b', 'msg', 'x', 0, ?)`).run(id, expires)
  mail('expired', NOW - 1); mail('live', NOW + 1000)
  const usage = (key: string, ts: number) => db.query(`INSERT INTO cost_usage (key, ts, source, input, output, cache_read, cache_write_5m, cache_write_1h, price_known) VALUES (?, ?, 's', 0, 0, 0, 0, 0, 1)`).run(key, ts)
  usage('ancient', ANCIENT); usage('recent', OLD)
  db.exec(`INSERT INTO dag (id, project_id, title, repo, status, created_by, created_at, updated_at) VALUES ('live-dag', 'p', 't', 'r', 'active', 'u', ${NOW}, ${NOW})`)
  const costRun = (id: string, kind: string, ref: string, ended: number | null) => db.query(`INSERT INTO cost_run (id, kind, ref, started_at, ended_at) VALUES (?, ?, ?, 0, ?)`).run(id, kind, ref, ended)
  costRun('routine-ancient', 'routine', 'r', ANCIENT); costRun('dag-ancient-live', 'dag', 'live-dag', ANCIENT); costRun('running', 'routine', 'r', null)
  const day = (t: number) => new Date(t).toISOString().slice(0, 10)
  db.exec(`INSERT INTO central_budget (day, scope) VALUES ('${day(ANCIENT - 86_400_000)}', 's'), ('${day(NOW)}', 's')`)
  run(db)
  expect((db.query('SELECT seq FROM central_event ORDER BY seq').all() as { seq: number }[]).map((r) => r.seq)).toEqual([3, 4])
  expect(ids(db, 'SELECT id FROM agent_mail')).toEqual(['live'])
  expect(ids(db, 'SELECT key AS id FROM cost_usage')).toEqual(['recent'])
  expect(ids(db, 'SELECT id FROM cost_run')).toEqual(['dag-ancient-live', 'running'])
  expect(ids(db, 'SELECT day AS id FROM central_budget')).toEqual([day(NOW)])
})

test('a sweep is bounded: batches cap each pass and the throttled runner resumes the backlog on the next tick', () => {
  const db = seeded()
  const insert = db.query(`INSERT INTO agent_outbox (id, operation_id, to_node, kind, body, status, created_by, created_at, settled_at) VALUES (?, ?, 'n', 'visible', 'b', 'delivered', 'u', 0, ?)`)
  for (let i = 0; i < 25; i++) insert.run(`o${i}`, `op${i}`, OLD)
  const retention = createRetention({ db, now: () => NOW }, 60_000, { batch: 5, maxBatches: 2 })
  expect(retention.tick(NOW)).toMatchObject({ changed: { agent_outbox: 10 }, more: true })
  expect(retention.tick(NOW + 1)).toMatchObject({ changed: { agent_outbox: 10 }, more: true })
  expect(retention.tick(NOW + 2)).toMatchObject({ changed: { agent_outbox: 5 }, more: false })
  expect(retention.tick(NOW + 3)).toBe(null) // no backlog: waits the interval
  expect(retention.tick(NOW + 2 + 60_000)).toMatchObject({ changed: {}, more: false })
})

test('the existing reaper timer runs retention, and a failing retention never stops the lease sweep', async () => {
  const db = seeded()
  db.query(`INSERT INTO agent_outbox (id, operation_id, to_node, kind, body, status, created_by, created_at, settled_at)
    VALUES ('old', 'op-old', 'n', 'visible', 'b', 'delivered', 'u', 0, ?)`).run(OLD)
  let leases = 0
  const retention = createRetention({ db, now: () => NOW })
  const stopOk = startLedgerReaper({ task: { sweepExpiredLeases: () => { leases++ } }, retention }, 5, (err) => { throw err })
  const broken = { tick: (): never => { throw new Error('retention sweep agent_outbox failed') } }
  let brokenLeases = 0
  const errors: unknown[] = []
  const stopBroken = startLedgerReaper({ task: { sweepExpiredLeases: () => { brokenLeases++ } }, retention: broken }, 5, (err) => { errors.push(err) })
  await new Promise((resolve) => setTimeout(resolve, 40))
  stopOk(); stopBroken()
  expect(ids(db, 'SELECT id FROM agent_outbox')).toEqual([])
  expect(leases >= 2).toBe(true)
  expect(brokenLeases >= 2).toBe(true)
  expect(errors.length).toBe(brokenLeases)
})
