// Central chat retention: notices age out unless their subject still waits for the user, the
// conversation is capped by count, a turn's context trace is blanked and settled turns are capped.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrate } from './migration'
import { sweepRetention } from './ledgerRetention'
import { CONVERSATION_MAX_MESSAGES, CONVERSATION_MAX_TURNS, NOTICE_RETENTION_MS, TURN_CONTEXT_RETENTION_MS } from './ledgerRetentionChat'

const NOW = 1_800_000_000_000 // test-only fixed clock
const OLD = NOW - NOTICE_RETENTION_MS - 1

function seeded(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  return db
}
const run = (db: Database) => sweepRetention({ db, now: () => NOW }, NOW)
const ids = (db: Database, sql: string): string[] => (db.query(sql).all() as { id: string }[]).map((r) => r.id).sort()
let seq = 0
const msg = (db: Database, id: string, role: string, at: number, opts: { client?: string; turn?: string; conv?: string } = {}) =>
  db.query(`INSERT INTO central_message (id, conversation_id, seq, role, parts_json, client_message_id, turn_id, created_at) VALUES (?, ?, ?, ?, '[]', ?, ?, ?)`)
    .run(id, opts.conv ?? 'c', ++seq, role, opts.client ?? null, opts.turn ?? null, at)

test('notices older than 30 days go; open inbox/task notices, the current /model choice and chat messages stay', () => {
  const db = seeded()
  db.exec(`INSERT INTO inbox_item (id, kind, source, title, status, created_at, updated_at) VALUES ('i-open', 'gate', 's', 't', 'open', 0, 0), ('i-done', 'gate', 's', 't', 'done', 0, 0);
    INSERT INTO central_task (id, project_id, title, objective, status, created_by, created_at, updated_at) VALUES
      ('t-wait', 'p', 't', 'o', 'waiting_input', 'u', 0, ${NOW}), ('t-done', 'p', 't', 'o', 'done', 'u', 0, ${NOW});
    INSERT INTO central_turn (id, conversation_id, message_id, status, started_at) VALUES ('turn-run', 'c', 'm-run', 'running', ${OLD})`)
  msg(db, 'n-inbox-open', 'system', OLD, { client: 'notice:inbox:i-open' })
  msg(db, 'n-inbox-done', 'system', OLD, { client: 'notice:inbox:i-done' })
  msg(db, 'n-work-open', 'system', OLD, { client: 'notice:work:t-wait:7' })
  msg(db, 'n-esc-open', 'system', OLD, { client: 'notice:escalate:t-wait:1:3' })
  msg(db, 'n-work-done', 'system', OLD, { client: 'notice:work:t-done:9' })
  msg(db, 'n-other', 'system', OLD, { client: 'notice:checkin-paused:1' })
  msg(db, 'model-old', 'system', OLD, { client: 'model:opus:high' })
  msg(db, 'model-current', 'system', OLD, { client: 'model:sonnet:-' })
  msg(db, 'n-recent', 'system', NOW, { client: 'notice:agent:x' })
  msg(db, 'human-old', 'human', OLD)
  msg(db, 'auto-turn-old', 'system', OLD, { turn: 'turn-done' })
  msg(db, 'm-run', 'system', OLD, { turn: 'turn-run' })
  expect(run(db).changed['central_message']).toBe(4)
  expect(ids(db, 'SELECT id FROM central_message')).toEqual([
    'auto-turn-old', 'human-old', 'm-run', 'model-current', 'n-esc-open', 'n-inbox-open', 'n-recent', 'n-work-open',
  ])
})

test('a conversation keeps its newest messages up to the cap; another conversation is untouched', () => {
  const db = seeded()
  const insert = db.query(`INSERT INTO central_message (id, conversation_id, seq, role, parts_json, created_at) VALUES (?, 'big', ?, 'human', '[]', ?)`)
  db.exec('BEGIN'); for (let i = 1; i <= CONVERSATION_MAX_MESSAGES + 30; i++) insert.run(`b${i}`, i, NOW); db.exec('COMMIT')
  msg(db, 'small-1', 'human', OLD, { conv: 'small' })
  run(db)
  const left = db.query(`SELECT COUNT(*) AS n, MIN(seq) AS lo FROM central_message WHERE conversation_id = 'big'`).get() as { n: number; lo: number }
  expect(left).toEqual({ n: CONVERSATION_MAX_MESSAGES, lo: 31 })
  expect(ids(db, `SELECT id FROM central_message WHERE conversation_id = 'small'`)).toEqual(['small-1'])
})

test('turns: context trace blanked after 30 days (metadata kept); settled turns past the cap deleted, active ones kept', () => {
  const db = seeded()
  const old = NOW - TURN_CONTEXT_RETENTION_MS - 1
  db.exec(`INSERT INTO central_turn (id, conversation_id, message_id, status, started_at, ended_at, ctx_tokens, context_json) VALUES
    ('t-old', 'small', 'm', 'succeeded', ${old}, ${old + 5}, 1234, '{"memoryIds":["a"]}'),
    ('t-old-run', 'small', 'm2', 'running', ${old}, NULL, 1, '{"x":1}'),
    ('t-new', 'small', 'm3', 'succeeded', ${NOW}, ${NOW}, 1, '{"x":1}')`)
  const insert = db.query(`INSERT INTO central_turn (id, conversation_id, message_id, status, started_at) VALUES (?, 'big', ?, ?, ?)`)
  db.exec('BEGIN')
  insert.run('big-active', 'm-active', 'awaiting_approval', 1)
  for (let i = 1; i <= CONVERSATION_MAX_TURNS + 20; i++) insert.run(`big${i}`, `m${i}`, 'succeeded', NOW - 100_000 + i)
  db.exec('COMMIT')
  run(db)
  const t = db.query(`SELECT ended_at, ctx_tokens, context_json FROM central_turn WHERE id = 't-old'`).get()
  expect(t).toEqual({ ended_at: old + 5, ctx_tokens: 1234, context_json: null })
  expect(ids(db, `SELECT id FROM central_turn WHERE conversation_id = 'small' AND context_json IS NOT NULL`)).toEqual(['t-new', 't-old-run'])
  const big = db.query(`SELECT COUNT(*) AS n FROM central_turn WHERE conversation_id = 'big' AND status = 'succeeded'`).get() as { n: number }
  expect(big.n).toBe(CONVERSATION_MAX_TURNS)
  expect(ids(db, `SELECT id FROM central_turn WHERE id IN ('big-active', 'big1', 'big21')`)).toEqual(['big-active', 'big21'])
})
