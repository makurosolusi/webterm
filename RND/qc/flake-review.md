# QC: reliability / flakiness review (P0 branch)

Date: 2026-11-01 (UTC+08:00). Repo: /Users/bip/Documents/spawn/webterm, branch `feature/agent-pusat-p0`.
Read-only review: no source edits. Only this report plus scratch logs under `/tmp/st`.

## Important caveat: the tree moved during QC

HEAD at start: `b4e7f01` (26 files, P0 observation seam). During the run another session committed
`509a61f` and `b46a06a` and kept editing the working tree (13 modified files, +597/-112 at snapshot).

Evidence: vitest count went `1031 -> 1062` tests without any change from me, and the working-tree
fingerprint (`shasum` over all `src` files) changed three times mid-measurement:
`b6d0a59 -> 3aeddc5 -> a957ba7`.

So numbers below are labelled by tree state. The P0 flake findings are all in `src/server/*.bun.test.ts`,
which did not change test count (84) across that window, so the conclusions hold, but a re-run on a
frozen commit is still advisable before signing off.

## Environment

macOS aarch64, 24 users, 549 processes, load average 6.7 to 19.6 during the window,
swap used 6.0 GB of 7.0 GB free 1.1 GB, memory free 36 %. Login shell startup measured
`bash -lc 'echo hi'` = 0.58 to 0.72 s idle. Every `.bun.test.ts` case here spawns real login
shells through real PTYs, so the wall clock is on the critical path by design.

## Commands and results

### 1. Typecheck (`TMPDIR=/tmp/st npm run typecheck`)

| run | exit | wall |
| --- | ---- | ---- |
| 1 | 0 | 0.64 s |
| 2 | 0 | 0.49 s |
| final (tree b46a06a + dirty) | 0 | ~1.5 s |

TypeScript 7.0.2 native, 621 files in programme (202 under `src`). Confirmed the gate is not a no-op:
`npx tsc --noEmit --strict --ignoreConfig /tmp/st/bad.ts` fails with
`error TS2322: Type 'string' is not assignable to type 'number'`.

### 2. Vitest (`TMPDIR=/tmp/st npm test`)

| run | tree | files | tests | duration | result |
| --- | ---- | ----- | ----- | -------- | ------ |
| 1 | b4e7f01 | 77 | 1031 | 13.05 s (13.51 s) | pass |
| 2 | b4e7f01 | 77 | 1031 | 11.64 s (12.05 s) | pass |
| 3 | b46a06a+dirty | 77 | 1062 | 10.86 s | pass |
| 4 | b46a06a+dirty | 77 | 1062 | 10.72 s | pass |
| 5 | b46a06a+dirty | 77 | 1062 | 14.15 s | pass |
| A | b46a06a+dirty | 77 | 1062 | 15.36 s | pass |
| B | b46a06a+dirty | 77 | 1062 | 13.24 s | pass |

7/7 green, no flakes, no retries. Spread 10.7 to 15.4 s (1.44x), environment setup is 25 to 28 %
of it. Vitest spawns 77 isolated workers (~377 ms startup each, ~3.8 s total overhead).

Slowest suites (run 1 / run 2, so variance is visible):

| suite | run 1 | run 2 | note |
| --- | --- | --- | --- |
| `client/paneSplit.test.tsx` | 10.73 s | 8.98 s | 14 tests, single case 2272 -> 908 ms (2.5x) |
| `client/workspaceCommit.test.ts` | 6.23 s | 4.81 s | fixed sleeps vs 400 ms debounce |
| `client/terminalNodeMenu.test.tsx` | 5.20 s | 3.48 s | |
| `client/canvasContextMenu.test.tsx` | 3.82 s | 3.09 s | |
| `server/hooks.test.ts` | 2.48 s | 2.38 s | stable |

### 3. Bun-only suites (`TMPDIR=/tmp/st bun test src/server/*.bun.test.ts`)

84 tests, 12 files, 17 full runs: **15 green, 2 red**.

| run | duration | failures |
| --- | --- | --- |
| 1 | 14.56 s | 0 |
| 2 | 63.56 s | **8** |
| 3 | 15.35 s | 0 |
| 4 | 19.32 s | 0 |
| 5 | 22.79 s | 0 |
| 6 | 14.65 s | 0 |
| 7 | 14.08 s | 0 |
| 8 | 13.65 s | 0 |
| 9 | 15.76 s | 0 |
| 10 | 28.74 s | **1** |
| 11 | 15.37 s | 0 |
| 12 | 28.50 s | 0 |
| 13 | 27.26 s | 0 |
| 14 | 29.67 s | 0 |
| 15 | 13.85 s | 0 |
| final A (a957ba7) | 23.26 s | 0 |
| final B (a957ba7) | 13.93 s | 0 |

Durations cluster into two modes: ~14 s and ~28 s. Every red run is in the slow mode, and red runs
show 15 to 20 s *stalls inside a single test*, not uniform slowness. This is a latency burst in
process spawn, not a logic failure (see root cause below).

Per-file repetitions:

| target | runs | red | timing |
| --- | --- | --- | --- |
| `sessions.bun.test.ts` alone | 8 | **1** (6 tests) | 4.65 to 4.95 s green, 25.76 s red |
| `sessionsClose.bun.test.ts` alone | 6 | 0 | 0.63 to 0.84 s per flaky test |
| `sessionsClose + sessionsStale` | 5 | **2** | 2.0 s green, 6.84 s red |
| `ptyWinch.bun.test.ts` alone | 8 | 0 | 2 tests, 0.8 to 2 s |
| new P0 vitest files (9 files, 148 tests) | 8 | 0 | 5.27 to 5.88 s (1.12x spread) |

New P0 files covered by that loop: `workspaceCommit.test.ts`, `ws.test.ts`,
`terminalSession.test.ts`, `server/hooks.test.ts`, `server/nodeRegistry.test.ts`,
`server/outputLog.test.ts`, `server/subscribers.test.ts`, `server/sessionsFake.test.ts`,
`shared/workspace.test.ts`.

## Suspect tests (ranked)

### S1. `src/server/sessions.bun.test.ts` (P0) - real flake, highest impact

`pollFor()` (line 37) has a 3000 ms default and **returns silently on timeout** (`while (Date.now()
< deadline)` with no throw). The assertion that follows then fails with a misleading diff:

```
Expected to contain: "SCROLL_ONCE_9f3a"
Received: "printf 'SCROLL_ONCE_%s\\n' 9f3a\r\n"      // shell echoed input, output never arrived
```

Observed red: 1 of 8 solo runs, 6 of 20 tests in that run, each burning ~3.02 s:
`open on a live id ... subscribers`, `open with a cmd launches it through the login shell`,
`a missing wrapper degrades ...`, `a claude session carries its hook token ...`,
`a plain terminal gets no hook token at all`, `the scrollback limit drops old output ...` (10 s budget).

Mechanism: the test types into the shell before the login shell has finished starting. Normal spawn
plus rc is 0.6 to 0.7 s here, but in a burst it exceeds 3 s. The 3 s budget is the only thing
standing between this test and CI noise. When it fails mid-test the PTY is not closed (assertion
throws before `s.close`), so later tests in the same process also run against extra live shells.
That is why one burst turns 6 tests red instead of 1.

### S2. `src/server/sessionsClose.bun.test.ts` - real flake, ~40 % in a paired run

`restarting a finished agent does not inherit its done status` (line 81) waits for the `done`
status with `deadline = Date.now() + 5000`, which **equals bun's default per-test timeout of 5 s**.
Failure is exactly `[5001.43ms]` / `[5001.07ms]`, reported as a runner timeout with no diagnostic.
Green takes 634 to 840 ms, so the margin is 6x in the normal case and 0 in the stall case.

Same file: line 178 uses a 15 s budget, line 127/152 use bare `sleep(150)` / `sleep(100)` for
close ordering. Those passed in every observed run.

### S3. `src/server/ptyWinch.bun.test.ts` - real flake, lower rate

`READ_BUDGET_MS = 15_000` covers the first output line of `bash -l` running `stty size`.
Seen red twice (full-suite run 2 at 14881 ms, run 10 at 15056 ms) with
`expect(false).toBe(true)` at line 140. The file's own comment already records this failure mode at
load average 6; this machine ran at 6 to 19 with 6 GB swap in use. Alone, 8/8 green.

### S4. `src/client/workspaceCommit.test.ts` (P0) - clock margin, not yet observed red

Fixed `setTimeout` waits of 600 ms and 800 ms against `SAVE_DEBOUNCE_MS = 400` in
`workspaceLifecycle.ts`, plus a 50 ms polling loop with up to 30 iterations for a 300 ms `setCenter`
animation. Slack is 200 to 400 ms, in jsdom, on a shared CI box. 8/8 target runs passed at 5.3 to
5.9 s, so treat this as a latent risk rather than a current flake. It is also the second slowest
suite in the full run.

### S5. `src/client/paneSplit.test.tsx` - wall-clock, but passes

Uses `SAVE_FLUSH_MS`-sized waits and is the slowest file (8.98 to 10.73 s). Per-case times moved
2272 -> 908 ms between runs, so timings here are load-sensitive, but no failure was observed in 7
full runs.

## Wall-clock dependence inventory

Real-clock only, no fake timers on PTY paths (correct: impossible to fake):

- `src/server/sessions.bun.test.ts`: `pollFor` 3 s default, 10 s for scrollback.
- `src/server/sessionsClose.bun.test.ts`: 5 s `done` deadline, 15 s exit deadline, `sleep(150)`,
  `sleep(100)`.
- `src/server/ptyWinch.bun.test.ts`: 3 x 15 s budgets + `DUPLICATE_GAP_MS = 320` (documented as
  intentionally above bash's `sleep 0.2` trap granularity).
- `src/server/pty.bun.test.ts`, `ptySpawn.bun.test.ts`, `sessionsStale.bun.test.ts`: poll loops,
  20 to 50 ms sleeps.
- `src/client/workspaceCommit.test.ts`, `paneSplit.test.tsx`: debounce-margin sleeps.
- `src/client/ws.test.ts`: `vi.advanceTimersByTime`, deterministic, good.
- `src/server/nodeRegistry.ts` / `outputLog.ts` take injected `now` / sequence numbers; their tests
  are fully deterministic. No wall-clock risk there.

Deterministic surfaces (no clock): `subscribers.test.ts`, `nodeRegistry.test.ts`,
`outputLog.test.ts`, `sessionsFake.test.ts`, `shared/workspace.test.ts`, `hooks.test.ts`
(pure assembly), `terminalSession.test.ts`.

## Leaks

- **Processes:** no orphaned PTY children, no stray `bash -c "stty size"` / `while :; do sleep`
  survivors after full runs (checked before/after `pty.bun.test.ts`).
- **Sockets:** no leftover unix sockets under `/tmp/st` (`$TMPDIR` length is handled by the
  documented `TMPDIR=/tmp/st`).
- **Open handles/timers:** vitest exits cleanly, no "close timed out", no hanging-worker warning in
  any of the 7 logs. Bun exits 0 with no pending-handle complaint. PTY writers are closed via
  `s.close` / `pty.kill` in `finally`.
- **Disk (real, minor):** every run of `sessions*`/`sessionsClose`/`sessionsStale` creates a
  `mkdtempSync` directory that is never removed. Counts in `/tmp/st` now: 210 `webterm-sessions-*`,
  184 `webterm-close-*`, 181 `webterm-stale-*` (plus 1559 `wt-presence-*` from other suites),
  23 MB total. On CI with a shared `$TMPDIR` this grows without bound.
- **Failure-path leak (test hygiene):** in `sessions.bun.test.ts` and `sessionsClose.bun.test.ts`,
  an assertion throws before `s.close(...)`, leaving live shells for the remainder of the file.
  This amplifies S1 and S2 (one slow spawn makes neighbours red).

## Verdict

Deterministic gates are healthy: typecheck passes repeatedly (0.5 s), vitest is 7/7 green with no
flake (1031 tests at b4e7f01, 1062 at b46a06a), and the new P0 vitest files are 8/8 green with 12 %
timing spread.

The bun PTY suites are flaky on this machine: 2 of 17 full runs red (12 %), and
`sessions.bun.test.ts` floods 6 tests red per bad run. All observed failures share one cause:
a fixed wall-clock budget (3 s / 5 s / 15 s) for a real login-shell spawn, on a box with 6 GB of
swap in use and load average 6 to 19, where spawn latency bursts to 15 s. None of the failures
indicate a defect in the P0 code; the fake-PTY and registry tests are deterministic and stable.

Suggested (not applied, this task is read-only):
1. Make `pollFor` throw a diagnostic on timeout instead of returning, and give it 10 s.
2. Raise the `done` deadline in `sessionsClose` above bun's 5 s default, or pass an explicit
   per-test timeout.
3. Give `sessionsClose`/`sessionsStale`/`sessions` an explicit 30 s per-test timeout like
   `ptyWinch` already has.
4. Clean up `mkdtempSync` dirs in `afterAll`.
5. Re-run the full gate once on a frozen commit, since HEAD moved under this measurement.
