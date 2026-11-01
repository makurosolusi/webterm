# QC security review — P3 approval / channel / memory / orchestrator (`11f1f07`, `9bcf8f5`, `c7c0eda`)

Read-only review. `src/` was not modified. Probes live outside the repo under
`/Users/bip/.jcode/scratch/p3probe/`; three throwaway servers were booted on
`127.0.0.1:8791-8793` with `WEBTERM_DATA_DIR` pointed at that scratch dir and then stopped.
`RND/qc/p3-security.md` is the only file written by this review.

Scope: `approvalHumanApi`, `control/approvalApi` + `approvalMount` + `capabilities`,
`channels/{webhook,telegram,channelDispatch,channelApprovals,channelsRuntime,channelStore,identity}`,
`orchestrator/{approvalGate,verify,verifier,worktree,caps}`, `memory/{memoryCore,memoryWrite,memorySearch}`,
`inbox/*`, `client/{InboxPanel,inboxApprovalDialog,inboxApi}`, plus the transport gate (`auth.ts`,
`index.ts`) they all sit behind.

**Verdict:** the capability model, replay/digest checks at the ledger, FTS hardening, webhook
constant-time compares and size caps are sound. Two real defects remain: (H1) in the default
loopback configuration *any local process, including an agent shell, is the human approver*, and
(H2) the control-plane approval idempotency window is dead in production wiring. Both are
reproduced below against a real server.

| # | Severity | Finding |
|---|---|---|
| H1 | High | Default loopback mode: an agent with a shell can request, read the nonce, approve and consume its own action via `/api/approvals` |
| H2 | High | Approval replay/idempotency broken: `mount.ts` builds a fresh `ApprovalDeps` per request, so every request gets a new `AckStore` |
| M1 | Medium | No separation of duties for approval verbs; `actor` is caller-supplied, so a capability holder can record `approvedBy: "human"` |
| M2 | Medium (latent) | Memory authority is caller-declared: `actorKind` travels in the input, so a worker can create `core` scope and promote fabricated evidence |
| M3 | Medium | Telegram webhook secret may be 1 character and there is no rate limit → guessing + `update_id` poisoning |
| M4 | Medium | Verifier runs worker-controlled `npm test` with `HOME` in env and (by default) no scope restriction |
| M5 | Medium | Inbox "review" of a task creates a fake approval as a side effect; approving it does nothing |
| L1 | Low | `git worktree add` follows a symlink at `root/task-<id>` and writes outside the configured root |
| L2 | Low | `ledger.db`/WAL are `0644` while the channel store enforces `0600`; pending nonces and request payloads are readable |
| L3 | Low | `/api/approvals` uses a loose `startsWith`; body cap counts characters, and oversize bodies are not drained |

---

## H1 — Default loopback mode has no human/agent separation for approvals

`src/server/approvalHumanApi.ts:73` (`startsWith('/api/approvals')`), `:80` (GET challenge),
`:102` (request), `:116` (decide), `:130` (consume).
`src/server/index.ts:56` `allowed()`, `:94`/`:108` (gate applied to `/api/*`).
`src/server/auth.ts:147` `authorizeRequest`, with `tokensMatch()` returning `true` when
`expectedToken === undefined`.

The route is deliberately capability-free ("an agent must not approve its own irreversible
action"), but the only gate it has is the transport token, and in the default configuration
(`HOST=127.0.0.1`, no `WEBTERM_TOKEN`) that gate is *open*. `sameOrigin()` only rejects requests
that carry a browser `Origin`; a non-browser client sends none, so it passes
(`auth.ts` `sameOrigin`: "Origin ABSENT means a non-browser client (curl, the CLI, the tests)").
`GET /api/approvals/challenge?id=…` then hands out `digest` **and `nonce`** in plaintext.

Every agent PTY runs as the same uid on the same host and can `curl` loopback, so
"human approval" is not separated from "agent" in the default install. This defeats the P3
invariant even though the capability layer itself is correct.

**Repro** (real server, `WEBTERM_DATA_DIR=/tmp/… WEBTERM_LEDGER=on HOST=127.0.0.1 PORT=8791`,
no token, one `project` row seeded):

```
POST /api/approvals/request  {"projectId":"pwn","kind":"destructive","request":{"action":"delete-db"}}
 -> 201 {"id":"e6b30…","digest":"364d8…","nonce":"60b1d…"}
GET  /api/approvals/challenge?id=e6b30…      -> 200 {digest, nonce, status:"pending"}
POST /api/approvals/decide   {id,digest,nonce,approve:true} -> 200 {"status":"approved"}
POST /api/approvals/consume  {id,digest}     -> 200 {"ok":true}      (2nd call -> 409, correct)
Origin: http://evil.example                  -> 403 (browser path is blocked)
no Origin header                             -> accepted (this is the hole)
```

Transport matrix (probe `auth-probe.ts`), which also confirms the *intended* separation works:

```
node-token  /api/approvals/decide          => false     # node tokens are correctly refused
node-token  /api/control/approval/decide   => true      # transport ok, handler still 401s
capability  /api/approvals/decide          => false     # capability cannot reach the human route
capability  /api/control/approval/decide   => true
loopback, no token, no headers             => true      # <-- H1
```

So the flaw is configuration-level, not a bypass of `authorizeRequest`: with
`WEBTERM_TOKEN` set the gate holds (verified: `challenge` without the token returns 403), and PTY
children do **not** inherit it (`ptyShell.ts` `LEAKED_ENV` strips `WEBTERM_*`; `sessions.ts:199`
injects the per-node token as `WEBTERM_TOKEN` only for agent sessions).

**Impact:** an agent shell can fabricate consent (`kind` and `request` are attacker text,
`actor` defaults to `"human"`) for any action a future `runApproved()` consumer gates, in the
default zero-config deployment.

**Minimal fix:** make the human approval family refuse token-free loopback. In `authorizeRequest`
(or at the `index.ts` call site) require `expectedToken !== undefined` for
`pathname.startsWith('/api/approvals')`, and start with a generated token when the operator has
not set one — or gate it behind an explicit `WEBTERM_ALLOW_LOOPBACK_APPROVAL=1`. Regression test:
`authorizeRequest({expectedToken: undefined, pathname: '/api/approvals/decide'})` must be `false`.
Cheap defence in depth: have `GET /challenge` return the nonce only when the caller proved the
root token, never in the token-free mode.

## H2 — Approval idempotency window is dead in production wiring

`src/server/control/mount.ts:136-139` passes a **new object literal** as `ApprovalDeps` on every
request:
```ts
{ capabilities: deps.capabilities, approval: activeLedgerRuntime()?.ledger.approval, now: deps.now }
```
`src/server/control/approvalApi.ts:65-70` keys the `AckStore` WeakMap on that object
(`stores = new WeakMap<ApprovalDeps, AckStore>()`), so each request allocates a fresh ack store.
`mount.ts` already warns about exactly this for `ControlDeps` ("PENTING: hasilnya di-cache di level
modul … kalau tiap request membuat objek deps baru, jendela replay 10 menit tidak pernah berlaku
di produksi (B2)") — the approval seam repeats the bug it documents. Unit tests miss it because
`approvalApi.test.ts` reuses one deps object (`it('replays the same requestId …')`) and
`approvalMount.test.ts` only issues one request.

**Repro** (server `:8792`, root token + `WEBTERM_ALLOW_TOKEN_MINT=1`, capability
`approval.request`/`project:p1`), same `requestId` twice:

```
POST /api/control/approval/request {"requestId":"req-aaaaaaaa-1","projectId":"p1",…}  -> 201 id A
POST /api/control/approval/request {"requestId":"req-aaaaaaaa-1","projectId":"p1",…}  -> 201 id B
GET  /api/control/approval/list?projectId=p1 -> two pending rows, same requestId, different nonces
```

and a retry of a successful decision no longer replays the 200:

```
POST …/decide (requestId req-self-approve-2) -> 200 {"status":"approved"}
POST …/decide (same requestId)               -> 409 {"error":"approval_not_pending"}
```

**Impact:** duplicate approval cards / nonces for one requested action (operator fatigue, two
distinct secrets for one action), and a client that retries after a lost response sees "already
decided" instead of the original result. The documented idempotency contract of the control plane
does not hold on the approval family.

**Minimal fix:** build the approval deps once and reuse the same identity, e.g. memoize in
`mount.ts` alongside `defaultDeps` (`approvalDeps ??= { capabilities: deps.capabilities,
approval: port, now: deps.now }` keyed by the `ControlDeps` object), or pass an explicit
`acks` store that lives with the ledger runtime. Test at the mount level: two `handleControlHttp`
calls with the same `requestId` must yield one row.

## M1 — Approval verbs have no separation-of-duties invariant

`src/server/control/capabilities.ts:24-35` (`approval.request`/`decide`/`consume`/`read` are
independent verbs), `approvalApi.ts:184` (decide uses `scopedApproval(... 'approval.decide')`),
`approvalApi.ts:194` (`actor = textField(body.actor, …)`), `ledgerApproval.ts:212`
(`approved_by = actor`).

Nothing prevents one actor from holding `approval.request` and `approval.decide` for the same
project, and the approver name comes from the request body. A single capability holder is therefore
a self-approver that writes any actor string.

**Repro** (server `:8792`, all three capabilities minted for the same caller, request+decide on
`project:p1`):

```
request -> 201 {id,digest,nonce}
decide  -> 200 {"status":"approved","approvedBy":"human","actor":"human"}
consume -> 200 {"ok":true}
```

**Impact:** if the deployment grants `approval.decide` to the orchestrator/central agent (the
obvious way to let it proceed after a Telegram decision), consent becomes self-service and the
audit row is forgeable. The ledger is fine; the grant policy is the gap.

**Minimal fix:** record `mintedBy`/requester identity on the approval and reject
`decide`/`consume` when the deciding capability's identity equals the requester's (store
`requested_by` on the decision row); do not accept `actor` from the body on the capability path —
derive it from the capability record.

## M2 — Memory authority is caller-declared (latent, no HTTP write route yet)

`src/server/memory/memoryCore.ts:93` (`actorKindOf(value) => value ?? 'worker'`),
`memoryWrite.ts:87,118` (`actorKind = actorKindOf(input.actorKind)`),
`memoryCore.ts:98-111` (`assertCanPromote` trusts that value), `:120-146` (`validateEvidence` is
structural only: it never proves the command ran).

**Repro** (probe `memory-probe.ts`, in-memory ledger):

```ts
claimMemory(db, {…, scope: 'core', actor: 'worker-9', actorKind: 'human'})   // accepted
promoteMemory(db, {id, actor: 'worker-9', actorKind: 'human',
  evidence: {command: 'echo hi', exitCode: 0, observedAt: T0}})              // -> status fact, scope core
searchMemory(db, 'p1', 'main')                                               // hit
```

The rule "workers may only claim" is enforced against a field the worker supplies. `memoryApi.ts`
currently exposes only `GET /api/memory` and `/api/memory/search`, and nothing in the wiring calls
`claimMemory`/`promoteMemory`, so this is **latent**; it becomes a live privilege escalation the
moment a write route (or an orchestrator API that forwards a request body) is added.

**Minimal fix:** drop `actorKind` from the input types and pass it as a separate, server-derived
argument (`{ actorKind, actorId }`) from the authenticated caller; make `MemoryActorKind` part of
`LedgerContext`-like deps, not of the payload. For evidence, store the server-issued verification
digest (as `verifier.ts` does) instead of free text.

## M3 — Telegram webhook: 1-character secret accepted, no rate limit

`src/server/channels/channelsRuntime.ts:27` `const SECRET_SHAPE = /^[A-Za-z0-9_-]{1,256}$/`,
`:149` only checks that shape. `webhook.test.ts` never covers a minimum length.
`respondToWebhook` has no throttle (`401` for every attempt; probe: 40 parallel wrong-secret POSTs
→ 40 × `401`, no `429`).

**Impact:** an operator-supplied 1-8 character secret is guessable online in tens of requests.
With the secret, an attacker can (a) `claimUpdate(updateId)` arbitrary ids and thereby drop real
Telegram commands before they arrive (`channelStore.claimUpdate` is persisted and consulted before
dispatch), and (b) drive `/status`/`/inbox` against bound chats. `/approve` still needs a bound
chatId+userId and the chat-only digest/nonce, so this is not a direct consent bypass.

**Minimal fix:** require ≥ 24 characters (Telegram's own recommendation), and add a small
per-IP/token-bucket rejection (e.g. 30 failures/minute → 429 with `Retry-After`) before
`verifyTelegramSecret`. Also redact values shorter than 6 chars consistently (`redactSecrets`
silently skips them, so a short secret would survive in an error string).

## M4 — Verifier executes worker-controlled repository scripts with credentials reachable

`src/server/orchestrator/verify.ts:105` (`DEFAULT_COMMANDS.test = npm test`), `:182`
(allowlisted executable only, argv fixed), `:246` (scope violations short-circuit *before* tests),
`src/server/orchestrator/verifier.ts:130-139` (`cleanEnv` keeps `PATH, HOME, TMPDIR, LANG, LC_ALL`).

`execFile` with `shell: false` and server-owned argv is correct (no command injection through
task/plan data), and scope violations do stop the run. But `npm test` executes `package.json`
scripts from the worktree the worker just wrote, running as the server uid with `HOME` set: the
script can read `~/.ssh`, `~/.aws`, `~/.webterm-server/ledger.db` (all same-uid anyway) and reach
the network. With `scope` omitted (the default in `VerifyInput`), editing `package.json` is not a
scope violation either.

**Impact:** the verifier is a code-execution sink for worker-authored content. Same-uid agents can
already run shell commands, so this is not an escalation for the local threat model, but it makes
"verification is independent of the worker" weaker than it reads, and it is the one place the
server executes untrusted text on its own.

**Minimal fix:** require a non-empty `scope` for verified runs (reject `[]` unless
`options.allowUnscoped`), drop `HOME` from `cleanEnv` (set a scratch `HOME` under the worktree),
and document that `npm test` is trusted code.

## M5 — UI review of a task creates a real approval that nothing consumes

`src/client/InboxPanel.tsx:182-200`: `beginReview` branches on `item.kind`; for anything that is not
`approval` it calls `requestApproval({kind: item.kind, projectId: item.projectId,
request: {itemId, title, detail}})`, i.e. the operator clicking "review" *creates* a pending
approval row whose digest covers the item title (worker/plan controlled) and whose only consumer
is the dialog itself.

**Impact:** "Approve" on a `claimed_done`/`blocked` task records and consumes an approval that no
executor is bound to — a green "Approved action" for an action that never runs — while the actual
task verdict path (`verifyWorkerResult` / approval gate) is untouched. It also lets the same task
be approved repeatedly with different titles/digests. This is a consent-integrity bug, not an
authz bypass (`canApprove` still needs checkbox + literal `APPROVE`, and the dialog never
auto-approves).

**Minimal fix:** make review of task items a *decision* flow (task status transition), not
`/api/approvals/request`; only `kind === 'approval'` items may open `getApprovalChallenge`.
If a plan-item approval is wanted, mint it server-side in `startWorker` with a digest over the
action the orchestrator will actually execute, and reject `requestApproval` from the UI for tasks.

## L1 — Symlink at the worktree target is followed by git

`src/server/orchestrator/worktree.ts:207` (`assertInsideRoot(root, join(root, 'task-'+taskId))`),
`:214` (`git worktree add -b branch path baseRef`). `taskId`/`branch`/`repo`/`baseRef` validation
is solid (probe: `../evil`, `a..b`, `-b`, `x.lock`, `main;rm -rf ~`, `main$(curl evil)` all
rejected; exec is argv-only, no shell). `assertInsideRoot` is, however, purely lexical: it never
`lstat`s the target. Probe against real git:

```
ln -s /tmp/outside root/task-t1
git -C repo worktree add -b feat /abs/root/task-t1 HEAD   -> exit 0, files land in /tmp/outside
```

`release` is safe against the same trick (`git worktree remove --force <symlinked path>` →
`fatal: validation failed … '.git' does not exist`, victim untouched), and it always passes
`--force`, so uncommitted work in a legitimate worktree is discarded silently.

**Impact:** defence-in-depth only (writing under `root` requires write access the same-uid agent
already has). Worth fixing because the check advertises confinement it does not provide.

**Minimal fix:** `lstatSync(path)` and refuse if it exists and is a symlink (or is not a
directory) before `git worktree add`; for `release`, refuse `--force` unless the caller explicitly
declares the worktree disposable.

## L2 — Ledger file permissions vs channel store permissions

`src/server/ledger/migration.ts:163-168` opens the DB with `WAL`, no `chmod`.
Observed on the probe data dir: `ledger.db` `0644`, `ledger.db-wal` `0644`, `webterm.db` `0644`, while
`channels/channels.json` is `0600` in a `0700` dir (`channelStore.ts` `ensureDir`/`save`).
Pending approvals store `decision.nonce` and `approval.request_json` in that file.

**Impact:** on a box where `$HOME` is traversable by other users, the approval nonce (the "prove
you saw the challenge" secret) and request payloads are world-readable. For the same-uid agent
model it changes nothing — which is itself an argument for H1's fix, since the nonce is only ever
a same-uid secret.

**Minimal fix:** `chmod 0600` the ledger file (and `0700` its dir) after open, matching the
channel store; do the same for `webterm.db`.

## L3 — Smaller notes

- `approvalHumanApi.ts:73` uses `startsWith('/api/approvals')`, so `/api/approvals-x` is answered
  405/404 by this handler instead of falling through; a future sibling route would be swallowed.
  Use exact/segment matching like `isControlPath`.
- `approvalHumanApi.ts:16-24` `readBody` counts `data.length` (UTF-16 units, not bytes) and does not
  `req.resume()`/`destroy()` on overflow, so an 8 KiB cap can be exceeded by multibyte payloads and
  the socket is left half-read. Reject with 413 and drain.
- `approvalApi.ts:204` recomputes `approvalDigest(approval.request)` from the stored JSON while
  `requestApproval` digested the input object; an in-process caller passing `undefined`-valued keys
  creates an approval that can never be decided (`digest_mismatch`). Not reachable over HTTP
  (JSON has no `undefined`). *(speculative, in-process only)*
- `memorySearch.ts` `memoryEvents` takes a `memoryId` with no project scoping, and
  `ledgerCore.requireText` imposes no length cap, so future write/read routes would allow
  cross-project event reads and unbounded `body`/`title`. *(latent; no route today)*

---

## Verified good (probes + targeted suites)

- Transport gate (`auth-probe.ts`): node tokens and capabilities are both refused on
  `/api/approvals/*`; capabilities are refused outside `/api/control/*`; the control handler still
  returns 401 without a capability even when the transport accepted the node token.
- Ledger consent: digest is keyed-sorted SHA-256 of the request; `decide` requires `pending`,
  rejects expiry/digest/nonce mismatch; `consume` is single-use (2nd `consume` → 409; decide after
  approve → `approval_not_pending`).
- Nonce is **not** exposed by `GET /api/control/approval/list` (the row mapper emits only
  `toApproval` fields, which exclude `nonce`) nor by `GET /api/inbox` (`payload = request_json`,
  not the decision row). It is exposed by the human `challenge` route (H1) as designed for the UI.
- Webhook: wrong/missing `x-telegram-bot-api-secret-token` → 401, GET → 405, declared-length and
  chunked oversize both → 413 (cap enforced before parse and before dispatch), replay of a valid
  update → `{"ok":true,"duplicate":true}`, group and unbound chats denied before any effect,
  `safeEqual` is length-guarded + constant-time, no secret or body text in responses/log lines,
  store is `0600`/`0700` and contains ids only.
- FTS: `toFtsQuery` quotes every token (`" OR body:"push` became `"or" OR "body" OR "push"`, no
  syntax error, no cross-project hit); `searchMemory` filters `project_id` + `status='fact'` +
  `superseded_at IS NULL`.
- Worktree/branch validation and argv-only exec (see L1); verifier caps output, injects a local
  deadline, and only stores digests.
- UI: inbox rendering is text-only (no `dangerouslySetInnerHTML` in the inbox path), approval
  requires a checkbox plus the literal `APPROVE` among enabled fields, focus is trapped, Escape
  closes, Consume is offered only after `status === 'approved'`, no auto-approve, errors surface a
  short typed message rather than a raw body.
- Tests run during review: `vitest` 9 files / 139 tests (control approval+capabilities, auth,
  inboxApi, memoryApi, orchestratorApi, webhook, channelDispatch, approvalMount) and
  `bun test` 29 tests (memory, approvalGate, ledgerRoutes, inbox, migration) — all pass. H2 is not
  covered by any of them; H1 has no test at all.

## Not tested / out of scope

- Nothing was run against a real Telegram bot or a real approval executor; `runApproved` has no
  production caller yet (only `approvalGate.bun.test.ts`), so H1/M1 impacts are stated against the
  intended consumer, not an observed execution.
- The destructive `git worktree remove --force` symlink case was only probed in the non-destructive
  direction (git refused); the "dirty worktree is discarded" behaviour is documented, not simulated.
- Multi-user host exposure (L2) depends on the operator's `$HOME` mode; this review measured
  `0750` here.
