# QC integration review — P3 HTTP/UI/ledger path

Branch `feature/agent-pusat-p3` @ `c7c0eda`. Read-only review: **no `src` file was modified**;
only this report was written. All probes ran against scratch data in `/tmp/wt-p3` on ports
8891-8895 (the user's 8799/8810 processes were never touched; my listeners were stopped after).

## How it was verified

Not unit tests only. Five real servers were started from `src/server/index.ts` in
`NODE_ENV=production`, against a seeded ledger (`/tmp/wt-p3/ledger.db`: project `p1`, agent `a1`,
tasks `t-blocked`/`t-review`/`t-failed`, two pending approvals, one promoted memory row), and every
path below was driven with `curl`. A sixth probe called `handleControlHttp` directly against an
in-memory ledger to isolate the ack-store bug.

| port | env | purpose |
| --- | --- | --- |
| 8891 | `WEBTERM_LEDGER=on`, loopback, no token | reads, human approvals, webhook absent |
| 8892 | ledger off | `ledger_off` matrix |
| 8893 | `WEBTERM_TELEGRAM=on` + secret | webhook dispatch |
| 8894 | `WEBTERM_TOKEN=tok123`, `WEBTERM_ALLOW_TOKEN_MINT=1` | token gate + control plane |
| 8895 | token + telegram | webhook vs `/api` gate ordering |

Tests also run: `npm run typecheck` (clean), `npx vitest run` on the 7 P3/P4 files (69 pass),
`bun test src/server/{ledgerRoutes,migration,inbox,memory}*.test.ts` (25 pass). Everything green —
which is exactly why the findings below matter: none of them is covered by a test.

---

## Verdict

**Read path: works. Write/decide path: not production-ready.**

The four families (`/api/inbox`, `/api/memory*`, `/api/orchestrator/*`, `/api/approvals/*`) are
mounted, authorized, and return the documented shapes and status codes against a real DB. The human
approval flow (challenge -> decide -> consume -> inbox count changes) is genuinely end-to-end over
HTTP. But the *control* plane's `requestId` idempotency is dead code in production (B1), **no
approval can be linked to a task at all** (B2), and nothing consumes an approval into an action
(B16). The two approval surfaces also answer with different error taxonomies (B5).

Three blockers, then majors, then minors.

---

## B1 — BLOCKER: `requestId` idempotency is dead on every approval route

`src/server/control/mount.ts:136-139` builds the approval dispatcher's deps as an **object literal
per request**:

```ts
const approval = await approvalRoute(
  { ...request, path: `${path}${url.search}` },
  { capabilities: deps.capabilities, approval: activeLedgerRuntime()?.ledger.approval, now: deps.now }
)
```

`approvalApi.ts` keys its `AckStore` in a `WeakMap` by that deps object identity
(`const stores = new WeakMap<ApprovalDeps, AckStore>()`, `storeFor`). A fresh literal every request
means a fresh `AckStore` every request, so the 10-minute replay window never exists. This is the
same B2 bug `mount.ts` warns about for `ControlDeps` (its own `defaultDeps`/`mergedDeps` memo),
reintroduced one layer below it.

Reproduced with identical `requestId` and a valid capability token against a live ledger:

```
POST /api/control/approval/request  {"requestId":"ctlreq-0001","projectId":"p1","kind":"task","request":{...}}
-> 201 {"id":"43f1cc12-…"}
POST (same body, same requestId)
-> 201 {"id":"08eba649-…"}        # different id, second row
```

and isolated via `handleControlHttp` (`/tmp/wt-p3-ack.ts`):

```
0 201 {"id":"1b61d713-…"}
1 201 {"id":"37cb1a63-…"}
approvals in db: 2
```

`decide` replay is broken the same way — same `requestId`, correct digest/nonce:

```
1st -> 200 {"ok":true,…,"status":"approved"}
2nd -> 409 {"error":"approval_not_pending","status":"approved"}
```

Impact: a retried request (network blip, agent restart, UI double click) mints a second live
consent challenge. On the human surface there is no ack store at all (B3), so the same is true
there by construction.

**Fix:** hoist the approval deps to a module constant in `mount.ts` (or key the `AckStore` by
`capabilities`, not by the literal). Add a test that calls `handleControlHttp` twice with one
`requestId` and asserts one row.

## B2 — BLOCKER: task review can never be resolved; approvals are orphans

`approval.task_id` is populated by **no production path**:

- `approvalApi.requestRoute` calls `requestApproval({projectId, kind, request, ttlMs})` — `taskId`
  from the body is never forwarded (`src/server/control/approvalApi.ts`, requestRoute).
- `approvalHumanApi` has no `taskId` field at all (`src/server/approvalHumanApi.ts:102-113`).

Observed: request body with `"taskId":"t1"` stored `task_id: null`; a control request with
`"taskId":"t-review"` also stored `null` (list output below). The schema column, the ledger
`RequestApprovalInput.taskId`, and the whole "review" concept are unwired.

Consequence, verified: clicking Review on the `review` item in the UI posts a *new, unrelated*
approval (`InboxPanel.tsx:196` uses `item.kind` and the item's id only inside the request payload);
deciding and consuming it touches no task row, so the item stays in the inbox forever and each
click adds another one:

```
GET /api/inbox                      -> counts{"needsYou":3,"review":1,"broken":1}
POST /api/approvals/request (task t-review)  -> 201
POST (identical requestId)                   -> 201   # duplicate, see B3
GET /api/inbox                      -> counts{"needsYou":5,"review":1,"broken":1}
GET /api/orchestrator/tasks?projectId=p1 -> t-review still "claimed_done"
```

**Fix:** forward `taskId`, and give the human review surface a verdict path (or explicitly document
that review approvals are advisory only). Right now the UI offers a button that cannot complete.

## B3 — MAJOR: the human request route ignores `requestId` entirely

`/api/approvals/request` never reads `body.requestId` (the client always sends one,
`src/client/inboxApi.ts` `requestApproval`, typed as "Idempotency key for the control plane"). Two
identical requests therefore create two approvals — reproduced above. Because the control route is
the only one with an ack store, and it is broken (B1), **no approval creation path is idempotent.**

## B4 — MAJOR: approved-but-unconsumed consent is unreachable

The panel only enables Consume when `approvedDigest` is set by a *successful* decide
(`InboxPanel.tsx`, `decide`/`consume`). If decide succeeds but the response is lost, or if consume
fails, the approval is `approved` (so it drops out of `GET /api/inbox`, which lists only `pending`)
and the dialog's retry path cannot reach it. There is no human list route (only
`/api/control/approval/list`, which needs a capability) and `challenge.status` is discarded by the
client (`toChallenge` drops it). Verified server side:

```
GET /api/approvals/challenge?id=<approved>   -> 200 {"status":"approved",…}
GET /api/inbox                               -> item absent
```

So the consent is spent-but-stranded, invisibly. Either surface the approved/unconsumed set
(`/api/approvals?status=approved`) or make decide idempotent (B1/B3) so the retry works.

## B5 — MAJOR: the human surface collapses every decision failure into `409 approval_decision_failed`

`src/server/approvalHumanApi.ts:136-140` maps any non-`invalid_` error to one code. Measured:

| call | human `/api/approvals/decide` | control `/api/control/approval/decide` |
| --- | --- | --- |
| wrong digest | `409 {"error":"approval_decision_failed"}` | `403 {"error":"digest_mismatch"}` |
| wrong nonce | `409 {"error":"approval_decision_failed"}` | `403 nonce_mismatch` (per unit test) |
| already decided | `409 {"error":"approval_decision_failed"}` | `409 approval_not_pending` |

`inboxErrorMessage` in `src/client/inboxApi.ts` branches on `digest_mismatch`, `nonce_reused`,
`approval_expired`, `approval_not_pending` — all of which are unreachable from the route the UI
actually calls, so the operator always sees the generic sentence.

## B6 — MAJOR: human request validation is weaker than the control route (silent misbehaviour)

Measured against 8891:

```
POST {"projectId":"ghost","kind":"deploy","request":{"a":1}}
 -> 409 {"error":"approval_decision_failed"}      # FK violation swallowed; should be 400/404
POST {"projectId":"p1","kind":"deploy","ttlMs":-5,"request":{}}
 -> 201 …expiresAt = now+1000                     # silently clamped to a 1s TTL, already expired
POST {"projectId":"p1","kind":"deploy","ttlMs":"60000"}
 -> 201                                           # string silently ignored -> default 15 min
POST {"projectId":"p1","kind":"<200 chars>",…}
 -> 201                                           # control caps kind at 128, human route at 256
```

The control route rejects `invalid_project_id`, `invalid_ttl`, `invalid_kind` correctly. A negative
TTL producing an instantly-expired approval is a correctness bug, not a nit: the client shows a
countdown that is already over.

## B7 — MAJOR: human body cap reports the wrong status and reads the whole body

`approvalHumanApi.readBody(max = 8 KiB)` rejects at `data.length > max` but:

- the route converts the rejection into `400 {"error":"invalid_json"}` (measured with a 9 KB body)
  — the control route answers `413 {"error":"payload_too_large","max":65536}` (also measured);
- there is no `content-length` pre-check and the accumulator keeps growing after `reject`, so a
  large body is buffered anyway.

## B8 — MAJOR: the inbox projection has no supporting index

The `needs_you` approval branch filters `approval.status` + `expires_at` + `project_id` and orders
by `created_at` (`src/server/inbox/inbox.ts`, `unionSql`). `ledgerSchema.ts` indexes `task`,
`event`, `run`, `usage`, `memory`, `plan_item` — **nothing on `approval`**. The badge polls this
every 30 s from two places (panel and dock, one at a time by design), i.e. a full table scan per
30 s per open client. v2 (the only migration in this branch) adds plan indexes only.

## B9 — MAJOR (P5 scope, but wired into P3 startup): the Telegram channel is inert

The webhook itself is correct — verified on 8893/8895:

```
no secret            -> 401 {"ok":false,"error":"missing_secret_token"}
bad secret           -> 401 {"ok":false,"error":"bad_secret_token"}
good, /status        -> 200 {"ok":true}
same update_id again -> 200 {"ok":true,"duplicate":true}
GET                  -> 405 method_not_allowed
70 KB body           -> 413 body_too_large
gate ordering        -> webhook 200 with no root token; /api/inbox still 403
```

But `ChannelStore.bind` has **no production caller** (grep: only `identity.ts`/`channelStore.ts`
definitions), so every real chat is unbound and every command is denied silently; and the outbox
(`pendingReplies`) has **no sender**, so replies are never delivered. `WEBTERM_TELEGRAM=on` currently
buys a reachable endpoint and nothing else. Docs (`RND/04-OMNICHANNEL.md`) also promise
`off|readonly|control` and a `WEBTERM_CHANNELS` gate; neither exists in code.

## B10 — MINOR: status-code mixups on the human approval routes

```
GET  /api/approvals/challenge            (no id)   -> 404 approval_not_found   # should be 400
POST /api/approvals/nope  {}                       -> 400 invalid_id          # should be 404
POST /api/approvals/nope  {"id":"x"}               -> 404 not_found
GET  /api/approvals                                -> 405 method_not_allowed  (correct)
```

`challenge()` also reads `a.status` straight from the table (no `effectiveStatus`), so an expired
approval reports `"status":"pending"` while `decide` would refuse it.

## B11 — MINOR: badge/section counts are page-1 counts, and `99+` is unreachable

`listInbox` sends no `limit`, so the server caps at 50; `inboxUnread` returns `items.length`
(`inboxDockState.ts:21`) and ignores the server's `total`. With >50 pending items the dock shows
`50` forever and the client can never page. `INBOX_BADGE_MAX = 99` / `"99+"` is dead.

## B12 — MINOR: prefix shadow and duplicated IO helpers

`if (!url.pathname.startsWith('/api/approvals'))` also claims `/api/approvalsXYZ`;
`approvalHumanApi.ts` re-implements `readBody`/`sendJson` instead of the ones in `api.ts`, which is
how B7 drifted from the control route in the first place.

## B13 — MINOR: `plan_unavailable` is effectively dead

`openLedgerDb` always migrates to the latest version, so `plan`/`plan_item` exist whenever a runtime
exists. In `on` mode a broken migration refuses boot; in `shadow` the runtime becomes `null` and the
family answers `503 ledger_off`, never `plan_unavailable`. Confirmed the branch only fires on a
hand-built `user_version=1` DB with the plan tables dropped:

```
plan  -> {"status":503,"body":{"error":"plan_unavailable"}}
tasks -> 200, agents -> 200
```

Harmless, but the comment ("Ledger v1 belum punya tabel plan") describes a state that cannot exist.

## B14 — MINOR: `/api/orchestrator/tasks` cannot be paged

`listTasks` supports `limit`/`offset` and silently clamps; the route exposes neither and returns no
`total`, so a caller cannot page and cannot tell it was truncated.

## B15 — MINOR: memory route hides half of `listMemory`

`status`, `scope`, and `offset` are supported by `listMemory` but not exposed; `limit` is capped at
100 while the default (and the value echoed back) is 200. FTS handling itself is solid — hostile
queries (`a"b`, `AND`, `*`, `don't`, `deploy NEAR(`) all return `200` with neutralised syntax.

## B16 — MINOR (scope): half of P3 has no production entry point

Not imported by any non-test file: `orchestrator/{approvalGate,orchestrator,orchestratorRun,
verify,verifier,worktree,caps}`, `memory/memoryWrite`. Meaning: `/api/orchestrator/plan` is `null`
unless seeded out-of-band (verified: seeded plan renders correctly, including items), memory search
only ever reads an empty table in production, and the gate that is supposed to execute an approved
action is never called. "Consume" in the UI therefore performs no action. Expected for a staged
rollout, but it means the P3 acceptance story ("approve -> action runs") is not demonstrable yet.

## B17 — MINOR: `shadow` is only a log line

`ledgerRuntime.mode` is used exactly once, in a `console.log` (`index.ts:30`). Shadow opens a fully
functional ledger: approvals can be decided and consumed there. The stated "shadow for a week before
enforce" gate has no enforcement point.

## B18 — MINOR (structural): the HTTP layer imports `bun:sqlite`

`approvalHumanApi.ts` imports `activeLedgerRuntime` from `./ledger/ledgerRuntime` (which imports
`bun:sqlite` through `migration.ts`) instead of `./ledger/ledgerRuntimeState`, which re-exports the
same function for exactly this reason and which `api.ts` already uses. No current test imports
`api.ts`, so nothing fails today; the next node-env test that does will.

## B19 — File budget (Rule 8)

| file | lines | budget | note |
| --- | --- | --- | --- |
| `src/server/ledger/ledgerSchema.ts` | 227 | schema 200 | **over** |
| `src/client/inboxApi.ts` | 312 | service 300 | **over** (93 % of hard cap) |
| `src/client/InboxPanel.tsx` | 468 | hard 500 | 94 % — split suggested |
| `src/server/control/approvalApi.ts` | 299 | service 300 | at limit |
| `src/server/api.ts` | 144 | route 150 | 96 % |
| `src/server/approvalHumanApi.ts` | 144 | route 150 | 96 % |
| `src/server/inbox/inbox.ts` | 236 | repository 250 | 94 % |

## B20 — Tests: the surface the UI uses has none

- No test file references `approvalHumanApi` or `/api/approvals` (`grep` over all `*.test.ts` and
  `*.bun.test.ts`).
- No test imports `api.ts`, so dispatch order (the thing that decides 404 vs 405 vs 503 here) is
  unverified.
- `control/approvalMount.test.ts` injects one deps object, which is precisely what hides B1.
- `ledgerRoutes.bun.test.ts` is a good real-DB test of the family modules, but stops short of the
  HTTP edge.

---

## Verified working (commands + codes)

All against 8891 unless noted; seeded data as described at the top.

```
GET  /api/inbox                             200 {items[5], total:5, limit:50, offset:0,
                                                counts:{needsYou:3,review:1,broken:1,total:5}}
GET  /api/inbox?limit=1e3                   400 invalid_limit
GET  /api/inbox?projectId=                  400 invalid_project_id
GET  /api/memory?projectId=p1               200 {projectId,limit:200,items[1]}
GET  /api/memory/search?projectId=p1&q=deploy 200 {rank:-0.000001375}
GET  /api/memory/search?projectId=p1&q=     400 invalid_q
GET  /api/approvals/challenge?id=<pending>  200 {id,digest,nonce,expiresAt,kind,projectId,status}
POST /api/approvals/decide (right digest)   200 {"id":…,"status":"approved"}
GET  /api/inbox (after decide)              200 counts needsYou 2 (approval disappears)
POST /api/approvals/consume                 200 {"ok":true}
POST /api/approvals/consume (again)         409 {"ok":false}
GET  /api/orchestrator/plan?projectId=p1    200 plan:null ; after seeding, full plan + items
GET  /api/orchestrator/tasks?projectId=p1   200 tasks[3]
GET  /api/orchestrator/tasks?status=nope    400 invalid_status
GET  /api/orchestrator/agents?projectId=p1  200 agents[1]
GET  /api/orchestrator/plan (no projectId)  400 invalid_project_id
POST /api/orchestrator/plan                 404 unknown route (read-only family, as documented)
GET  /api/control/approval/list (no cap)    401 unauthorized
GET  /api/control/approval/list (read cap)  200 rows, all statuses, taskId null
GET  /api/control/approval/list (wrong verb) 403 forbidden
GET  /api/ledger                            404 unknown route
```

Ledger off (8892) — every family, including the approval POST:

```
/api/inbox, /api/memory, /api/memory/search, /api/orchestrator/{plan,tasks},
/api/approvals/challenge, POST /api/approvals/request      -> 503 {"error":"ledger_off"}
POST /webhooks/telegram                                    -> 404 (no route installed)
```

Token boundaries (8894/8895):

```
GET /api/inbox, no token                    403 forbidden (plain text)
GET /api/inbox, root token                  200
GET /api/inbox, capability header only      403 forbidden
POST /api/control/token (mint flag + root)  201 {token,expiresAt}
POST /api/control/token (no root header)    403 forbidden
webhook, no root token, good secret         200   (channel precedes the /api gate)
POST /api/approvals/decide with root token  200   (human surface on a token-protected server)
```

## Reproduction

```bash
mkdir -p /tmp/wt-p3 && WEBTERM_DATA_DIR=/tmp/wt-p3 bun /tmp/wt-p3-seed.ts   # seed (see below)
PORT=8891 HOST=127.0.0.1 WEBTERM_DATA_DIR=/tmp/wt-p3 WEBTERM_LEDGER=on \
  NODE_ENV=production bun src/server/index.ts
```

`/tmp/wt-p3-seed.ts` (scratch, not in the repo) opens the ledger through `openLedgerDb`, inserts
project `p1`, agent `a1`, tasks `t-blocked|t-review|t-failed`, and calls
`ledger.approval.requestApproval` twice; a second pass claims + promotes one memory row.

Reproduce B1 alone, no ports:

```bash
bun /tmp/wt-p3-ack.ts   # startLedgerRuntime(':memory:') + handleControlHttp twice, same requestId
```

## Fix order I would take

1. B1 (stable deps object for approval dispatch) + a two-call test — one-line class of bug that
   invalidates a documented contract on every route.
2. B2/B3 (taskId + idempotent human request) — without these the inbox review loop cannot terminate.
3. B5/B6/B7 (share the error/validation helpers with the control route instead of re-implementing
   them in `approvalHumanApi`).
4. B8 index, B10 codes, B11 total, B4 resume path.
5. B9/B16 are honest scope gaps: don't advertise P5 ingress or "approve -> action" until a binding
   route / gate caller exists.
