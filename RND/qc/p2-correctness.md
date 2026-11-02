# QC review — P2 ledger correctness vs `03-RENCANA.md` §7

Branch `feature/agent-pusat-p2` @ `ff6daa0`, clean tree, repo `/Users/bip/Documents/spawn/webterm`.
Scope: `src/server/ledger/{migration,ledgerSchema,ledger,ledgerCore,ledgerModel,ledgerTask,ledgerTaskCreate,ledgerTaskShared,ledgerEvent}.ts`.

Read-only review. No source, test, or config under `src/` was modified; only this report was
written. Probes live outside the repo in `$JCODE_SCRATCH_DIR/qc/`
(`/tmp/st/qc/probe{1,2,3}.ts` -> `probe.ts`, `probe2.ts`, `probe3.ts`).

Verification run:

```
TMPDIR=/tmp/st bun test src/server/ledger
# 22 pass / 0 fail, 180 expect() calls
npm run typecheck
# clean
```

Probes exercise the real `openLedgerDb` / `migrate` / `preMigrationBackup` / `createLedger`
against file and `:memory:` databases. Nothing is mocked.

---

## Verdict

The **transaction plumbing is correct**. `BEGIN IMMEDIATE`, nested-join, in-band `user_version`,
task+event atomicity, and rollback-on-error all hold under probes, including crash injection
(throw inside the caller's `tx` after a partial write) and a forced failure at event emit.
SQL injection is not reachable: status/order fragments are constant strings behind an allowlist,
`LIMIT`/`OFFSET` are bound parameters, and `VACUUM INTO` doubles quotes (probed with a path that
contains `'`). Stale fences are rejected on every transition that takes one.

The **state machine has three real holes**, and §7 has one **whole acceptance area that is
schema-only**:

* `max_attempts` is never read anywhere, so a task can be leased forever (probe: `attempt=5`
  with `maxAttempts=2`).
* `claimDone` does not check the lease is still alive or owned by the caller, so an expired
  zombie can complete a task.
* FK enforcement is not established by `createLedger`, only by `openLedgerDb`; Bun's default is
  `foreign_keys=0`, and `deleteProject` then returns `true` while leaving every child row behind.
* usage/run, the reaper sweep, budget cap, cancel/block writers, and the workspace-delete cascade
  required by §7 do not exist yet (DDL only / nothing at all).

Details, severities, and minimal fixes below.

---

## High

### H1 — `max_attempts` is dead schema: tasks can be leased indefinitely
`src/server/ledger/ledgerTask.ts:18-52` (`leaseTask`), `ledgerSchema.ts:52`.

`attempt = attempt + 1` is written on every lease, and `max_attempts` is stored and returned,
but no code path ever compares them. `grep -n max_attempts` matches only the DDL, the serializer,
`createTask`'s validation, and the `UPDATE`. `LEASEABLE` (`ledgerTaskShared.ts:9`) happily re-leases
a task whose `attempt` already exceeds the cap, and there is no "attempts exhausted" transition to
`failed`.

Probe (`probe.ts` §2), `maxAttempts: 2`:

```
round 0: attempt=1 fence=1   round 1: attempt=2 fence=2
round 2: attempt=3 fence=3   round 3: attempt=4 fence=4   round 4: attempt=5 fence=5
final: status=suspect attempt=5 maxAttempts=2
```

Impact: the P3 "cap" gate and §7's `attempt/max_attempts` contract cannot be enforced upstream
because the ledger never refuses; a permanently broken task burns tokens forever.

Minimal fix: in `leaseTask`, after `if (!LEASEABLE.includes(task.status)) return null`, add
`if (task.attempt >= task.maxAttempts) return null` (or throw a typed `AttemptsExhaustedError`),
and let the reaper/scheduler move exhausted `suspect` rows to `failed` with an event. Add a test:
`maxAttempts: 1`, lease -> expire -> lease must not produce `attempt: 2`.

### H2 — `claimDone` accepts a dead lease from any actor
`src/server/ledger/ledgerTask.ts:118-147`.

Guard is only `fence = ? AND status = 'leased'`. It does not check `lease_owner = ?` nor
`lease_expires > now`. Fence only changes on lease/reopen, so between lease expiry and the reaper
sweep the fence is unchanged and the guard passes. Probe (`probe.ts` §3): lease to `w-1` with
`ttlMs: 10`, advance 5000 ms, then `claimDone('t', 1, ..., {actor:'w-2'})` returns
`status=claimed_done` — an actor that never held the lease, after the lease was already dead.

Impact: a zombie worker (or a stale session that was supposed to be revoked) can mark work done,
which is exactly the false-success class §7 and `06-BUG-RISK.md` G4 target. It also races the
reaper: whichever runs first decides whether the task is `claimed_done` or `suspect`.

Minimal fix: extend the guard to
`WHERE id = ? AND fence = ? AND status = 'leased' AND lease_owner = ? AND lease_expires IS NOT NULL AND lease_expires > ?`
and throw `StaleLeaseError`/`IllegalTransitionError` when it misses; add an optional
`owner` argument to `claimDone`/`verifyTask`/`failTask` so the actor is part of the assertion
instead of free-text `opts.actor`. Test: claim after expiry -> rejected.

### H3 — FK cascade silently no-ops when the ledger does not own the connection
`src/server/ledger/ledger.ts:102-104` (`createLedger` never sets or asserts a pragma),
`migration.ts:118` (`PRAGMA foreign_keys = ON` only in `openLedgerDb`),
`ledger.ts:217-225` (`deleteProject`), and the docstring at `ledger.ts:76`.

Bun's `new Database()` defaults to `foreign_keys = 0` (confirmed: probe §4 prints `foreign_keys= 0`).
`createLedger` accepts any `Database`, so the natural future wiring — reuse the existing app
connection from `openDb()` (`src/server/db.ts:8-22`, which sets no pragmas) — produces a ledger
where every `REFERENCES` clause is decorative:

```
4. foreign_keys= 0  deleteProject returned true
   agents left 1  tasks left 1
```

`deleteProject` returns `true` and leaves agent/task/run/event/usage rows orphaned, and the
`deleteProject` docstring ("FK cascades remove agents/tasks/runs/...") is then false.

Impact: silent partial deletes; violates §7 acceptance "workspace delete cascade
project/agent/task/run, memory tetap".

Minimal fix: in `createLedger`, assert and repair at hand-off:
`db.exec('PRAGMA foreign_keys = ON')` plus a hard check that `PRAGMA foreign_keys` reads back `1`
(throw otherwise, since the pragma is a no-op inside a transaction), and set `busy_timeout`
there too — the repository is not usable without them. Alternatively expose
`attachLedger(appDb)` as the only public entry point and keep `createLedger` internal. Test: open a
raw `Database`, `createLedger`, create project+task+agent, `deleteProject`, expect zero child rows.

### H4 — §7 acceptance items that are DDL-only or absent
Not a code defect, but §7 sign-off cannot pass as-is. Each item below is listed in §7 (or its
acceptance) and has no implementation in this branch:

| §7 requirement | State |
|---|---|
| "Usage/run: pindahkan ke P2 ... bucket terpisah, `provider_response_id` unik, unknown != 0, hard budget cap lokal" | `run`/`usage`/`budget` tables exist (`ledgerSchema.ts:58-114,124-132`); **no repository writes or reads them at all**. `provider_response_id UNIQUE` is DDL only, `price_known` never set, no cap check. |
| "Scheduler ... reaper mengubah lease kedaluwarsa menjadi `suspect`, revoke sesi, requeue dengan fence baru" | Only per-id `releaseToSuspect`; **no sweep query** (`idx_task_lease_expires` is created at `ledgerSchema.ts:176` but nothing uses it), no scheduler, no session revoke, no wake field. |
| "workspace delete cascade project/agent/task/run, memory tetap" | `project` has no FK to `workspace` (deliberate, `ledgerSchema.ts:9-14`) and no `deleteProjectsForWorkspace`; `WorkspaceStore.delete` (`db.ts:92`) does not touch the ledger. |
| Status list includes `blocked`, `cancelled` | No writer exists. `reopenTask` accepts `blocked`/`cancelled` (`ledgerTaskShared.ts:10`) but nothing can ever set them, so a running task cannot be cancelled. |
| "Aksi berisiko: intent -> aksi -> outcome. `idem_key` di level aksi" | `idem_key` exists only on `task` (`ledgerSchema.ts:53`); no action-level idempotency. |
| §13 P2 metrics | No counters/logging anywhere in `src/server/ledger/` (migration ms, SQLITE_BUSY, lease expiry, suspect count, stale-fence reject). |

Follow-up (P2.1): add `run`/`usage` repositories with `provider_response_id` idempotency and cap
enforcement, a reaper sweep `SELECT id FROM task WHERE status='leased' AND lease_expires <= ?`,
`cancelTask`/`blockTask`, and `deleteProjectsForWorkspace`. Until then `RND/README.md` §"Gates P2"
should not claim P2 §7 is satisfied.

---

## Medium

### M1 — `idem_key` is globally unique, and duplicates throw instead of returning the winner
`src/server/ledger/ledgerSchema.ts:53` (`idem_key TEXT UNIQUE`), `ledgerTaskCreate.ts:42-49`.

Two independent problems:

1. The uniqueness domain is the whole table, not the project or the action. Probe (`probe.ts` §11):
   a key `k` created under `p1` makes the same key unusable under `p2` —
   `duplicate task idem_key k (existing task …)`. Any per-project idempotency scheme
   (`"create:task:1"`) collides across projects.
2. A duplicate raises `DuplicateIdemKeyError` rather than returning the existing task. For §7's
   "external side effect at-least-once + idempotent", the caller now has to catch a typed error
   and re-query by key — which the API does not offer (`getTask` is by id only). The natural
   retry path is closed.

The error path itself is clean: the probe confirms one task and one event remain, so there is no
partial insert, and the message-sniffing on `'task.idem_key'` (`ledgerTaskCreate.ts:44`) is
correct because the PK violation has a different message.

Minimal fix: `UNIQUE (project_id, idem_key)` (drop the column-level UNIQUE, add a composite unique
index) and resolve duplicates by returning the existing row behind an explicit
`onDuplicateIdemKey: 'throw' | 'return'` option (default `'return'` for action retries); add
`getTaskByIdemKey(projectId, key)`. If `'throw'` stays the default, at least add the lookup so
callers can recover.

### M2 — `agent.depth` is caller-supplied, and parent links cross project boundaries
`src/server/ledger/ledgerSchema.ts:33-36`, `ledger.ts:157-176` (`createAgent`),
`ledger.ts:106-129` / `ledgerTaskCreate.ts:14-61` (parents).

The `CHECK (depth BETWEEN 0 AND 2)` is real and tested, but nothing derives `depth` from the
parent, so the cap is advisory. Probe (`probe2.ts` §4):

```
4.  child of depth-0 root claims depth 0
4b. agent in p2 with parent from p1 accepted
4c. task in p2 with parent in p1 accepted
```

There are no FKs tying `child.project_id` to `parent.project_id`, so a tree can be built from
mixed projects, and depth can be forged to 0 at will. §7 says "depth 3 ditolak"; the DB rejects
the literal value but not the invariant.

Minimal fix: in `createAgent`, load the parent (when `parentAgentId` is set) inside the same
transaction, require `parent.projectId === input.projectId`, and compute
`depth = parent.depth + 1` instead of trusting the caller (keep the CHECK as defence in depth).
Same cheap check for `task.parentId`/`task.agentId` project membership.

### M3 — events can be filed under the wrong project; dangling refs surface as raw SQLite errors
`src/server/ledger/ledgerEvent.ts:22-45`, `ledgerEvent.ts:48-69`.

`appendEvent` writes `project_id` and `task_id` as given. Probe (`probe.ts` §5) succeeds with a
`p2` event that points at a `p1` task:

```
5. event cross project accepted: projectId= p2 taskId= t1
5b. dangling taskId -> Error  FOREIGN KEY constraint failed
```

Two issues: (a) `listEvents({projectId})` then returns audit rows for another project's work,
which breaks the audit invariant §7 relies on ("Event log adalah audit"); (b) an unknown
`projectId`/`taskId` produces a bare `Error` ("FOREIGN KEY constraint failed") rather than a
`LedgerError` with the entity and id, which violates Rule 11's context requirement for the one
place a caller-error is most likely.

Minimal fix: when both are supplied, verify they agree
(`SELECT 1 FROM task WHERE id=? AND project_id=?`), and when a parent id is supplied but missing,
throw `LedgerNotFoundError('task', id)` before the insert. Wrap the insert's FK failure into a
`LedgerError` mentioning `taskId`/`projectId`.

### M4 — `listTasks` turns a bad `limit`/`offset` into a raw SQLite error
`src/server/ledger/ledgerTaskCreate.ts:77-78`.

```ts
const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(opts.limit ?? DEFAULT_PAGE)))
```

`Math.trunc(NaN)` is `NaN`, `Math.max(1, NaN)` is `NaN`, so a non-numeric limit is bound as
`NaN`. Probe (`probe.ts` §6b): `limit: NaN` and `limit: 'abc'` both throw
`datatype mismatch` from SQLite. `listEvents` handles the same input correctly with a typed
`LedgerError` (`ledgerEvent.ts:71-77`), so the two list APIs disagree on the same input class.

Minimal fix: share `clampLimit` from `ledgerEvent.ts` (move it to `ledgerTaskShared.ts`), or
inline the same `Number.isFinite` guard for limit and offset.

### M5 — indexes do not match the two real list queries
`src/server/ledger/ledgerSchema.ts:175-180`, `ledgerEvent.ts:64-68`, `ledgerTaskCreate.ts:81-87`.

Probe (`probe2.ts` §8b-8d) query plans:

```
event WHERE task_id=? ORDER BY seq      -> SCAN event                     (no index)
task  WHERE project_id=? ORDER BY ...   -> SCAN task + USE TEMP B-TREE    (no index)
task  WHERE project_id=? AND status=?   -> SEARCH task USING idx_task_status_project
```

`idx_event_run_seq` only helps run-scoped reads, and `idx_task_status_project` does not help the
`status`-less call (the common "all tasks of this project" page), which is a full scan plus a sort
per page. §7 says index only what has a real query; both of these are real queries in this module.

Minimal fix: add `CREATE INDEX idx_event_task_seq ON event(task_id, seq)`,
`CREATE INDEX idx_event_project_seq ON event(project_id, seq)`, and
`CREATE INDEX idx_task_project_created ON task(project_id, created_at)`. Still v1-only, no
`user_version` bump needed (same migration, idempotent DDL).

---

## Low

| # | Finding | Location | Minimal fix |
|---|---|---|---|
| L1 | `StaleFenceError(id, task.fence, task.fence + 1)` fabricates `actual`; the constructor is `(taskId, expected, actual)` | `ledgerTask.ts:47` | Re-read the row and pass the real fence, or throw a distinct `LeaseConflictError` — the current message would lie. Unreachable today (inside `BEGIN IMMEDIATE`), so it is dead-but-wrong code. |
| L2 | `preMigrationBackup` inside an open transaction throws the raw `cannot VACUUM from within a transaction` after already running `integrity_check` | `migration.ts:69-88` | Assert `!inTransaction` first and throw `LedgerError('preMigrationBackup: cannot run inside a transaction')`; reuse `inTransaction` from `ledgerCore.ts`. |
| L3 | `openLedgerDb` ignores the value returned by `PRAGMA journal_mode = WAL`; on a filesystem without WAL support SQLite silently stays in `delete` mode | `migration.ts:120` | Read back `PRAGMA journal_mode` and throw or warn when it is not `wal`. (`:memory:` and `''` are already skipped correctly — probed.) |
| L4 | `migrate` captures `current` once and never updates it, so a list containing two entries with the same version applies both; no duplicate/monotonic validation | `migration.ts:39,46-47` | Track a running `applied` version inside the loop (or re-read `user_version` per iteration) and throw on duplicate or non-increasing versions. Probe §5: a duplicated v1 ran twice. |
| L5 | `writeUserVersion` truncates anything, including `NaN`/negative; `Migration.version` is not validated | `migration.ts:29-32` | Validate `Number.isInteger(version) && version > 0` before `BEGIN`. |
| L6 | `renewLease(id, owner, ttl, now)` with a caller-supplied past `now` writes an already-expired lease, leaving a zombie `leased` row until the reaper | `ledgerTask.ts:55-88` | Reject `now < existing lease start`/`now < ctx.now()` with a `LedgerError`, or clamp `expires = Math.max(at, task.leaseExpires ?? 0) + ttlMs`. Probe §12b: `renewLease(..., 5, 0)` sets `leaseExpires = 5` while the DB clock is 1000. |
| L7 | `createProject`/`createAgent` accept empty `workspaceId`/`name`/`path`, and the second empty `workspaceId` then fails with a raw `UNIQUE constraint failed` | `ledger.ts:106-129,157-176` | Use `requireText` (already in `ledgerCore.ts:172`) for these fields and map the UNIQUE violation to a typed `LedgerError`. Probe §B/B2. |
| L8 | `idemKey: ''` is treated as a real key, so the second empty-key task collides | `ledgerTaskCreate.ts:38,44` | Treat `''` as absent (`input.idemKey || null`) or reject it. Probe §A. |
| L9 | `verifyTask` and `failTask` use `COALESCE(?, evidence_json)`, so evidence can never be cleared/overwritten with an explicit `null` | `ledgerTask.ts:164,198` | Document it, or accept `evidence: undefined` vs `null` distinctly. Probe §11: `verifyTask('t', 1, null)` keeps the claim evidence. |
| L10 | `listProjects()` is unpaginated | `ledger.ts:134-138` | Add `{limit, offset}`; low today (few projects) but Rule 13 is unconditional for list endpoints. |
| L11 | `deleteProject` returns `true` after `DELETE` without asserting child rows are gone | `ledger.ts:217-225` | Covered by H3: assert `PRAGMA foreign_keys` at `createLedger`, optionally post-check child counts. |

---

## Verified correct (with evidence)

These were probed or read closely, and are **not** findings — listed so the fix work does not
re-open them:

1. **Migration transaction shape.** One `BEGIN IMMEDIATE` per step, `user_version` bumped inside
   it, `COMMIT`/`ROLLBACK` + wrapped `throw` (`migration.ts:46-64`). Probe §14: a migration that
   creates a table then throws leaves `user_version = 0` **and no table** — DDL and version roll
   back together.
2. **Newer `user_version` throws with both numbers** (`migration.ts:41-45`); probe §8b.
   `PRAGMA user_version` is transactional, so the throw cannot be half-applied.
3. **Nested transactions join, and a single failure rolls back the whole unit.**
   `db.inTransaction` exists in Bun (`true` inside both `BEGIN IMMEDIATE` and `db.transaction()` —
   probe2 §1); outer+inner writes roll back together (probe §1b), and `l.tx(() => { lease(); throw })`
   leaves `status=pending, fence=0` and no event (probe §16).
4. **Task + event atomicity on every transition**, including a failure at event emit:
   `createTask({actor: ''})` throws `event.actor must be a non-empty string` and leaves 0 tasks,
   0 events (probe2 §3). `claimDone` with a circular payload behaves the same (existing test).
5. **Fence monotonicity**: `lease` -> `fence+1`, `reopen` -> `fence+1`, `suspect` keeps the fence
   but clears the owner/expiry so old writers fail on `status`, not just fence. Stale-fence
   rejection after re-lease is covered by an existing test and by probe §13.
6. **Concurrency guards are in-band.** Every transition re-reads inside `BEGIN IMMEDIATE` and
   asserts `changes === 1` with `fence`/`status`/`lease_owner` in the `WHERE`. Double lease while
   live returns `null` (probe §12); `renewLease` by a non-owner returns `null`.
7. **Lease boundary is consistent**: at `now === lease_expires`, `renewLease` fails while
   `releaseToSuspect` succeeds (probe2 §9) — "alive" means `now < expires` everywhere.
8. **No SQL injection.** `listTasks` status goes through `TASK_STATUSES` before being used in the
   fragment (`ledgerTaskCreate.ts:74-80`; probe §6d rejects `pending' OR 1=1 --` as unknown
   status), `LIMIT/OFFSET` are bound, `listEvents` fragments are constants, and `VACUUM INTO`
   escapes `'` — probed with a DB path containing an apostrophe (probe §9, backup created and
   verified).
9. **Pagination bounds exist** on both list APIs (`DEFAULT_PAGE`/`MAX_PAGE` 200/1000 and 100/500),
   `listEvents` uses an `afterSeq` cursor.
10. **Pragmas**: FK enforced when opened via `openLedgerDb` (existing test), WAL applied for file
    DBs and skipped for `:memory:` and `''` (probe §10 shows `journal_mode = memory` for `''`),
    `busy_timeout = 5000`, `synchronous = NORMAL`.
11. **`deleteProject` + memory**: memory rows survive with `project_id = NULL`, and the
    `memory_au` FTS trigger keeps the index consistent — probe §10 after the delete shows 1 memory
    row, a working FTS match, and `INSERT INTO memory_fts(memory_fts) VALUES('integrity-check')`
    passing. Duplicate `idem_key` also leaves exactly one task and one event (probe §11b).
12. **Schema/serializer drift**: every `task`, `agent`, `project`, `event` column in the DDL has a
    reader in `ledgerCore.ts:103-170`; insert column lists omit only defaulted columns
    (`status`, `lock_epoch`, `heartbeat_at`), which read back correctly.
13. **File health**: largest file is `ledgerTask.ts` at 234 lines, tests 380 — inside the
    service/test budgets.

---

## Test-coverage gaps (each maps to a finding)

`ledger.bun.test.ts` has 12 tests and `migration.bun.test.ts` 10; none of these cases exist:

* `max_attempts` exhausted -> no test anywhere (H1).
* `claimDone` after expiry, and `claimDone` by a non-owner (H2).
* `createLedger` on a connection without `foreign_keys` -> cascade (H3).
* `idem_key` reuse across two projects (M1).
* cross-project `parentId`/`parentAgentId` and forged `depth` (M2).
* `appendEvent` with cross-project or dangling `taskId` (M3).
* `listTasks` with `NaN`/string limit (M4).
* `renewLease` with a caller-supplied past `now` (L6).
* migration with duplicate version numbers (L4), and `preMigrationBackup` inside a transaction (L2).

§7's acceptance "migrasi idempoten pada salinan DB nyata" also has no test that copies a real
`workspace` DB and migrates the copy; the current idempotency test only re-runs `migrate` on a DB
this build created.

---

## Speculative (not confirmed as defects — flagging for intent check)

* **S1.** `leaseTask` allows `suspect -> leased` with no acknowledgement of *why* the previous
  attempt died (`ledgerTaskShared.ts:9`). §7 says the reaper must not go straight to `pending`,
  which this honours, but nothing records the suspect reason at the task row before re-lease; the
  reason lives only in the `task.suspect` event. If P3 needs "verify the failure label before
  retry", the row is not enough.
* **S2.** `tx()` joins *any* ambient transaction, including an app-level `db.transaction()`
  (DEFERRED). Probe2 §2 shows the lease still works, but under real multi-process concurrency a
  deferred read-then-upgrade can end as `SQLITE_BUSY` after the 5 s timeout — surfaced as a raw
  `Error`, with no retry and no metric (§13 lists `SQLITE_BUSY` as a P2 metric). If the ledger is
  later wired onto the shared app connection, prefer rejecting non-`IMMEDIATE` ambient
  transactions rather than silently inheriting them.
* **S3.** The `ledgerSchema.ts:9-14` comment justifies having no FK to `workspace` so the ledger
  opens standalone. That is reasonable, but it moves the "workspace delete" acceptance criterion
  entirely into caller code that does not exist yet (see H4). Worth an explicit task so it is not
  forgotten when the ledger is wired.
* **S4.** `attempt` is not reset by `reopenTask`, so a human "reopen" of a task that exhausted its
  attempts will be blocked by the H1 fix unless reopening also raises `max_attempts` or resets
  `attempt`. Decide the semantics before implementing H1.
