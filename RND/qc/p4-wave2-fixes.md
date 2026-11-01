# P4 wave 2 — fixes after QC

Date: 2026-11-01 · Branch: `feature/agent-pusat-p3` · Range `0f12506`..`2f04f77`
Inputs: `p4-wave2-security.md` (A1, B1, B2, C1-C3, D1-D3, E1), `p4-wave2-acceptance.md`,
`p4-memory-fix-acceptance.md`, `p4-control-plane-acceptance.md`, `p4-worker-loop-acceptance.md`.
Docs only; no source/test was edited for this note.

Evidence is either a named test file (unit) or a live acceptance report (HTTP). A fix with
only a unit test is not called accepted.

## 1. Finding → fix → evidence

| ID | Sev | Finding | Fix | Test / acceptance | Commit |
|---|---|---|---|---|---|
| D1 | High | Memory `relPath` was `<project>/<key>.md`, but the DB key is unique per `(project, scope, key)`. Two legal facts (`project:deploy`, `scratch:deploy`) shared one file and the second export silently overwrote the first. | `${project}/${scope}/${key}.md` (`memoryFilePath.ts:54`); export passes the row's scope. Rebuild already read `scope`. | `memoryFile.test.ts:362` exports both scopes to distinct paths and rebuilds both. Live: `p1/project/deploy.md` and `p1/scratch/deploy.md`, two files, no loss (`p4-memory-fix-acceptance.md` §1). | `ab2fb6e` |
| D2 | High | Rebuild matched on `(project, scope, key)` and ignored `updated_at`, so the pre-supersede file rewrote the live row. Any rebuild rolled a supersede back. | Rebuild skips a record older than the matched row (`existing.updated_at > record.updatedAt` → `unchanged`, `memoryFile.ts:130`). | `memoryFile.test.ts:384` never lets a stale file revert a newer fact. Live: export OLD → supersede to NEW → rebuild → live body stays `NEW`, `unchanged:3`, no quarantine (`p4-memory-fix-acceptance.md` §3). | `ab2fb6e` |
| D3 | High | `WEBTERM_MEMORY_FILES=on` was inert on a fresh install: nothing created the root or ran `git init`, and a commit needed host git identity. | Root created `0700`, idempotent `git init -q` when `.git` is absent (`memoryFilePath.ts:126`), and `-c user.name/-c user.email` server-owned identity (`memoryFile.ts:38`). | `memoryFileEnsure.test.ts:76` (cold root create + export), `:104` (skips init when `.git` exists), `:128` (real git, server identity). Live: root `drwx------`, `.git` present, no `~/.gitconfig`, commit author `webterm <webterm@localhost>` (`p4-memory-fix-acceptance.md` §2). | `ab2fb6e` |
| B1 | Medium | The "16 KiB cap" on `/api/central/*`, `/api/orchestrator/*`, `/api/memory/export|rebuild` ran after `readBody()` had buffered the whole body, so an oversized upload was held in memory before the 413. | `content-length` precheck before reading, then `readCappedBody(req, 16 KiB)` (`extendedApi.ts:87-96`). The flag gate still answers before the body for a disabled surface. | `extendedApi.test.ts:118` (compat `readBody` never called), `:130` (64 KiB chunks, no content-length), `:137` (declared oversized rejected before a chunk). Live: 16 384 bytes → `400 invalid_json`; 16 385 → `413 payload_too_large` (`p4-wave2-acceptance.md` §4). | `2176c98` |
| A1 | Medium | The auth negative list named none of the new root-only families. Adding `/api/central` to `isNodeTokenPath` passed the whole suite; the source guard only matched `/api/channels`. | `ROOT_ONLY_PATHS` covers central, orchestrator, memory export/rebuild, and Telegram bindings; prefix roots are tested too; the source guard pins exactly three allowlist arms; capability tokens are asserted on every root-only path. | `auth.test.ts:49-53`, `:238`, `:251`, `:443`. Targeted run: `auth`, `extendedApi`, `workerRuntime`, `memoryFile`, `memoryFileEnsure`, `orchestratorControlApi`, `orchestratorRunApi` = 7 files / 137 tests pass. | `2176c98` |
| C1 | Medium | A throw after `deps.sessions.open` (status/terminal/wait error) escaped `runTask` before `cleanup()`, leaving a live PTY and a held worktree until the reaper. | The post-open body runs inside the cleanup path; a catch routes through `fail(...)`, which records once then closes the PTY and releases the worktree. | `workerRuntime.test.ts:280` "closes the PTY and releases the worktree when the session port throws after open" (asserts `closed`/`released`). Unit only; no live fault injection. | `2176c98` |
| — | Low | Memory file errors could return the absolute root or raw git stderr/stdout (`safeMessage` did not redact). | `memoryFileHttpResponse.ts:13` wraps the message in `redactSecrets`, still capped. | `memoryFileHttp.test.ts` error-path assertions; live acceptance saw only compact codes, no paths. | `ab2fb6e` |
| — | — | `/run` requires an assigned item, but only a throwaway Bun script could assign one, so the production loop had no HTTP entry. | `POST /api/orchestrator/bootstrap` (project + orchestrator + worker + plan, one transaction, absolute existing git root and explicit non-empty item scope) and `POST /api/orchestrator/assign` (task ledger + plan item lock, `expectedVersion`). Root-only, metadata only. | Unit: `orchestratorControlApi.test.ts` + `.bun.test.ts`. Live HTTP: `p4-control-plane-acceptance.md` verifies bootstrap → duplicate 409 → assign → plan/tasks, flag-off 503, git-root/scope validation, and no worktree/PTY. | `4765230` |
| B1 | Low | Bootstrap rejected `cmd` but silently accepted `repo` (and other client fields) with HTTP 200, while assign rejected them; the contract drifted between two lists. Value was unused, so this was a typed-error bug, not a privilege bug. | One shared reject list for both routes (`orchestratorControlApi.ts`); bootstrap still allows its own `path` field. | `orchestratorControlApi.test.ts` / `.bun.test.ts` cover bootstrap-with-`repo` → `client_controlled_field`; live matrix recorded in `p4-control-plane-acceptance.md` §4. | `0b63714` |
| B2 | Low | Real agent ids contain `:` (`orch:<project>`, `worker:<project>`), but `assignee` was parsed with an id pattern that forbade `:`, so an explicit real agent id was rejected as `invalid_assignee` and `wrong_role` was unreachable. | Separate agent-id parser that allows `:`; explicit colon-bearing ids now reach `assignTask`. | `orchestratorControlApi.test.ts` / `.bun.test.ts` assert explicit colon ids are accepted and the wrong-role denial is reachable. | `0b63714` |
| W1 | High | The first orchestrator run on a fresh data dir failed `409 worktree_failed`: `<data>/worktrees` was passed to git as `cwd` but never created. | `mkdirSync(root, { recursive: true, mode: 0o700 })` before the worktree service; typed 500 `worktree_root_failed` if it fails. | `orchestratorRunApi.test.ts`; live fresh data dir with no pre-created dir: first run 200, root ends `drwx------` (`p4-worker-loop-acceptance.md`). | `2f04f77` |
| W2 | Med | The worker prompt was multi-line, so a PTY agent reading one line saw only the opening fragment. | Prompt joined with ` · `, CR/LF and repeated whitespace collapsed into one line before the byte cap. | `workerRuntimePrompt.test.ts`; live fake agent read all 522 chars on the first read and nothing on the second (`p4-worker-loop-acceptance.md`). | `2f04f77` |

Supporting splits with no behavior change: `0f12506` (ledger migrations v1/v2/v3 out of
`ledgerSchema.ts`, 244 → 20 lines plus ≤179-line modules), `d3d4c47` (worker runtime and
memory-file modules), `59b9523` (run/central/memory HTTP), `f04dd5d` (Telegram sender +
bindings), `f82342e` (central projection), `56eeef1` (memory file/git truth),
`4c5110c` (worker runtime).

## 2. Acceptance that backs the table

| Report | Verified | Not covered |
|---|---|---|
| `p4-memory-fix-acceptance.md` | cold root: scoped exports, `0700`/`0600`, `git init`, server identity, supersede+rebuild no rollback, flag-off 503 with no FS touch, no token in logs | symlink escape, quarantine conflicts, export of a superseded id |
| `p4-wave2-acceptance.md` | central portfolio/project/pause/resume/priority + audit events, flag-off 503s, memory export/rebuild, run rejection paths, 16 KiB boundary, bindings auth/roles, webhook secret, log hygiene | successful worker run (superseded by the loop report below) |
| `p4-control-plane-acceptance.md` | bootstrap → duplicate 409 → assign → plan/tasks over HTTP, typed validation matrix, flag-off 503, no worktree/PTY, token not in logs | successful worker run (covered by the loop report below) |
| `p4-worker-loop-acceptance.md` | fresh data dir first run 200, worktree root `0700`, PTY + one-line prompt, SessionEnd → verify → `verified`, cleanup, run negatives | real Claude/model output and real hook payloads (fake agent harness only) |
| This note (targeted run) | 7 wave files / 137 tests; `tsc --noEmit` clean | full suites were taken from the gate, not re-run here |

Full gates on `2f04f77`: `tsc` clean, vitest 127 files / 1697 tests, bun 28 files / 201 tests.
Known flake: `terminalCore` / `paneSplit` under parallel load, green isolated. Not deterministic
100%; do not claim otherwise.

## 3. Residual

| ID | Sev | Residual | Why open | Next step |
|---|---|---|---|---|
| C2 | Low-Med | `updateItem` can fail `stale_version` after `claimSuccess` wrote `verified`, leaving task `verified` with a `running` plan item. | The claim and the item transition are not one transaction. | Move the item transition into the claim transaction; test with a store that throws `StalePlanVersionError`. |
| C3 | Low | `plan.status` (`draft`/`completed`/`abandoned`) and `project.status === 'paused'` do not block a run. | May be intentional for P4. | Decide the rule, then gate `run` and test it. |
| E1 | Low | Webhook failure throttle keys on `req.socket.remoteAddress`; behind a proxy, 30 bad secrets per 60 s block genuine deliveries. | No trusted-proxy mode. | Opt-in `X-Forwarded-For` keying. |
| — | Low | `parseBinding` does not re-apply the group-role rule on load, so a hand-edited `channels.json` could hold a group as `owner`. | Validation happens on write only. | Re-validate on load and quarantine/deny. |
| B2 | Low | Bindings body limit exists twice (8 KiB HTTP, inner API check that can never fire). | Cosmetic drift risk. | Import the shared constant or delete the inner check. |
| — | High | Fake-agent loop is verified (run → worktree → PTY → one-line prompt → SessionEnd → verify → `verified` → cleanup), but real Claude is not: model output, CLI resume, and Claude hook payloads are untested. | The harness used a shell script, not Claude. | Run one assigned task with a real Claude CLI on a disposable repo and record the transcript/hook evidence. |
| — | Med | No live Telegram bot/network: sender and webhook use fake fetch/updates; no-token boot is verified. | No real token/network in tests. | One real bot delivery + one outbound reply, token redaction re-checked. |
| — | Med | Autonomous central agent not built: only portfolio projection plus pause/resume/priority. | Scope was a thin layer. | Defer until the loop is stable on real runs. |
| — | Med | Independent verification is not the only path to `verified`. | Human/worker verify paths remain. | Make verifier-issued evidence the sole `verified` transition. |
| — | Low | P4b 2-project × 2-week soak not run. | Cold-root acceptance is functional, not longitudinal. | Run the soak before calling it production. |
| — | Low | Telegram channel migration (v4) not added; `WEBTERM_CHANNELS` still unread. | Bindings ship in the channel store file, not SQL. | Decide the schema or retire the flag. |
| — | Low | Node canvas interactions still lack E2E (P3 E2E used an empty workspace). | No canvas fixture. | Add a workspace-with-nodes E2E. |
| — | Low | `/api/workspaces` is equally unbounded before its body check (pre-existing, not this wave). | Outside wave scope. | Apply the same capped reader. |
| — | Low | `DedupeStore` is tested but unused in production. | Awaiting a caller. | Wire or delete. |

## 4. Claim boundaries

- "Fixed" above means the finding has a named test or live acceptance, not that every adjacent
  path is covered.
- No secret, token, absolute acceptance path, or webhook secret appears in this document.
- Static review plus targeted probes remain the basis for unexercised branches; runtime-only
  issues (PTY timing, real Telegram delivery, sqlite contention) are outside them.
