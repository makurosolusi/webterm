# Testing

Running every test after every change is slow on the dev machine (8 cores / 8 GB) and used to take tens
of minutes. Tests now run in three tiers. The full suites are opened only by the owner and by CI.

Always run with `TMPDIR=/tmp/st` (macOS): tests bind unix sockets under `$TMPDIR`, and the default path
exceeds the 104-character `sun_path` limit (`EINVAL`). `test:impacted` sets it for itself when needed.

## Tier 1: daily, `npm run test:impacted`

Typecheck first (`npm run typecheck`, or pass `--typecheck`), then:

```
npm run test:impacted
```

It works out what your change can break and runs only that, one command at a time, `nice -n 15`, vitest
with `--maxWorkers=2`:

1. **Changed files** = `git diff <merge-base with main>...HEAD` + uncommitted + untracked.
2. **vitest**: changed tests run directly; changed sources run `vitest related` (vitest's module graph).
3. **bun**: bun has no `related`, so `scripts/test.impacted.graph.ts` builds a static reverse import
   graph over `src/` and `scripts/` and selects every `*.bun.test.ts` that transitively imports a changed
   file, plus the paired `x.bun.test.ts` / `x.<topic>.bun.test.ts`. A test that spawns an entry by quoted
   path (`'index.ts'`) counts as importing it. `*.real.bun.test.ts` (needs a real Chromium) is excluded
   unless that file itself changed. A change to a hub module (`db.ts`, shared types) legitimately selects
   most bun tests; that is the real blast radius, not a bug.
4. **policy tier**: the scanner tests (below) whose domain the change touches. This is what `related`
   cannot do: they read all of `src/`, import nothing they guard, and so never get selected.

Output: the plan (counts and why each policy domain fired), each command with its duration, a summary per
section, the failing files with a rerun-alone command, and exit 1 on failure. Options:

| Option | Effect |
|---|---|
| `--dry` | print the plan only |
| `--no-policy` | skip the policy tier |
| `--typecheck` | run `npm run typecheck` first |
| `--base <ref>` | diff against the merge-base with `<ref>` (default `main`, then `origin/main`) |
| `--files a b c` | use these files instead of git: the normal, focused path for workers (pass the tests that cover your change) |
| `--wait <min>` | queue up to `<min>` minutes behind another running gate (default 0: fail fast, exit 3) |
| `--budget <min>` | stop between batches once `<min>` minutes have passed; prints the batches NOT run (exit 4) |

### Guards: one gate at a time, no wide gate

- **Machine-wide lock.** Only one `test:impacted` runs per machine (lockfile `/tmp/webterm-test-gate.lock`,
  override dir with `WEBTERM_TEST_GATE_LOCK_DIR`; holder pid, worktree, start, command). A second gate prints
  who holds it and for how long, then exits 3 ("gate lain sedang berjalan; tunggu atau jalankan nanti")
  unless `--wait` is given. Stale locks (dead pid, or older than 2 hours) are taken over; the lock is
  released on success, failure, SIGINT and SIGTERM. `--dry` takes no lock.
- **Width limit.** After planning, a plan above 120 files (vitest + bun + policy) or 40% of all test files is
  refused with exit 2: that is close to a full suite, which is forbidden. The message lists the 5 changed
  files that pull in the most test files (hubs such as `envRegistry.ts`) and suggests splitting the work and
  using `--files <related tests>`. Measured with `--dry`: a changed test or a `scripts/` edit plans ~75
  files, `App.tsx` ~85, while `envRegistry.ts` plans 281 (bun 204 of 375). `--dry` still prints the plan
  and says a real run would be refused.
- **`WEBTERM_ALLOW_WIDE_GATE=1`** overrides the width limit. Owner/orchestrator only; agents and workers must
  never set it (same rule as `WEBTERM_FULL_TESTS`).
- **Estimate.** Before running, the gate prints file counts per tier and an estimated duration (25 s per
  40-file bun batch measured on the dev machine; vitest 40 s and typecheck 60 s are rough). Cancel if it
  is too much; use `--budget` to make the gate stop on its own.

A high load average (above the core count) prints a warning; wait for the machine instead of cancelling.

`test:related` (`vitest related --run <files>`) and `test:changed` (`vitest --changed --run`) still exist.
They are vitest-only and never run bun tests or scanner tests, which is exactly the gap `test:impacted`
closes. Prefer `test:impacted`.

### Policy tier and the manifest

`scripts/test.policy.manifest.ts` lists the scanner tests per domain (`client`, `server`, `shared`,
`docs`, `all`) and what triggers each. Path triggers: `src/client/**` -> client, all; `src/server/**` ->
server, all; `src/shared/**` -> client, server, shared, all; `docs/**` / `*.md` -> docs; any test,
`package.json`, `vite.config.ts`, `bunfig.toml`, `tsconfig*.json`, `scripts/**`, `src/test*.setup.ts` ->
every domain.

The manifest cannot go stale: `scripts/test.policy.manifest.bun.test.ts` finds scanner-style tests by
shape (file named `*olicy*`, `*.grep.test.ts` or `*invariants*`, or a test that reads a directory tree
and walks it for sources) and fails with "add it to scripts/test.policy.manifest.ts" when one is not
listed, or when a listed file is gone. **Adding a scanner test**: write it, add it to the manifest under
the domain of the tree it reads (`all` if several), run that bun test.

## Tier 2: the guards (full suites are closed)

| Command | Result |
|---|---|
| `npm test`, `npm run test:bun` | refuse, exit 2: "Full test suite needs an explicit command from the owner..." |
| `npx vitest run` (no filter) | refused by `scripts/vitestGuard.ts` (vitest `globalSetup`), exit 2 |
| `bun test` (no path) | refused by `scripts/bunTestGuard.ts` (`bunfig.toml` preload), exit 2 |
| more than 60 filters/paths | refused: a giant list is a full suite in disguise |
| `npm run test:all`, `npm run test:bun:all` | the deliberate full runs (owner) |

Still allowed: `vitest run <file>`, `vitest related --run <files>`, `vitest --changed`, `-t <pattern>`,
`bun test <files>`. The bun guard reads the real command line (`/proc/self/cmdline`, else `ps`) because
`process.argv` only holds the test file under `bun test`. The decision logic is `scripts/testGuard.decide.ts`
(unit-tested); `scripts/test.fullGate.ts` is the npm script gate.

`WEBTERM_FULL_TESTS=1` opens every guard. It is for the owner and CI only. **Agents must never set it**,
and must never run the full suites in any other way.

## Tier 3: CI, `.github/workflows/test.yml`

GitHub Actions on `makurosolusi/webterm`: push to `main`, pull requests, manual dispatch; older runs on
the same ref are cancelled; read-only token; no secrets, no `pull_request_target`. Three parallel jobs on
`ubuntu-latest` (45 min each): typecheck, vitest (`npm run test:all`), bun (all `*.bun.test.ts` except
`*.real.*`, with a temp `HOME`). Logs are uploaded as artifacts when a job fails. Dependencies come from
`bun install --frozen-lockfile` (`bun.lock`), Bun is pinned to the version in `BUN_VERSION`, Node 26.

Actions are pinned to commit SHAs of releases older than two weeks (checked 2026-11-18 against each
repository's GitHub releases, `gh api repos/<owner>/<repo>/releases`):

| Action | Tag | Commit | Released |
|---|---|---|---|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5` | 2026-07-20 |
| `oven-sh/setup-bun` | v2.2.0 | `0c5077e51419` | 2026-03-14 |
| `actions/setup-node` | v7.1.0 | `949feb2413d6` | 2026-10-08 |
| `actions/cache` | v6.1.0 | `55cc83458639` | 2026-06-26 |
| `actions/upload-artifact` | v7.0.2 | `cf430e030ddb` | 2026-10-07 |

### Known platform-specific risks

The suites have only ever run on macOS. The first CI runs will probably find Linux-only failures:
keychain/credential-store code, path and case-sensitivity assumptions, Chrome discovery, `sun_path`
(Linux limit is 108, so likely fine with `TMPDIR=/tmp/st`), PTY behaviour, tests that assume `~/Documents`.
Treat each one as its own task: mark the test skip-on-linux with the reason written next to it
(`test.skipIf(process.platform === 'linux')(...)` and a comment), then fix it; do not delete the test.
The `*.real.bun.test.ts` suites are not run in CI at all.

## Pitfalls

- Never pass `bun test` a non-test path (a source file, a `*.test.ts` meant for vitest): it pulls vitest
  files into bun and fails for no real reason. Give it explicit `*.bun.test.ts` paths.
- `src/server/distAssets.generated.ts` is git-ignored and generated by `bun scripts/embedDist.ts`. A stale
  copy in your checkout can break the compile tests; delete it or rebuild it (`npm run build`).
- `*.real.bun.test.ts` need a real Chromium and the real `HOME` (see `src/testIsolation.setup.ts`);
  `test:impacted` runs them only when the file itself changed.
- A timeout while the machine is loaded is often fake: check `uptime`, rerun the single file when idle.
- Raw `bun test` without `--no-env-file` and a temp `HOME` can touch your real `~/.webterm-server`;
  use the npm scripts.
