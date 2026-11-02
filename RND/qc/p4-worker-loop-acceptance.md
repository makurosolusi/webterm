# P4 worker loop acceptance — FAKE AGENT harness (rerun on fixed tree)

Date: 2026-11-01 · Repo: `/Users/bip/Documents/spawn/webterm` · Branch `feature/agent-pusat-p3` @
`0b63714` + uncommitted fixes from rat · Port `8828` only (8799/3001 untouched) · Temp state
`/tmp/p4-worker-loop-acc2`.

> **HARNESS LABEL:** the agent used here is `/tmp/p4-worker-loop-acc2/fake-claude.sh`, a shell script.
> It is **not Claude** and no real Claude Code was executed. It reads one prompt line, writes and
> commits `src/change.txt`, POSTs a fake `SessionEnd` hook, sleeps 5 s, exits. Results below prove
> the server-side production loop around a PTY agent, not a real model.

## Verdict (fresh data dir, first run, no manual workaround)

| Step | Result |
|---|---|
| `POST /api/orchestrator/run` on first ever run | **VERIFIED 200** (previous `worktree_failed` is gone) |
| `<data>/worktrees` auto-created | VERIFIED `drwx------` (0700) |
| Worktree allocation | VERIFIED (git worktree add via server) |
| PTY spawn + one-line prompt delivery | VERIFIED: fake agent read all 522 chars on first `read` |
| Status `SessionEnd` -> `done` | VERIFIED (`session_end_http=204`) |
| Independent verify | VERIFIED (`npm test`, `npm run typecheck` run by server) |
| `recordWorkerResult` | VERIFIED (`task.verified`, plan item `done`) |
| Cleanup (PTY + worktree) | VERIFIED (no live fake-agent process, no worktree left) |
| Negative: client `repo` | VERIFIED 400 |
| Negative: stale `expectedVersion` | VERIFIED 409 `plan_stale` |
| Negative: flag off | VERIFIED 503 `orchestrator_off` |

**Claim boundary:** full loop is verified with a fake PTY agent. Real Claude Code, model output,
and hook payloads from Claude are **not** covered.

## Setup

Throwaway repo `/tmp/p4-worker-loop-acc2/repo` (initial commit `83566f5`):

```json
{"scripts":{"test":"node -e \"console.log('1 passing')\"","typecheck":"node -e \"\""}}
```

Server (production mode, brand-new temp data dir, **no `worktrees` directory pre-created**):

```sh
NODE_ENV=production HOST=127.0.0.1 PORT=8828 \
WEBTERM_DATA_DIR=/tmp/p4-worker-loop-acc2/data \
WEBTERM_LEDGER=on WEBTERM_ORCHESTRATOR_RUN=on \
WEBTERM_TOKEN=<redacted> bun src/server/index.ts
# ledger on: /tmp/p4-worker-loop-acc2/data/ledger.db
# webterm listening on http://127.0.0.1:8828 (prod, token on: len=48)
```

Precondition checked twice (after boot and after assign): `<data>/worktrees` **absent**. The first
run itself created it; no harness `mkdir` was used.

`PUT /api/settings {"agentLaunchCommands":{"claude":"/tmp/p4-worker-loop-acc2/fake-claude.sh"}}`
-> **200**; `GET` showed the same value.

## Happy path (first run)

1. `POST /api/orchestrator/bootstrap` (project `p-run2`, path repo, item scope `["src"]`) -> **200**
   `plan.version=1`, item `f89463ab-1233-46a6-baf1-2dcc1b1ca49d`.
2. `POST /api/orchestrator/assign {expectedVersion:1}` -> **200**
   `{"ok":true,"taskId":"7b4e9a4e-1aa5-4357-a7a6-33444525276e","planVersion":2}`.
3. **First** `POST /api/orchestrator/run {expectedVersion:2,timeoutMs:60000}` -> **200 in 3.138 s**
   (no prior failure, no workaround):

```json
{"ok":true,"outcome":{"ok":true,
 "task":{"id":"7b4e9a4e-...","status":"verified","fence":1,"leaseOwner":null,"attempt":1},
 "nodeId":"w-7b4e9a4e-1aa5-4357-a7a6-33444525276e-1",
 "evidence":{"filesChanged":[],"scopeViolations":[],
   "tests":{"passed":1,"failed":0,"command":"npm test"},
   "typecheck":{"ok":true,"command":"npm run typecheck"},
   "commands":["git status --porcelain","git diff --name-only","git diff --stat","npm test","npm run typecheck"]}}}
```

Fake agent log (harness-owned; confirms full prompt on the first read):

```
start=1793517689 cwd=/private/tmp/p4-worker-loop-acc2/data/worktrees/task-7b4e9a4e-...
node=w-7b4e9a4e-1aa5-4357-a7a6-33444525276e-1 port=8828 token_set=yes
prompt_len=522 has_scope=yes has_worktree=yes has_tail=yes
prompt_head=You are a leaf worker agent in webterm. Work only inside the
extra_line_after_first_read=none
commit=70374740598d2dc2784eb700cf03fc25ac42de6d
session_end_http=204
```

`has_tail=yes` matches `orchestrator verifies independently`; `extra_line_after_first_read=none`
means the whole instruction arrived in one line and was submitted by one newline. The returned
`outcome.output` contains the same single-line prompt.

### Post-run state

- `GET /api/orchestrator/tasks?projectId=p-run2` -> `status":"verified"`, `leaseOwner":null`.
- `GET /api/orchestrator/plan?projectId=p-run2` -> `version":4`, item `status":"done"`.
- Ledger events (`ledger.db`, project `p-run2`): `task.created` -> `orchestrator.task_assigned` ->
  `task.leased` -> `orchestrator.worker_started` -> `task.claimed_done` -> **`task.verified`** ->
  `orchestrator.result_recorded`.
- `<data>/worktrees` -> `drwx------`, empty. `git worktree list` -> only
  `/private/tmp/p4-worker-loop-acc2/repo 83566f5 [main]`.
- Worker branch remains (normal): `7037474 (agent/7b4e9a4e-...) fake worker change`.
- `ps` -> no `fake-claude.sh` process; server had no live child PTY.
- Server log is 2 lines (ledger + listening). Root token absent from server log, fake-agent log,
  and `ledger.db`. Prompt text absent from the server log; it appears only in the harness-owned
  fake-agent log.

## Negatives (same fixed build)

| Request | Status | Body |
|---|---|---|
| `run` with `"repo":"/etc"` | 400 | `{"error":"client_controlled_field","message":"repo is resolved server-side and must not be sent"}` |
| bootstrap `p-neg2` + assign (plan v2), then `run expectedVersion:1` | 409 | `{"ok":false,"error":{"code":"plan_stale","message":"plan for project p-neg2 is at version 2, caller expected 1"}}` |
| flag `WEBTERM_ORCHESTRATOR_RUN=off`, `run` | 503 | `{"error":"orchestrator_off"}` |
| flag off, `bootstrap` | 503 | `{"error":"orchestrator_off"}` |

The stale-version run allocated and then released its worktree: `worktrees/` empty and
`git worktree list` clean afterwards.

## Bug 1 — found in first pass, now FIXED

Original finding: first orchestrator run on a fresh data dir returned **409 `worktree_failed`**.
`src/server/orchestratorRunApi.ts` computed `root = <data>/worktrees` and passed it to git exec as
`cwd`, but nothing created it (`config.ts` creates only the data dir), so the first spawn failed.

Fix (uncommitted, reviewed in working tree): `orchestratorRunApi.ts` now calls
`mkdirSync(root, { recursive: true, mode: 0o700 })` before `createWorktreeService`, returning a
typed 500 `worktree_root_failed` if creation fails. Verified on a brand-new data dir with no
pre-created directory: first run **200**, and the directory ended `drwx------`.

## Prompt fix (uncommitted, verified by harness)

`workerRuntimePrompt.ts` now joins the prompt with ` · `, collapses CR/LF and whitespace, and emits
one line. Verified end-to-end: the fake agent's single `read -r` received 522 chars containing the
scope, worktree path, and closing instruction; a second read saw nothing.

## Residuals / limits

- Fake agent is not Claude; real CLI/hooks/transcripts/model work are untested.
- `outcome.output` is the sanitized terminal buffer and echoes the prompt; it is not logged by the
  server.
- Worktree release leaves the task branch in the repo (expected; `git worktree remove` only).
- All temp processes stopped and port 8828 released before this report was finalized. Temp dirs are
  removed after report write.

## Harness commands (for reproduction)

`PUT /api/settings` -> `bootstrap` -> `assign` -> `run`, all with `x-webterm-token: <root token>`.
`run` body: `{"projectId","itemId","expectedVersion","timeoutMs":60000}`. Negative bodies as above.
