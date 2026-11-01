# QC — central autonomy soak harness

Branch `feature/agent-pusat-p3`, repo `/Users/bip/Documents/spawn/webterm`, bun 1.4.2, node 26.7.0
(tsc 7.0.2). Scope: scheduler-level soak of `src/server/central/centralAutonomy.ts` only.

Status: **harness + smoke evidence shipped; the real 2 projects × 2 weeks wall-clock soak is still
user/environment work** (it needs two live projects, a real server that stays up for two weeks, and
real worker runs). This report does not claim that gate is cleared — see §5.

Files:

- `scripts/soakCentralAutonomy.ts` (122 lines) — CLI + summary print.
- `scripts/soakCentralAutonomyModel.ts` (264 lines) — fake world + soak loop + invariants.
- `scripts/soakCentralAutonomyScenarios.ts` (124 lines) — bounded quarantine/reset/skip checks.
- `RND/qc/soak-harness.md` — this document.

The harness imports the real `createCentralAutonomy`; no production source was changed. The split
keeps every file under the repo's 300-line target and 500-line hard cap (the first draft was 505
lines in one file).

---

## 1. What the harness does

It constructs the **real** scheduler via `createCentralAutonomy(deps)` and replaces only the deps
with in-memory fakes:

| dep | fake behaviour |
|---|---|
| `projects()` | `--projects` fake rows, all `active` unless a pause window is open; row order is rotated each tick so the scheduler's first-pick alternates fairly (the real `ORDER BY id` order is arbitrary from the loop's point of view). |
| `plan(id)` | snapshot copy of `{status, version, items}`. |
| `run(id, item, expectedVersion)` | asserts project not `paused`, plan not terminal, item is `assigned`, and `expectedVersion` matches; then **marks the item `done`, appends a new `assigned` item, bumps the plan version**, so the loop never runs out of work. Every `--fail-every N`-th call returns `{ok:false, code:'fake_run_failed'}` and leaves the item `assigned` (like a rejected route call). |
| `audit()` | counted per `kind`. |

Both fake `run` and the loop are instrumented: the fake increments an in-flight counter (with a
microtask yield on every call and a `setTimeout(0)` every 64 runs, so a leaked concurrent run would
be observable), and the tick loop counts `run` calls per tick.

CLI (defaults in parentheses):

```
--cycles <n>       ticks (10000)
--projects <n>     fake projects (2)
--fail-every <n>   every n-th run fails, 0 = never (0)
--pause-every <n>  every n-th tick pauses one project for 5 ticks, 0 = never (0)
```

Exit codes: `0` all invariants held, `1` invariant violation (message names the tick), `2` bad args.

## 2. Invariants asserted

Continuous, during the soak (violation → exit 1):

1. **At most one item per tick** — fake `run` call delta is `<= 1` per `tick()`, and `delta === 1`
   exactly when `tick()` returned `{ran:true}`, `0` otherwise.
2. **No overlap** — two `tick()` promises started in the same turn must not both run; every 1000th
   tick is a deliberate concurrent probe (`Promise.all([tick(), tick()])`), and the in-flight
   counter must never exceed 1.
3. **No run for a paused project or terminal plan** — the fake `run` asserts it, and the loop
   additionally checks `result.projectId` against the pause windows (`--pause-every`) and against
   `plan.status in {completed, abandoned}`.
4. **Failure budget** — the loop tracks `autonomy.failures(projectId)`; a project at/over 3 is
   quarantined. Because `--fail-every 17` interleaves isolated failures (never 3 in a row), the
   budget is proven in dedicated bounded scenarios after the soak (see §3).
5. **Optimistic version** — every `run` receives the version from the snapshot it was selected
   from; a mismatch fails the harness.

Post-soak scenarios (each its own `createCentralAutonomy`):

| scenario | assertion |
|---|---|
| quarantine after 3 | always-failing run → exactly 3 runs in 10 ticks, `failures === 3`, exactly one `autonomy.budget_exhausted` audit, then a status flip (pause→active) resumes the loop |
| success resets budget | 2 failures then a success → `failures === 0`, 3 runs total |
| paused + terminal | paused project, `completed` plan and `abandoned` plan → 5 ticks, 0 runs |

## 3. Smoke evidence

Exact command (required run):

```
$ bun scripts/soakCentralAutonomy.ts --cycles 10000 --fail-every 17 --pause-every 500
--- soak: central autonomy (in-memory fake projects) ---
config       cycles=10000 projects=2 failEvery=17 pauseEvery=500
ticks        10000 (ran=10000 skipped=0)
runs         10011 (failures=588)
concurrency  max=1 maxRunsPerTick=1
overlap      probes=11 rejected=11
paused       ticks_with_paused_project=95 quarantined_observations=0
fake_plans   items_retained=9425 (harness data, see docs)
audit        autonomy.run=10011
heap         before=0.66 MB after=2.84 MB delta=2.18 MB
wall         910.2 ms (91.0 us/tick)
--- invariant scenarios ---
ok  failure-budget quarantine after 3 + status-flip reset :: 3 runs, 1 budget_exhausted audit, resumed after flip
ok  success resets budget :: 2 failures then success -> failures 0
ok  paused project and terminal plans are never run :: 5 ticks, 0 runs
RESULT: PASS
exit=0
```

10 000 ticks is fast (<1 s), so no downscaling was needed. `runs=10011` is 10 000 soak ticks plus
11 concurrency probes (one probe hits both ticks, one runs); failures `588 ≈ 10011/17`.

Other modes were run to check the knobs:

```
--cycles 2000                                             PASS  (88.7 ms)
--cycles 500  --fail-every 0  --pause-every 50            PASS
--cycles 300  --fail-every 2  --pause-every 7 --projects 3 PASS
--cycles 50   --fail-every 1                              PASS  ran=4 skipped=46
                                                          audit autonomy.budget_exhausted=2
```

`--fail-every 1` is the interesting one: both projects hit 3 consecutive failures and are
quarantined after 4 successful selections, so 46 of 50 ticks return `no_eligible` — the
budget-exhaustion path observed in the soak loop, not only in the scenario check.

## 4. Typecheck

`tsconfig.json` has `"include": ["src"]`, so `scripts/` is **not** part of `npm run typecheck`
(`npx tsc --noEmit` → exit 0, unchanged). The entry script is checked explicitly, with the same
strict settings; tsc follows its imports, so all three harness files are covered:

```
$ npx tsc --ignoreConfig --noEmit --target ES2023 --module ESNext \
    --moduleResolution bundler --lib ES2023,DOM,DOM.Iterable \
    --strict --skipLibCheck --types node scripts/soakCentralAutonomy.ts
exit=0
```

(`--ignoreConfig` is required by tsc 7 when file arguments are passed with a `tsconfig.json`
present; it only suppresses config loading for this ad-hoc invocation.)

Why not add `scripts` to `tsconfig.json`'s `include`? `src/server/index.ts` and `scripts/embedDist.ts`
would then be typechecked under the Bun runtime without Bun type definitions, which is a separate
change with its own noise. If you want the harness in CI, add a dedicated `tsconfig.scripts.json`
rather than widening the app config.

## 5. What it proves, and what it does NOT prove

Proves (deterministic, in-memory, 10 000 ticks + probes):

- the tick guard serialises runs (`maxConcurrency=1`, all 11 overlap probes rejected);
- selection is one item per tick even under concurrent calls;
- paused projects and terminal plans are never run;
- consecutive failures quarantine a project at 3, `budget_exhausted` is audited once, an operator
  status flip clears the budget, and a success resets it;
- the loop survives 10 000 selections with a churning plan without stalling, and never throws
  across fake transient failures.

Does **NOT** prove (do not read this as the G6 soak):

- any real PTY/worker run, Claude invocation, worktree creation, or Telegram delivery;
- the real route (`orchestratorRunRoute`), ledger writes, plan-store version conflicts under real
  concurrency, or approval 409 handling — the harness fakes `run` entirely;
- timer behaviour: `start()`/`stop()`, the 30 s interval, drift, unref semantics, process restarts;
- wall-clock behaviour: 10 000 ticks take ~0.9 s, so nothing here exercises days of drift, clock
  jumps, SQLite growth, or credential/token expiry;
- memory-leak behaviour: `heapUsed` delta is dominated by the fake plan growing
  (`items_retained`), not by scheduler retention. Treat heap numbers as "no runaway", not as a
  leak test;
- the ≥80% verified-rate gate from `RND/06-BUG-RISK.md` G6 — that is a product metric, measured
  from task/run tables, not from scheduler ticks.

## 6. Runbook — the real 2 projects × 2 weeks soak

This is the part the harness cannot do; it needs a machine that stays up and two real projects.

### 6.1 Preconditions

```
WEBTERM_LEDGER=on                  # ledger must be on; shadow/off means autonomy will not boot
WEBTERM_ORCHESTRATOR_RUN=on        # run surface must be armed
WEBTERM_CENTRAL_AUTONOMY=on        # arms the loop
# WEBTERM_RUN_REQUIRE_APPROVAL: if on, autonomy gets 409 on unapproved items by design.
# Leave it off for the soak, or pre-approve the work queue.
```

Confirm from the boot log line — autonomy is fail-closed and logs why it did not start:

```
central autonomy: on (every 30000ms, max 3 consecutive failures per project)
```

Two projects, each with a plan whose `assigned` items are runnable; keep a small backlog so the
queue does not starve, and let workers append work as items complete.

### 6.2 Metrics to collect (checkpoint every day, and at day 7 / day 14)

All of these live in the ledger DB, `$WEBTERM_DATA_DIR/ledger.db`
(default `~/.webterm-server/ledger.db`), table `event` (actor `central`), plus `task`/`run`.
`event.ts` is epoch **milliseconds**.

```sql
-- runs per project per day, split ok/failed
SELECT project_id,
       date(ts / 1000, 'unixepoch', 'localtime') AS day,
       json_extract(payload_json, '$.ok') AS ok,
       count(*) AS n
FROM event
WHERE kind = 'autonomy.run'
GROUP BY 1, 2, 3 ORDER BY 2, 1;

-- quarantine events (must be rare; each one is an operator signal)
SELECT project_id, count(*) FROM event
WHERE kind = 'autonomy.budget_exhausted' GROUP BY 1;

-- scheduler read/route failures
SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, count(*)
FROM event WHERE kind = 'autonomy.tick_error' GROUP BY 1;

-- success ratio per project over the whole soak (target: no downward trend)
SELECT project_id,
       sum(json_extract(payload_json, '$.ok') = 1) AS ok,
       sum(json_extract(payload_json, '$.ok') = 0) AS failed
FROM event WHERE kind = 'autonomy.run' GROUP BY 1;

-- product gate: verified rate (G6 target >= 80%)
SELECT project_id,
       sum(status = 'verified') AS verified, count(*) AS tasks
FROM task GROUP BY 1;
```

Also record, per checkpoint: `~/.webterm-server/ledger.db` size (plus `-wal`), server RSS, and
whether the boot line is present after each restart.

### 6.3 Restart cadence

- Day 1–3: restart the server daily (deliberate) to exercise recovery and confirm the loop
  re-arms from the boot log.
- Day 4–14: restart once per week, or only on deploy.
- After every restart, run the `autonomy.run` query for the last 5 minutes and confirm ticks
  resume within one interval (30 s).

Known caveat: the failure budget is **in-memory** (`Map` in `createCentralAutonomy`), so a restart
clears a quarantine. A project stuck in a fail loop therefore gets 3 more attempts after every
restart. That is acceptable for the soak but belongs in the day-14 notes if it happens.

### 6.4 Log locations

- Server stdout/stderr (wherever the process is supervised: terminal, `systemd`, `launchd`,
  `pm2`) — boot line, `central autonomy: ...` warnings, HTTP logs.
- `$WEBTERM_DATA_DIR/ledger.db` → `event` — durable autonomy audit (`autonomy.run`,
  `autonomy.budget_exhausted`, `autonomy.tick_error`), the source of truth for the queries above.
- `$WEBTERM_DATA_DIR/webterm.db` — app DB (channels, etc.).
- Harness output is stdout only; it writes no files.

### 6.5 Stop criteria (abort the soak early and report)

- any `autonomy.tick_error` repeating for the same project;
- `autonomy.budget_exhausted` for the same project on two consecutive days;
- verified rate under 80% at day 7;
- ledger DB growth that is not explained by run/task rows (check `event` row count vs size);
- any worker run that the loop claims `ok` while the item never reaches `done`/`running` in the
  ledger (would mean the loop and the route disagree).
