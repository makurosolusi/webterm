# P4 Wave 2 — HTTP acceptance on a live server

Date: 2026-11-01 · Branch: `feature/agent-pusat-p3` (commit `59b9523`)
Scope: prove the newly committed HTTP surfaces work on a real server, not only in unit tests.
No repo source/test was edited and nothing was committed. All state lived under `/tmp/wt-accept-*`.

Secrets are redacted below: `$TOKEN` = 48-hex root token, `$SECRET` = 48-hex webhook secret,
`$NODE_TOKEN` = UUID issued by the WS session. Values never appear in this document or in logs.

## Setup

```sh
ACC=/tmp/wt-accept-fBEggC                    # mktemp -d /tmp/wt-accept-XXXXXX
mkdir -p "$ACC/memory" "$ACC/repo" "$ACC/data8823" "$ACC/data8824"
openssl rand -hex 24 > "$ACC/token.txt"      # len 48
openssl rand -hex 24 > "$ACC/secret.txt"     # len 48
# throwaway project repo
cd "$ACC/repo" && git init -q && git config user.email a@b.invalid && git config user.name a \
  && echo init > README.md && git add README.md && git commit -qm init
# memory git truth repo (required before export: assertConfined realpaths the root)
cd "$ACC/memory" && git init -q && git config user.email a@b.invalid && git config user.name a \
  && echo '# memory' > README.md && chmod 600 README.md && git add README.md && git commit -qm init
```

Boot (cwd `/tmp`, so no `.env` token is auto-loaded; `env -i` keeps only PATH/HOME):

```sh
cd /tmp
env -i PATH="$PATH" HOME="$HOME" HOST=127.0.0.1 PORT=8822 NODE_ENV=production \
  WEBTERM_DATA_DIR="$ACC/data" WEBTERM_LEDGER=on WEBTERM_CENTRAL=on \
  WEBTERM_ORCHESTRATOR_RUN=on WEBTERM_MEMORY_FILES=on WEBTERM_MEMORY_DIR="$ACC/memory" \
  WEBTERM_TOKEN="$(cat "$ACC/token.txt")" \
  bun /Users/bip/Documents/spawn/webterm/src/server/index.ts > "$ACC/server-8822.log" 2>&1 &
```

`NODE_ENV=production` avoids the Vite dev middleware; the HTTP route chain is identical.
Boot log: `webterm listening on http://127.0.0.1:8822 (prod, token on: len=48)`.
Helpers: `req()` below is `curl -sS -o body -w 'HTTP %{http_code}\n' ... ; cat body`.
Where a command is abbreviated with `...`, it repeats the exact header/body flags of the nearest
full command above it (only the path or payload changes).

## 1. Central — VERIFIED

```sh
T=$(cat "$ACC/token.txt"); B=http://127.0.0.1:8822
curl -H "x-webterm-token: $T" $B/api/central/portfolio
# HTTP 200  {"items":[],"total":0,"limit":50,"offset":0}
curl $B/api/central/portfolio
# HTTP 403  forbidden                         (root gate, no token)
```

Seed one project with a temp Bun script (`openLedgerDb` + `createLedger`, then
`ledger.project.createProject({id:'p1', workspaceId:'ws-p1', name:'Accept Project', path:'$ACC/repo'})`)
while the server is running. WAL made the concurrent write safe.

```sh
curl -H "x-webterm-token: $T" $B/api/central/projects/p1
# HTTP 200 {"id":"p1","name":"Accept Project","status":"active","priority":0,"updatedAt":...,"plan":null,
#           "tasks":{...all 0},"taskTotal":0,"pendingApprovals":0,"latest":{...},"budget":null,
#           "usage":{"costMicros":0,"inputTokens":0,"outputTokens":0,"unpricedRecords":0}}
curl -H "x-webterm-token: $T" $B/api/central/projects/zzz
# HTTP 404 {"error":"project_not_found"}
curl -X POST -H "x-webterm-token: $T" -H 'content-type: application/json' -d '{}' \
     $B/api/central/projects/p1/pause
# HTTP 200 {"project":{"id":"p1","name":"Accept Project","status":"paused","priority":0},"changed":true}
curl -X POST ... $B/api/central/projects/p1/resume
# HTTP 200 {"project":{...,"status":"active",...},"changed":true}
curl -X POST -H "x-webterm-token: $T" -H 'content-type: application/json' -d '{"priority":7}' \
     $B/api/central/projects/p1/priority
# HTTP 200 {"project":{...,"priority":7},"changed":true}
curl -X POST ... -d '{"priority":"high"}' $B/api/central/projects/p1/priority
# HTTP 400 {"error":"invalid_priority"}
```

Post-mutation state read back from SQLite: `status=active, priority=7`; audit events present:

```json
[{"kind":"project.paused","payload_json":"{\"from\":\"active\",\"to\":\"paused\",\"actorKind\":\"human\"}"},
 {"kind":"project.resumed","payload_json":"{\"from\":\"paused\",\"to\":\"active\",\"actorKind\":\"human\"}"},
 {"kind":"project.priority","payload_json":"{\"from\":0,\"to\":7,\"actorKind\":\"human\"}"}]
```

Flag-off variant: boot on 8823 with `WEBTERM_LEDGER=on` and central/orchestrator/memory flags
unset, separate data dir.

```sh
curl -H "x-webterm-token: $T" http://127.0.0.1:8823/api/central/portfolio
# HTTP 503 {"error":"central_off"}
curl -X POST ... http://127.0.0.1:8823/api/memory/export   # HTTP 503 {"error":"memory_files_off"}
curl -X POST ... http://127.0.0.1:8823/api/orchestrator/run # HTTP 503 {"error":"orchestrator_off"}
# even with a malformed body the flag gate answers first: HTTP 503 {"error":"orchestrator_off"}
```

## 2. Memory files — VERIFIED

Seeded directly (`memory` row: `id=mem-acc-1, project_id=p1, scope=project, key=alpha,
title='Alpha Fact', body='The acceptance body says hello.', status=fact`).

```sh
curl -X POST -H "x-webterm-token: $T" -H 'content-type: application/json' \
     -d '{"id":"mem-acc-1"}' $B/api/memory/export
# HTTP 200 {"ok":true,"status":"written","relPath":"p1/alpha.md"}
stat -f '%Sp %N' "$ACC/memory/p1/alpha.md"
# -rw------- /tmp/wt-accept-fBEggC/memory/p1/alpha.md      (0600, dir 0700)
git -C "$ACC/memory" log --oneline
# d329e79 memory(p1): record fact alpha
# aa0d98f init
git -C "$ACC/memory" status --short     # clean
# re-export (idempotent): HTTP 200 {"ok":true,"status":"unchanged","relPath":"p1/alpha.md"}
```

File body is the intended Markdown: JSON frontmatter (`id/projectId/scope/key/title/sourceKind/
sourceRef/status:'fact'/evidence:null/updatedAt`) + `# Alpha Fact` + body.

Rebuild (twice, then after the non-fact README was removed from the repo):

```sh
curl -X POST ... -d '{}' $B/api/memory/rebuild
# run 1/2: HTTP 200 {"ok":true,"status":"rebuilt","projectId":null,"scanned":1,"inserted":0,
#   "updated":0,"unchanged":1,"quarantined":[],"quarantinedCount":0,
#   "rejected":[{"file":"README.md","reason":"README.md: missing JSON frontmatter"}],"rejectedCount":1}
# after `git rm README.md && git commit -m "drop non-fact readme"`:
# run 3:   HTTP 200 {... "unchanged":1, "rejected":[], "rejectedCount":0}
curl -X POST ... -d '{"projectId":""}' $B/api/memory/rebuild
# HTTP 400 {"error":"invalid_project_id"}
curl -X POST ... -d '{"id":"nope"}' $B/api/memory/export
# HTTP 409 {"error":"memory_conflict","message":"memory not found: nope"}
curl -X POST ... -d '{"id":123}' $B/api/memory/export
# HTTP 400 {"error":"invalid_id"}
```

The README rejection is the documented "files-win, non-frontmatter file is rejected" path, not a
failure. Counts are stable across runs (idempotent). Memory root itself is not echoed in any body.

## 3. Orchestrator run — VERIFIED (rejection paths), real run NOT ATTEMPTED

Seeded a plan with one `pending` item (`item-pending`) to exercise the unassigned branch.

```sh
curl -X POST -H "x-webterm-token: $T" -H 'content-type: application/json' \
  -d '{"projectId":"p1","itemId":"item-pending","expectedVersion":1,"repo":"/etc"}' $B/api/orchestrator/run
# HTTP 400 {"error":"client_controlled_field","message":"repo is resolved server-side and must not be sent"}
# same with "cmd":"sh"
# HTTP 400 {"error":"client_controlled_field","message":"cmd is resolved server-side and must not be sent"}
curl -X POST ... -d '{"projectId":"p1","itemId":"does-not-exist","expectedVersion":1}' ...
# HTTP 409 {"error":"not_assigned","message":"no item does-not-exist in plan plan-p1"}
curl -X POST ... -d '{"projectId":"p1","itemId":"item-pending","expectedVersion":1}' ...
# HTTP 409 {"error":"not_assigned","message":"item item-pending is pending; assign a task to it before running"}
curl -X POST ... -d '{"projectId":"nope","itemId":"x","expectedVersion":1}' ...
# HTTP 409 {"error":"not_assigned","message":"project nope has no repo path"}
curl -X POST ... -d '{"projectId":"p1","itemId":"item-pending"}' ...
# HTTP 400 {"error":"invalid_expected_version"}
curl -X POST ... -d '' ...
# HTTP 400 {"error":"invalid_body"}
```

No side effects: `$ACC/data/worktrees` absent, `git -C "$ACC/repo" worktree list` shows only the
main worktree, and the server process had no children (`pgrep -P <server-pid>` empty). A real run
was deliberately not attempted (see "Blocked").

## 4. Body caps / malformed / methods / 404 — VERIFIED

```sh
head -c 17000 /dev/zero | tr '\0' 'a' > big.bin
curl -X POST -H "x-webterm-token: $T" -H 'content-type: application/json' \
     --data-binary @big.bin $B/api/central/projects/p1/pause
# HTTP 413 {"error":"payload_too_large"}     (same 413 for /api/orchestrator/run and /api/memory/export)
# exact boundary: 16384 bytes -> HTTP 400 {"error":"invalid_json"}; 16385 bytes -> HTTP 413
curl -X POST ... -d '{bad' <each of the three routes>
# HTTP 400 {"error":"invalid_json"}
curl -X POST ... -d '' $B/api/memory/export      # HTTP 400 {"error":"invalid_body"}
curl -X POST ... -d '' $B/api/orchestrator/run   # HTTP 400 {"error":"invalid_body"}
curl -H "x-webterm-token: $T" $B/api/orchestrator/run
# HTTP 405 {"error":"method_not_allowed"}     (GET is not a POST surface)
curl -H "x-webterm-token: $T" $B/api/memory/export           # HTTP 405 {"error":"method_not_allowed"}
curl -H "x-webterm-token: $T" $B/api/central/projects/p1/pause # HTTP 405 same
curl -X POST ... -d '{}' $B/api/central/portfolio            # HTTP 405 same
curl -H "x-webterm-token: $T" $B/api/central/does/not/exist  # HTTP 404 {"error":"unknown route"}
curl -H "x-webterm-token: $T" $B/api/memory/unknown          # HTTP 404 {"error":"unknown route"}
curl -H "x-webterm-token: $T" "$B/api/central/portfolio?limit=abc" # HTTP 400 {"error":"invalid_limit"}
```

Deviation from the literal checklist: `POST /api/central/projects/p1/pause` with an EMPTY body
returns `HTTP 200` (`{"project":{"status":"paused"},"changed":true}`). Pause/resume are bodyless
actions, so this is correct behavior, but it means "empty body -> 400" only holds for memory and
orchestrator, which do require a payload. The central body parser only engages when the body is
non-empty.

## 5. Channels (Telegram) on 8824 — VERIFIED

Boot: `PORT=8824 WEBTERM_LEDGER=on WEBTERM_TELEGRAM=on
WEBTERM_TELEGRAM_WEBHOOK_SECRET="$(cat "$ACC/secret.txt")"` and **no** `TELEGRAM_BOT_TOKEN`.
Log: `telegram egress disabled: TELEGRAM_BOT_TOKEN is not set (ingress stays on)` then
`telegram channel: on (POST /webhooks/telegram)` — ingress/bindings live without egress.

```sh
P=http://127.0.0.1:8824/api/channels/telegram/bindings
curl -H "x-webterm-token: $T" $P              # HTTP 200 {"channel":"telegram","items":[]}
curl $P                                        # HTTP 403 forbidden (no token)
curl -X POST -H 'content-type: application/json' -d '{"projectId":"p1","chatId":"12345","role":"viewer"}' $P
# HTTP 403 forbidden
curl -X POST -H "x-webterm-token: $T" -H 'content-type: application/json' \
     -d '{"projectId":"p1","chatId":"12345","role":"viewer"}' $P
# HTTP 201 {"ok":true,"created":true,"binding":{"channel":"telegram","chatId":"12345",
#   "projectId":"p1","role":"viewer"}}
curl -X POST ... -d '{"projectId":"p1","chatId":"-100123","role":"approver"}' $P
# HTTP 403 {"error":"group_approval_role_denied"}      (group approval role rejected)
curl -X POST ... -d '{"projectId":"p1","chatId":"-100456","role":"viewer"}' $P
# HTTP 201 {"ok":true,"created":true,...role":"viewer"}
curl -X POST ... -d '{"projectId":"p1","chatId":"999","role":"approver"}' $P
# HTTP 201 (private chat approval role allowed)
curl -X POST ... -d '{"projectId":"p1","chatId":"12345","role":"operator"}' $P
# HTTP 200 {"ok":true,"created":false,...role":"operator"}   (re-post updates)
curl -X POST -H "x-webterm-token: $T" -H 'content-type: text/plain' -d x $P  # HTTP 415
curl -X POST ... -d '{bad' $P                                                # HTTP 400 {"error":"invalid_json"}
curl -X PUT -H "x-webterm-token: $T" $P                                      # HTTP 405
curl -X DELETE -H "x-webterm-token: $T" $P                                   # HTTP 400 invalid_chat_id
curl -X DELETE -H "x-webterm-token: $T" "$P?chatId=12345"                    # HTTP 200 {"ok":true,"chatId":"12345"}
curl -X DELETE -H "x-webterm-token: $T" "$P?chatId=12345"                    # HTTP 404 {"error":"unknown_binding"}
```

Node token (real one, obtained by opening a WS agent node on 8824 with `cmd='echo
NODETOKEN=$WEBTERM_TOKEN; sleep 2'`; the socket was closed without a `close` message so the token
stayed in the process registry):

```sh
curl -H "x-webterm-token: $NODE_TOKEN" http://127.0.0.1:8824/api/agent-status
# HTTP 404 {"error":"unknown route"}   vs   no token -> HTTP 403 forbidden
# => the gate ACCEPTED this node token (same answer as the root token), it is genuinely valid
curl -H "x-webterm-token: $NODE_TOKEN" http://127.0.0.1:8824/api/channels/telegram/bindings
# HTTP 403 forbidden                  (node tokens are not on the bindings allowlist)
```

Webhook (secret header `x-telegram-bot-api-secret-token`):

```sh
curl -X POST ... -d '{"update_id":1}' http://127.0.0.1:8824/webhooks/telegram
# HTTP 401 {"ok":false,"error":"missing_secret_token"}
curl -X POST ... -H 'x-telegram-bot-api-secret-token: wrong...' ...   # HTTP 401 {"ok":false,"error":"bad_secret_token"}
curl -X POST -H "x-telegram-bot-api-secret-token: $SECRET" \
     -H 'content-type: application/json' -d '{"update_id":1}' ...    # HTTP 200 {"ok":true}
curl -H "x-telegram-bot-api-secret-token: $SECRET" ...               # HTTP 405 {"ok":false,"error":"method_not_allowed"}
```

## 6. Log hygiene — VERIFIED

For `server-8822.log`, `server-8823.log`, `server-8824.log`:

* root token hits: 0 · webhook secret hits: 0 · node token hits: 0
* stack-trace / `Error:` / `TypeError` / `ReferenceError` hits: 0
* total log lines: 2, 2, 4 — only boot lines (`ledger on: <path>`, egress disabled, listening
  with `token on: len=48`). No request body, header, or token was logged.
* No response body observed in this run contained an absolute path, token, secret, SQL, or stack
  trace. Errors are the documented compact codes (`payload_too_large`, `invalid_json`,
  `not_assigned`, `memory_conflict`, `group_approval_role_denied`, ...). The 500 sanitizers were
  not triggered.

## Verdict

| Area | Result |
| --- | --- |
| Central portfolio/project/pause/resume/priority + events | VERIFIED |
| Central/memory/orchestrator flag-off 503 (`*_off`) | VERIFIED |
| Memory export 200, 0600 file, git commit, relPath | VERIFIED |
| Memory rebuild idempotent counts, error mapping | VERIFIED |
| Orchestrator client-controlled fields 400 | VERIFIED |
| Orchestrator unknown/unassigned 409, no worktree/PTY | VERIFIED |
| 16 KiB cap (413 at 16385, 400 at 16384 non-JSON) | VERIFIED |
| Malformed/empty semantics, 405s, unknown 404s | VERIFIED (central empty body = 200, see deviation) |
| Bindings root auth, 201 create, group approval denial, group viewer 201 | VERIFIED |
| Bindings no-token 403 and valid node-token 403 | VERIFIED |
| Webhook 401 missing/bad secret, 200 good, 405 wrong method | VERIFIED |
| No token/secret in logs; no temp paths in responses | VERIFIED |
| Real orchestrator agent run (worktree + PTY + verify) | BLOCKED by instruction (not attempted) |

Dead wiring found: none. Every flag-gated route answered with the expected flag-specific code and
every success path reached its handler; the only deliberately unexercised branch is a successful
worker run (would spawn a real agent), which this acceptance run was told not to do.

Cleanup: all three server PIDs (62819/77549/82473, verified as the temp `bun .../src/server/index.ts`
processes) were terminated; no child PTYs existed. `/tmp/wt-accept-fBEggC` and the scratch payload
files were removed. Ports 8822-8824 were free before and after. Ports 8799 and 3001 were never
contacted.
