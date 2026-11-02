# QC review — P2 ledger tests (false-confidence + mutation audit)

Branch `feature/agent-pusat-p2`, repo `/Users/bip/Documents/spawn/webterm`.
**Pinned commit `ff6daa0`** ("docs(rnd): record P2 ledger foundation"), bun 1.4.2.
Read-only review: this audit changed no source or test file; the only repo write is this report.
All mutations ran in `$JCODE_SCRATCH_DIR/p2mut*`.

Scope: `src/server/ledger/migration.bun.test.ts` (217 lines, 10 tests) and
`src/server/ledger/ledger.bun.test.ts` (380 lines, 12 tests).

**Drift note.** While this audit ran, another session edited the working tree (`ledger*.ts`,
`migration.ts`) and added untracked `ledgerTask.bun.test.ts` / `ledgerGuards.bun.test.ts`. Those
edits are out of scope. Everything below was measured against a copy taken from `ff6daa0` before
they landed, so line numbers and results are reproducible. Some findings are already being fixed
in the implementation in the live tree without matching coverage yet (sec. 8).

---

## 0. Baseline and gate hole

```
$ bun test src/server/ledger        # ff6daa0
22 pass / 0 fail, 180 expect() calls, 2 files, ~130 ms
```

`CLAUDE.md` documents the Bun gate as `bun test src/server/*.bun.test.ts`. That glob is one level
deep and **excludes `src/server/ledger/`**:

```
$ bun test src/server/*.bun.test.ts   -> 84 pass, 12 files   (no ledger tests)
$ bun test src/server/ledger          -> 22 pass, 2 files    (only here)
```

`npm test` (`vitest run`) also skips them (`vite.config.ts:13-14`). Neither documented gate runs
the P2 suite. Fix the gate to include `src/server/*/*.bun.test.ts` or
`bun test src/server --recursive`.

---

## 1. Method

One isolated copy per mutation (`p2mut-m1` … `p2mut-m26`), a single line/block changed each, then
`bun test src/server/ledger` re-run. Probes for the acceptance items no test covers
(`probe_eager.ts`, `probe_crash.ts`, `probe_accept.ts`, `probe_bounds.ts`,
`probe_migrate_concurrent.ts`). KILLED = an assertion fails; SURVIVES = suite stays green.

---

## 2. Mutation matrix

### 2a. Nine requested mutations

| # | Mutation | Pinned site | Result | Killed by |
|---|---|---|---|---|
| M1 | migrate: `BEGIN IMMEDIATE` → `BEGIN` | `migration.ts:50` | **SURVIVES** | — |
| M2 | tx(): `BEGIN IMMEDIATE` → `BEGIN` | `ledgerCore.ts:62` | **SURVIVES** | — |
| M3 | `assertFence` no-op | `ledgerTask.ts:114-116` | KILLED (weak) | `ledger:236` only |
| M4 | claimDone status guard removed | `ledgerTask.ts:130` | KILLED (weak) | `ledger:216` only |
| M5 | migrate catch: no `ROLLBACK` | `migration.ts:56-60` | KILLED | `migration:114` |
| M6 | `writeUserVersion` removed | `migration.ts:53` | KILLED (4 tests) | `migration:57,:73,:80,:94,:112,:206` |
| M7 | `PRAGMA foreign_keys=ON` removed | `migration.ts:118` | KILLED (3 tests) | `migration:68,:122`; `ledger:333` |
| M8 | all `memory_*` FTS triggers removed | `ledgerSchema.ts:162-173` | KILLED (2) | `migration:172-180,:205` |
| M9 | `agent.project_id` cascade removed | `ledgerSchema.ts:33` | KILLED | `ledger:334-336` |
| M10 | `task.idem_key UNIQUE` removed | `ledgerSchema.ts:53` | KILLED | `ledger:243-249` |

### 2b. Extra mutations

| # | Mutation | Pinned site | Result |
|---|---|---|---|
| M11 | tx() catch: no `ROLLBACK` | `ledgerCore.ts:69-72` | KILLED (`ledger:261-274`) |
| M12 | leaseTask live-lease guard removed | `ledgerTask.ts:30` | SURVIVES (SQL `WHERE` still blocks) |
| M13 | releaseToSuspect expiry guard removed | `ledgerTask.ts:96` | SURVIVES (SQL `WHERE` still blocks) |
| M14 | `if (m.version <= current) continue` removed | `migration.ts:47` | **SURVIVES** |
| M15 | `task.evidence_json` `json_valid` removed | `ledgerSchema.ts:54` | **SURVIVES** |
| M16 | `FAILABLE` guard removed | `ledgerTask.ts:194` | **SURVIVES** |
| M17 | listEvents `MAX_PAGE` clamp removed | `ledgerEvent.ts:76` | **SURVIVES** |
| M18 | backup integrity guard removed | `migration.ts:73` | **SURVIVES** |
| M19 | newer-schema guard removed | `migration.ts:41-45` | KILLED (`migration:86-97`) |
| M20 | `pruneBackups` removed | `migration.ts:97` | KILLED (`migration:184-212`) |
| M21 | `task.suspect` not emitted | `ledgerTask.ts:109` | **SURVIVES** |
| M22 | `task.renewed` not emitted | `ledgerTask.ts:85` | **SURVIVES** |
| M23 | `task.reopened` not emitted | `ledgerTask.ts:231` | **SURVIVES** |
| M24 | `task.failed` not emitted | `ledgerTask.ts:207` | **SURVIVES** |
| M25 | claimDone stops writing `heartbeat_at` | `ledgerTask.ts:133-137` | **SURVIVES** |
| M26 | `deleteProject` ignores id (`DELETE FROM project`) | `ledger.ts:222` | **SURVIVES** |

M12/M13 are benign: the predicate is duplicated in the `UPDATE … WHERE`, behaviour unchanged; only
the typed fast path disappears. Worth a comment, not a test.

---

## 3. Surviving mutations: why, exact assertion to add

### 3.1 M1/M2 — `BEGIN IMMEDIATE` never exercised (highest impact)

Every test uses one connection, so the two are indistinguishable. Two-connection probe (WAL,
`busy_timeout=50`): with `BEGIN`, writer B's `UPDATE` fails **mid-transaction** ("database is
locked" after 4 ms); with `BEGIN IMMEDIATE`, B fails at `BEGIN` before any caller statement runs.
`probe_eager.ts` separates the builds:

| build | `migrate()` `up` ran under held lock? | `tx()` body ran under held lock? |
|---|---|---|
| ff6daa0 | `false` | `false` |
| M1 (`BEGIN`) | **`true`** | `false` |
| M2 (`BEGIN`) | `false` | **`true`** |

Pin *"lock taken before user DDL/DML runs"* — the exact deadlock-avoidance contract claimed in
`migration.ts:48-49` / `ledgerCore.ts:56-59`.

`migration.bun.test.ts` (helpers already exist):

```ts
test('migrate takes the write lock before up() runs', () => {
  const path = tmpPath()
  const holder = new Database(path)
  holder.exec('PRAGMA journal_mode = WAL')
  holder.exec('PRAGMA busy_timeout = 50')
  holder.exec('BEGIN IMMEDIATE')
  holder.exec('CREATE TABLE holder (id INTEGER)')

  const db = new Database(path)
  db.exec('PRAGMA busy_timeout = 50')
  let upRan = false
  expectThrow(
    () =>
      migrate(db, [{
        version: 1,
        up: (d) => { upRan = true; d.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER)') },
      }]),
    'database is locked'
  )
  expect(upRan).toBe(false)          // M1 breaks this
  expect(version(db)).toBe(0)
  expect(tables(db)).not.toContain('probe')
  holder.exec('ROLLBACK')
  close(holder)
  close(db)
})
```

`ledger.bun.test.ts` (import `{ tx } from './ledgerCore'`):

```ts
test('tx() takes the write lock before running its body', () => {
  const path = join(root, 'eager-tx.sqlite')
  const seed = new Database(path)
  seed.exec('PRAGMA journal_mode = WAL')
  seed.exec('CREATE TABLE holder (id INTEGER)')
  seed.exec('BEGIN IMMEDIATE')
  seed.exec('INSERT INTO holder (id) VALUES (1)')

  const db = new Database(path)
  db.exec('PRAGMA busy_timeout = 50')
  let bodyRan = false
  expectThrow(
    () => tx({ db, now: () => 0 }, () => {
      bodyRan = true
      db.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER)')
    }),
    'database is locked'
  )
  expect(bodyRan).toBe(false)        // M2 breaks this
  seed.exec('ROLLBACK')
  close(seed)
  close(db)
})
```

Related: even current `openLedgerDb` loses ~1/12 children to `SQLITE_BUSY` on
`PRAGMA journal_mode = WAL` when 4 processes open one fresh file (`probe_migrate_concurrent.ts`).
Not in these two files, but a naive concurrent-migrate test will be flaky; assert the eager lock
as above instead.

### 3.2 M3 — the test named "stale fence is rejected" does not test the fence guard

The `UPDATE … AND fence = ?` already yields `changes = 0` and the code then throws
`StaleFenceError`, so removing `assertFence` only changes *which* error wins: M3 fails only at
`ledger:236` (`"reopened -> failed"` instead of `"stale fence"`), while the dedicated test at
`:169-190` stays green. `assertFence` buys error *precedence* (fence before status). Pin it:

```ts
test('a stale fence is reported as stale fence even when the status is also wrong', () => {
  const fx = fixture()
  leased(fx)                          // fence 1
  fx.ledger.task.reopenTask('t1')     // fence 2, status reopened
  const err = expectThrow(() => fx.ledger.task.failTask('t1', 1, 'late'), 'stale fence')
  expect(err instanceof StaleFenceError).toBe(true)
  expect((err as StaleFenceError).actual).toBe(2)
  close(fx.db)
})
```

Also add `verifyTask` with a stale fence while status is `claimed_done` (only claimDone and a
post-reopen failTask are covered today).

### 3.3 M4 — claimDone status guard has exactly one probe

`ledger.bun.test.ts:216` (`pending -> claimed_done`) is the only assertion that distinguishes
`IllegalTransitionError` from `StaleFenceError` in claimDone (M4 received
`"stale fence for task t1: expected 0, row has 0"`). Add the double-claim case:

```ts
fx.ledger.task.claimDone('t1', 1, { ok: true })
expectThrow(() => fx.ledger.task.claimDone('t1', 1, { again: true }), 'claimed_done -> claimed_done')
```

### 3.4 M14 — "second migrate is a no-op" is not asserted

`migration:65` only checks the return value; v1 DDL is all `IF NOT EXISTS`, so re-running every
statement is invisible (M14 keeps 22/22 green).

```ts
test('migrate skips already applied versions instead of re-running their DDL', () => {
  const db = new Database(':memory:')
  let runs = 0
  const steps: Migration[] = [{
    version: 1,
    up: (d) => { runs += 1; d.exec('CREATE TABLE IF NOT EXISTS once_t (id INTEGER)') },
  }]
  expect(migrate(db, steps)).toBe(1)
  expect(migrate(db, steps)).toBe(1)
  expect(runs).toBe(1)               // M14 breaks this
  close(db)
})
```

### 3.5 M15 — every `json_valid` CHECK is untested

No test writes malformed JSON through SQL, so removing the CHECK from any `*_json` column is
invisible. Add one per boundary (`project.budget_json`, `agent.capabilities_json`,
`task.evidence_json`, `event.payload_json`, `approval.request_json`, `run.evidence_json`):

```ts
test('JSON columns reject malformed text at the DB boundary', () => {
  const db = openLedgerDb(':memory:')
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  expectThrow(
    () => run(db, "INSERT INTO task (id, project_id, spec, evidence_json, created_at, updated_at) VALUES ('t1','p1','s','{oops',1,1)"),
    'CHECK constraint failed'
  )
  close(db)
})
```

### 3.6 M16 — `FAILABLE` guard untested

`failTask` may only leave `leased`/`claimed_done`; no test calls it from `verified`/`pending`. With
the guard gone SQL still refuses, so callers get `StaleFenceError` instead of
`IllegalTransitionError` (base: `"illegal task transition for v: verified -> failed"`).

```ts
test('failTask is rejected from verified with a typed IllegalTransitionError', () => {
  const fx = fixture()
  const t = leased(fx)
  fx.ledger.task.claimDone('t1', t.fence, { ok: true })
  fx.ledger.task.verifyTask('t1', t.fence, { by: 'orch' })
  const err = expectThrow(() => fx.ledger.task.failTask('t1', t.fence, 'late'), 'verified -> failed')
  expect(err instanceof IllegalTransitionError).toBe(true)
  expect(fx.ledger.task.getTask('t1')?.status).toBe('verified')
  close(fx.db)
})
```

### 3.7 M21–M24 — four of five transition events are never asserted

The event log is the acceptance object, yet only `created/leased/claimed_done/verified` are pinned
(`ledger:161-165`). Deleting the `emit(...)` for `suspect`, `renewed`, `reopened`, `failed` leaves
22/22 green. Add exact final sequences in the existing tests:

```ts
// 'stale fence is rejected after a re-lease'
expect(kinds(fx.ledger.event.listEvents({ taskId: 't1' })))
  .toBe('task.created,task.leased,task.suspect,task.leased,task.claimed_done')

// 'expired lease becomes suspect and renew ...'
expect(kinds(fx.ledger.event.listEvents({ taskId: 't1' })))
  .toBe('task.created,task.leased,task.renewed,task.suspect,task.leased')

// 'illegal transitions ...'
expect(kinds(fx.ledger.event.listEvents({ taskId: 't1' })))
  .toBe('task.created,task.leased,task.failed,task.reopened')
```

Also assert one payload (`suspect.expired_at`, `failed.reason`) and M25's
`expect(claimed.heartbeatAt).toBe(T0)` — the zombie clock is currently unasserted.

### 3.8 M26 — deleteProject over-deletes; suite cannot tell

`DELETE FROM project` with no `WHERE` keeps all 22 tests green: the fixture only ever has **one**
project, so the test proves "rows vanish", not "only this project's rows vanish". Seed `p2` with
its own agent/task/event and assert they survive:

```ts
fx.ledger.project.createProject({ id: 'p2', workspaceId: 'w2', name: 'other', path: '/tmp/p2' })
fx.ledger.agent.createAgent({ id: 'a2', projectId: 'p2', depth: 0 })
fx.ledger.task.createTask({ id: 't2', projectId: 'p2', spec: 's' })
fx.ledger.event.appendEvent({ projectId: 'p2', actor: 'test', kind: 'p2.event' })
// …after deleteProject('p1'):
expect(fx.ledger.project.getProject('p2')?.id).toBe('p2')
expect(fx.ledger.agent.getAgent('a2')?.id).toBe('a2')
expect(fx.ledger.task.getTask('t2')?.status).toBe('pending')
expect(count(fx.db, 'project')).toBe(1)        // breaks under M26
```

Same test should populate `decision`, `approval`, `memory_event` (their cascades are never
exercised) and assert `event` for `p1` is gone while the `task_id`-only event survives (SET NULL).

### 3.9 M17 / M18 — clamp and corrupt-DB branches

`ledger.bun.test.ts:310` (`limit: 10_000` → 12) passes with or without the clamp because only 12
events exist. `listTasks` `MAX_PAGE`/negative offset are likewise unreached.

```ts
test('listEvents clamps a huge limit to MAX_PAGE (500)', () => {
  const fx = fixture()
  for (let i = 0; i < 600; i++) fx.ledger.event.appendEvent({ actor: 'test', kind: `k${i}` })
  expect(fx.ledger.event.listEvents({ limit: 10_000 }).length).toBe(500)   // M17 breaks this
  expect(fx.ledger.event.listEvents().length).toBe(100)                    // default page
  close(fx.db)
})
```

M18 (`preMigrationBackup` corrupt guard) is unreachable from a valid DB: either corrupt a file
deliberately or delete the branch and document it. Untested is acceptable; claimed-as-covered is not.

---

## 4. Acceptance vs `RND/03-RENCANA.md` §7 (lines 148-181)

| Item | Status in the two files | Reality (measured) |
|---|---|---|
| Migration idempotent on a **copy of a real DB** | **MISSING** (`migration:54-76` only migrates fresh DBs; second call checks only the return value) | Works, verified by probe: populate → `copyFileSync` → `openLedgerDb(copy)` → `version=1, projects=1, memories=1, fts=1` |
| Crash injection leaves no half task/event | **MISSING** (`ledger:254-280` throws inside `tx`, no process death) | Works: SIGKILL mid-`BEGIN IMMEDIATE` → `task 0, event 0, user_version 1`, committed `project` row survives |
| Stale fence rejected | Covered on 2 of 4 transitions; named test passes with guard removed (M3) | SQL predicate is the real guard; error precedence untested |
| Depth 3 rejected | Covered twice (`migration:151-161`, `ledger:120`) | Works, but surfaces raw `SQLiteError`, not `LedgerError` |
| Task + event rollback together | Covered well (`ledger:254-280`) | M5/M11 confirm both rollback layers are real |
| **Workspace delete cascades project/agent/task/run, memory survives** | **NOT MET — substituted with `deleteProject`** (`ledger:316-349`) | Ledger has no `workspace` table/FK; `project.workspace_id` is plain `UNIQUE` text. Deleting the workspace row leaves `projectRows=1, agentRows=1, projectFkToWorkspace=0`. `Db.delete` (`db.ts:92`) never calls the ledger. **Design decision needed** |
| Backup before destructive migration | **MISSING and unimplemented**: `preMigrationBackup` has **no caller in `src/`**; `migration:184-212` invokes it by hand | `migrate()`/`openLedgerDb()` never back up. The test gives false confidence that migration is protected |

Outside these two files: **the ledger is not wired into the app at all** — nothing outside
`src/server/ledger/` imports `openLedgerDb`/`createLedger`. P2 is a tested library, not a running
feature, so "idempotent migration on a real DB" cannot be shown end-to-end yet.

### 4.1 Suggested acceptance tests

```ts
// imports: copyFileSync; helpers: tmpPath, version, close, run, expectThrow
test('migrate is a no-op on a populated copy of a real ledger file', () => {
  const src = tmpPath()
  const db = openLedgerDb(src)
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  run(db, "INSERT INTO memory (id, key, title, body, created_at, updated_at) VALUES ('m1','m1','alpha','fox',1,1)")
  close(db)
  const dst = tmpPath()
  copyFileSync(src, dst)
  const copy = openLedgerDb(dst)
  expect(version(copy)).toBe(LATEST_VERSION)
  expect(Number(q(copy, 'SELECT count(*) AS c FROM project').get()?.['c'])).toBe(1)
  expect(q(copy, 'SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?').all('alpha').length).toBe(1)
  expect(migrate(copy)).toBe(LATEST_VERSION)
  close(copy)
})

test('SIGKILL mid-transaction leaves no half task or event', () => {
  const path = tmpPath()
  const seed = openLedgerDb(path)
  run(seed, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  close(seed)
  const script = `
    const { Database } = require('bun:sqlite')
    const db = new Database(${JSON.stringify(path)})
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('BEGIN IMMEDIATE')
    db.exec("INSERT INTO task (id, project_id, spec, status, created_at, updated_at) VALUES ('t1','p1','s','leased',1,1)")
    db.exec("INSERT INTO event (ts, project_id, task_id, actor, kind) VALUES (1,'p1','t1','system','task.leased')")
    process.kill(process.pid, 'SIGKILL')
  `
  const res = spawnSync('bun', ['-e', script])
  expect(res.signal).toBe('SIGKILL')
  const db = openLedgerDb(path)
  expect(Number(q(db, 'SELECT count(*) AS c FROM task').get()?.['c'])).toBe(0)
  expect(Number(q(db, 'SELECT count(*) AS c FROM event').get()?.['c'])).toBe(0)
  expect(Number(q(db, 'SELECT count(*) AS c FROM project').get()?.['c'])).toBe(1)
  close(db)
})
```

**Workspace delete** cannot be a ledger test until the design is chosen: (a) FK
`project.workspace_id → workspace` with `ON DELETE CASCADE` (conflicts with the "standalone ledger
file" note at `ledgerSchema.ts:9-15`), or (b) `Db.delete` calls
`ledger.deleteProjectsByWorkspace(workspaceId)` in one transaction. Either way test it in
`db.bun.test.ts`/`workspacesApi.bun.test.ts` and assert memory survives with `project_id NULL`.

---

## 5. Vacuous / tautological assertions

| Site | Assertion | Problem |
|---|---|---|
| `migration:65` | `expect(migrate(db)).toBe(LATEST_VERSION)` | passes if migrations re-run (M14) |
| `migration:95` | `expect(version(db)).toBe(future)` | re-asserts the value the test itself wrote |
| `migration:214-217` | `MIGRATIONS.length === 1` and `MIGRATIONS[0].version === LATEST_VERSION` | `LATEST_VERSION` is derived from `MIGRATIONS`; `1 === max(1)` tautology. Use `expect(LATEST_VERSION).toBe(1)` |
| `ledger:310` | `limit: 10_000` → 12 | cannot distinguish clamped from unclamped (M17) |
| `ledger:198` | `alive.join(',').toContain(last)` | `length === 3` already covers it |
| `ledger:334-336` | counts for 7 of 13 tables | omits `decision`, `approval`, `memory_event`, `event` count, and any second project |

`migration:67-69` is a real check but omits `PRAGMA synchronous` (`NORMAL = 1`, required by §7):
add `expect(Number(q(db, 'PRAGMA synchronous').get()?.['synchronous'])).toBe(1)`. No test covers
`openLedgerDb('')` either (skips WAL, still migrates).

---

## 6. Missing boundary cases

1. **`max_attempts` unenforced** at `ff6daa0`: probe leased a `maxAttempts: 1` task three times
   (`attempt: 3`). The live tree adds a cap; assert the boundary and that the row is not mutated.
2. **`idem_key` uniqueness was global**, not per project; test both directions plus `idem_key = ''`.
3. **Terminal transitions**: `reopenTask` from `verified`/`claimed_done`, second `verifyTask`,
   `leaseTask` on `cancelled`/`blocked`/missing — untested.
4. **Duplicate `project.workspace_id`** throws raw `SQLiteError`; contract is accidental.
5. **FK off on bare `Database`**: `migrate()` does not enable `foreign_keys` (probe: `fk 0`), so a
   cascade test on a raw connection silently passes; always use `openLedgerDb`.
6. **`listEvents` default page (100)**, `afterSeq` + filters, `listTasks` clamps.
7. **`setLockEpoch` negative/non-integer** (`ledger.ts:140-142`) untested; `jsonOf` failure only
   tested via `claimDone.evidence`.
8. **VACUUM INTO quote escaping** (`migration.ts:88`) untested.

---

## 7. Explicitly checked and clean

- **No mock-only tests**: both files drive real `bun:sqlite` (memory and file), real migrations,
  real triggers. The clock is injected but always cross-checked against stored DB values.
- **No swallowed errors**: both `expectThrow` helpers fail loudly when nothing throws
  (`migration:37`, `ledger:45`); the empty production `catch { ROLLBACK }` is justified and M5/M11
  prove the path runs.
- **No try/catch around assertions**, no `if (x) expect(...)` guards.
- `ledger:254-280` (atomicity) genuinely exercises both rollback layers and is the strongest test
  in the two files.

---

## 8. Priorities

**Blocker for §7 acceptance**
1. Workspace-delete cascade does not exist — decide FK vs application hook, then integrate + test.
2. `preMigrationBackup` is never called before migration — wire it and test the ordering.
3. Eager-lock assertions (M1/M2) — currently the suite cannot detect a regression to `BEGIN`.
4. Crash-injection and real-copy idempotency tests.
5. Assert `suspect`/`renewed`/`reopened`/`failed` events (half the state machine's audit is unverified).

**High**
6. Second-project isolation + `decision`/`approval`/`memory_event` cascades (M26).
7. Typed guards: `FAILABLE` (M16), fence precedence (M3), claimDone matrix (M4).
8. `json_valid` boundaries (M15); real-volume `MAX_PAGE` clamp (M17).
9. No-re-run migration test (M14).

**Medium**
10. `PRAGMA synchronous`, empty-path `openLedgerDb`, `listTasks` clamps, `setLockEpoch`
    validation, `jsonOf` labels, verify-twice / reopen-terminal boundaries.
11. Fix the Bun gate glob so `src/server/ledger/*.bun.test.ts` actually runs.

**Low**
12. M12/M13: comment that the SQL predicate is the real guard.
13. M18: test corruption deliberately or drop the branch.

**Live-tree note.** The concurrent session is adding behaviour these tests do not pin (attempt cap,
per-project idem uniqueness, `StaleLeaseError`, pagination clamps, extra indexes, migration-list
validation, backup-in-transaction guard). Each is a new contract needing a test in the same
commit; re-run this mutation matrix against the new implementation before P2 is called done.

---

**Disclaimer.** Static review + mutation/probe runs pinned to `ff6daa0`. Runtime edges outside this
matrix (permissions, disk-full during `VACUUM INTO`, SQLite version drift) are not covered.
