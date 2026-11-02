# P4 control plane — bootstrap → assign → plan visibility (HTTP acceptance)

Scope: prove the new root-only control plane over real HTTP on a live production-style server,
**without spawning an agent**. Repo `webterm`, branch `feature/agent-pusat-p3` at `4765230`.
No repo source/test files were modified; nothing was committed. All state lived under
`/tmp/acc-p4-control` and was deleted afterwards.

## Verdict

**VERIFIED** for the happy path chain (bootstrap → duplicate 409 → assign → plan/task visibility),
the typed validation matrix, the flag-off gate, and the "no worktree, no PTY, no token in logs"
invariants. **One contract bug** and **one dead typed error** found (details at the end).

## Setup

```
throwaway repo  /tmp/acc-p4-control/repo   (git init, 1 commit 75bf322 "init")
server          cd /tmp ; env -i HOME=/tmp/acc-p4-control \
                NODE_ENV=production HOST=127.0.0.1 PORT=8827 \
                WEBTERM_DATA_DIR=/tmp/acc-p4-control/data \
                WEBTERM_LEDGER=on WEBTERM_ORCHESTRATOR_RUN=on \
                WEBTERM_TOKEN=<40-char random, /tmp/acc-p4-control/token.txt> \
                /Users/bip/.bun/bin/bun <repo>/src/server/index.ts
log             webterm listening on http://127.0.0.1:8827 (prod, token on: len=38)
                ledger on: /tmp/acc-p4-control/data/ledger.db
```

Ports 8799 and 3001 were never contacted. Auth on every call:
`x-webterm-token: $TOKEN` (redacted everywhere below).

## 1. Bootstrap — HTTP 200

```
POST /api/orchestrator/bootstrap
{"projectId":"p-boot","name":"Boot","path":"/tmp/acc-p4-control/repo",
 "items":[{"title":"Task one","scope":["src"]}]}
```
```
{"ok":true,
 "project":{"id":"p-boot","workspaceId":"bootstrap:p-boot","name":"Boot",
            "path":"/tmp/acc-p4-control/repo"},
 "orchestratorAgentId":"orch:p-boot",
 "workerAgentId":"worker:p-boot",
 "plan":{"id":"073af1fa-13eb-4692-a0da-8a86bb472742","version":1,
         "items":[{"id":"4fb3cd2d-c9fe-4186-b1ff-46d30be189db","seq":0,
                   "title":"Task one","scope":["src"],"status":"pending"}]}}
```
Independently confirmed, not just echoed back:

- `GET /api/orchestrator/plan?projectId=p-boot` → 200, `version:1`, one item `pending`,
  `taskId:null`, `assignee:null`.
- `GET /api/orchestrator/agents?projectId=p-boot` → 200, exactly two agents:
  `orch:p-boot` (role `orchestrator`, depth 1, parent null) and
  `worker:p-boot` (role `worker`, depth 2, parent `orch:p-boot`).
- `GET /api/orchestrator/tasks?projectId=p-boot` → 200, `tasks: []`.
- `sqlite3 data/ledger.db` → `project|1  agent|2  plan|1  plan_item|1  task|0`.

## 2. Duplicate bootstrap — HTTP 409, no extra rows

Identical body replayed → `{"error":"project_exists"}` HTTP 409. Row counts unchanged
(`project|1 agent|2 plan|1 plan_item|1 task|0`): the transaction rolled back as one unit.

## 3. Assign — HTTP 200, visible in plan and tasks

```
POST /api/orchestrator/assign
{"projectId":"p-boot","itemId":"4fb3cd2d-c9fe-4186-b1ff-46d30be189db","expectedVersion":1}
→ 200 {"ok":true,"taskId":"550ed362-a31f-4d2f-ab24-52543ae6723c","planVersion":2}
```
`GET /plan?projectId=p-boot` → `version:2`, item now
`status:"assigned"`, `taskId:"550ed362-…"`, `assignee:"worker:p-boot"`, `assignedAt` set.
`GET /tasks?projectId=p-boot` → the task exists: `agentId:"worker:p-boot"`,
`status:"pending"`, `attempt:0`, `maxAttempts:3`,
`idemKey:"plan:073af1fa-…:4fb3cd2d-…"` (plan id + item id, so replay cannot double-assign).
Also verified on a second project `p-boot2` with the default assignee (`worker:<project>`):
200, `planVersion:2`, task `agentId:"worker:p-boot2"`.

## 4. Validation matrix (all against the live server)

| request | status | body |
|---|---|---|
| bootstrap item without `scope` | 400 | `{"error":"invalid_scope"}` |
| bootstrap `scope:[]` | 400 | `{"error":"invalid_scope"}` |
| bootstrap `scope:[42]` (non-string) | 400 | `{"error":"invalid_scope"}` |
| bootstrap path not a git root (`/tmp/acc-p4-control`) | 400 | `{"error":"invalid_path"}` |
| bootstrap relative path | 400 | `{"error":"invalid_path"}` |
| bootstrap with `cmd` | 400 | `{"error":"client_controlled_field"}` |
| bootstrap with `repo` | **200** | project created — **BUG B1** |
| assign `assignee:"ghost"` (unknown, colon-free) | 400 | `{"ok":false,"error":"agent_not_found","message":"agent not found: ghost"}` |
| assign `assignee:"orch:p-boot2"` (orchestrator id) | 400 | `{"error":"invalid_assignee"}` — **BUG B2** |
| assign already-assigned item, `expectedVersion:1` | 409 | `{"ok":false,"error":"invalid_state"}` |
| assign unknown project | 409 | `{"ok":false,"error":"plan_missing"}` |

Every rejected request left zero rows behind: counts after the matrix moved only by the one
request that *succeeded* (the `repo` case) — `project|2 agent|4 plan|2 plan_item|2 task|1`.
The failed `ghost` assign did not consume the item: the immediately following legitimate
assign with `expectedVersion:1` returned 200.

Flag-off variant (second boot, same port 8827, `WEBTERM_ORCHESTRATOR_RUN` unset,
`WEBTERM_DATA_DIR=/tmp/acc-p4-control/data-off`):

- `POST /bootstrap` → 503 `{"error":"orchestrator_off"}`
- `POST /assign` → 503 `{"error":"orchestrator_off"}`
- `GET /plan?projectId=p-off` → 200 `{"projectId":"p-off","plan":null}` (read route stays open)
- `POST /bootstrap` without token → 403 `forbidden`

## 5. No worktree, no PTY

- `git -C repo worktree list` → only `/private/tmp/acc-p4-control/repo 75bf322 [main]`;
  `repo/.git/worktrees` does not exist; repo tree still only `.git`, `src.txt`.
- Server PID (84357) had **no child processes** at all (`pgrep -P` empty, no descendants),
  i.e. nothing was exec'd: no PTY, no `git worktree add`.
- Data dir contains only `ledger.db(-shm/-wal)`, `webterm.db`, and the boot-time
  `context-links/context.sh` shim (generated by `installContextLink` at startup, mode 0700,
  contains no token — grep count 0). No `worktrees/` tree was ever created.

## 6. Token hygiene

- `server.log` token occurrences: **0**. The only lines are the two startup lines above
  (`len=38`, never the value).
- Raw-byte grep for the token across `data/ledger.db`, `ledger.db-wal`, `webterm.db`: **0**.
- Token was passed via env (`WEBTERM_TOKEN`) into a `env -i` process, never on a command line
  visible as an argument, and is redacted in this report.

## 7. Cleanup

Server killed; `lsof -iTCP:8827` empty; `/tmp/acc-p4-control` (repo, data, data-off, logs,
token) removed. Ports 8799/3001 untouched throughout.

## Findings

**B1 — `repo` is accepted silently on bootstrap but rejected on assign (contract drift).**
`src/server/orchestratorControlApi.ts:120` rejects only `COMMAND_FIELDS`
(`cmd/command/args/argv/exec/shell`), while `:155` rejects `...COMMAND_FIELDS, 'repo', 'path',
'cwd', 'agent', 'agentId'`. A bootstrap body carrying `repo:"https://example.test/x.git"`
returns 200 and creates the project (ignored field); the acceptance contract and the assign
route both say `client_controlled_field`. Fails safe (value unused), so it is a typed-error
contract bug, not a privilege bug. Fix: share one reject list.

**B2 — `wrong_role` can never be returned over HTTP: real agent ids contain `:`**
`id()` enforces `ID_PATTERN` `^[A-Za-z0-9][A-Za-z0-9._-]*$` (`:28`, `:74`), but bootstrap mints
ids `orch:<projectId>` / `worker:<projectId>` (`:195`, `:199`). Any real agent id supplied as
`assignee` is therefore rejected earlier as `invalid_assignee` (400), so the `wrong_role`
branch in `assignTask` is unreachable through this route, and `assign` can only ever name an
agent the caller guessed without a colon (which yields `agent_not_found`). Fails closed, but
the intended typed error cannot be exercised; either widen the assignee parser to accept the
agent-id format or document that `assignee` accepts only the default `worker:<projectId>`
form (which itself is colon-bearing and only passes because it is generated, not parsed).
