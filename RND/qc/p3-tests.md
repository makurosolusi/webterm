# QC review — P3 tests (false-confidence + mutation audit)

Branch `feature/agent-pusat-p3`, repo `/Users/bip/Documents/spawn/webterm`, pinned commit `c7c0eda`
("fix(p3): add human approval surface and wire inbox decisions"), bun 1.4.2, node 26.7.0, vitest 5.0.5.

Read-only review of `src`: no source/test file was changed. All mutations ran on a copy at
`$JCODE_SCRATCH_DIR/p3base` (rsync + git init, `node_modules` symlinked). The only repo write is
this report.

Scope: `orchestrator/*.test.ts`, `inbox/*.bun.test.ts`, `memory/*.bun.test.ts`, `channels/*.test.ts`,
`control/approvalApi.test.ts`, `control/approvalMount.test.ts`, `inboxApi.test.ts`,
`orchestratorApi.test.ts`, `client/inboxApi.test.ts`, `client/InboxPanel.test.tsx`, and the
behaviours named in the brief (approvalHuman, task review).

---

## 0. Baseline and gate hole

```
$ npx vitest run src/server/orchestrator src/server/channels \
    src/server/control/approvalApi.test.ts src/server/control/approvalMount.test.ts \
    src/server/inboxApi.test.ts src/server/orchestratorApi.test.ts \
    src/client/InboxPanel.test.tsx src/client/inboxApi.test.ts
20 files, 221 tests passed

$ bun test src/server/orchestrator src/server/inbox src/server/memory src/server/channels
21 files, 193 tests passed, 844 expect() calls
```

The Bun gate documented in `CLAUDE.md` (`bun test src/server/*.bun.test.ts`) still does **not** run
any P3 suite:

```
$ bun test src/server/*.bun.test.ts     -> 85 pass, 13 files   (no orchestrator/inbox/memory/channels)
$ bun test src/server/orchestrator src/server/inbox src/server/memory src/server/channels -> 193 pass
```

`npm test`/`vitest run` excludes `*.bun.test.ts` (`vite.config.ts:13-14`). So **108 P3 assertions
(193-85) live only in a command nobody documents**, including all of `memory.bun.test.ts`,
`inbox.bun.test.ts`, `approvalGate.bun.test.ts`, `plan.bun.test.ts`. This is the same gate hole the
P2 audit reported; it was not fixed.

Note also that `bun test <dir>` also executes the *vitest-style* `*.test.ts` files in those dirs.
That matters below: mutation M9 is killed under Bun but survives under vitest.

---

## 1. Method

One mutable copy, one mutation at a time, `git checkout -- <file>` after each run. KILLED = at
least one assertion fails; SURVIVES = all green. Vitest set = the 8 paths in section 0; Bun set =
the 4 directories in section 0. Extra probes were standalone tests in the copy (not in the repo).

---

## 2. Mutation matrix

| # | Mutation | Site | Vitest | Bun | Killed by |
|---|---|---|---|---|---|
| M1 | gate: remove digest comparison | `orchestrator/approvalGate.ts:74-76` | KILLED | KILLED | `approvalGate.test.ts:120-132`; `approvalGate.bun.test.ts:147-176` |
| M2 | ledger: remove nonce check | `ledger/ledgerApproval.ts:206-208` | KILLED | **SURVIVES** | `approvalApi.test.ts:250-255` only |
| M3 | ledger: remove `single_use` guard | `ledger/ledgerApproval.ts:240` | KILLED | KILLED | `approvalApi.test.ts:316-353`; `approvalGate.bun.test.ts:50-93` |
| M4 | dispatch: remove group denial | `channels/channelDispatch.ts:168-171` | **SURVIVES** | **SURVIVES** | — |
| M5 | webhook: `safeEqual` returns true | `channels/webhook.ts:56-62` | KILLED | KILLED | `webhook.test.ts:38-55,107-124`; `channelsRuntime.test.ts:53-61` |
| M6 | dispatch: ignore `claimUpdate` result | `channels/channelDispatch.ts:215` | KILLED | KILLED | `channelDispatch.test.ts:231-254`; `channelsRuntime.test.ts:217-223` |
| M7 | webhook: `bodyWithinLimit` always true | `channels/webhook.ts:52-54` | KILLED | KILLED | `webhook.test.ts:97-102` only |
| M8 | roles: remove `depth > MAX_SPAWN_DEPTH` | `orchestrator/roles.ts:84-90` | **SURVIVES** | **SURVIVES** | — |
| M8b | `MAX_SPAWN_DEPTH = 2` → `5` | `orchestrator/roles.ts:15` | **SURVIVES** | **SURVIVES** | — |
| M9 | worktree: `assertInsideRoot` returns `resolve(target)` | `orchestrator/worktree.ts:137-153` | **SURVIVES** | KILLED | `worktree.test.ts:207-215`, but only because Bun runs the un-awaited assertions |
| M10 | verify: drop `allowed.includes(file)` | `orchestrator/verify.ts:183` | KILLED | KILLED | `verify.test.ts:90-99` only |
| M11 | memory: `toFtsQuery` returns the raw query | `memory/memoryCore.ts:194-204` | n/a | KILLED | `memory.bun.test.ts:129-153` only |
| M12 | UI: `canApprove` drops both consent guards | `client/InboxPanel.tsx:320` | KILLED | n/a | `InboxPanel.test.tsx:130-152,188-202` |
| M12b | UI: `canApprove` drops only the checkbox | `client/InboxPanel.tsx:320` | **SURVIVES** | n/a | — |
| M13 | API: drop digest pre-check before `decideApproval` | `control/approvalApi.ts:204-206` | SURVIVES (benign) | n/a | ledger re-checks, same 403 |
| M14 | `evidenceVerified` drops the typecheck gate | `orchestrator/orchestratorModel.ts:121` | **SURVIVES** | **SURVIVES** | — |
| M15 | `resolveVerifyCwd` uses `startsWith(root)` | `orchestrator/verify.ts:137-139` | **SURVIVES** | n/a | — |
| M16 | `inScope` uses `path.startsWith(entry)` | `orchestrator/verify.ts:170-174` | **SURVIVES** | n/a | — |

M2, M9 and M13 are single-point-of-failure / inert-assertion problems rather than missing
behaviour. M4, M8, M8b, M12b, M14, M15, M16 are real coverage gaps and are detailed below.

---

## 3. Surviving mutations: exact assertions to add

### 3.1 M4 — group denial is only tested for `/approve`, and the guard is shadowed

`channelDispatch.ts:168-171` blocks every command in a group. The only group test
(`channelDispatch.test.ts:81-91`) sends `/approve`, which is *also* blocked later by
`identity.ts:84-86`, so the dispatch guard is never the deciding check:

```
$ (M4 applied) vitest <8 paths>  -> 221 pass, 20 files;  bun test <4 dirs> -> 193 pass, 0 fail
$ probe: /status in a bound supergroup under M4
PROBE_OUTCOME {"status":"handled","command":"status","reply":"Status: no pending approvals for project p1."}
```

A group mirror can therefore read approvals (`/status`, `/inbox`) if the early guard disappears.
Add to `channelDispatch.test.ts`:

```ts
it('denies non-approval commands in a group and replies nothing', async () => {
  const store = boundStore()
  store.bind('telegram', '-100', { projectId: 'p1', role: 'owner', userId: '7' })
  const replies: ChannelReply[] = []
  const outcome = await dispatchTelegramUpdate(update(20, -100, 7, '/status', 'supergroup'), {
    store,
    approval: fakeApproval([]).port,
    enqueue: (reply) => { replies.push(reply) },
  })
  expect(outcome).toEqual({ status: 'denied', reason: 'group_not_allowed' })
  expect(replies).toEqual([])
})
```

Do the same for `/inbox` and `/pause` if the "groups never mutate" rule is meant to hold for them.

### 3.2 M8/M8b — the spawn depth cap is not pinned to 2

`assertCanSpawn` cannot reach its own `depth > MAX_SPAWN_DEPTH` branch: `assertRoleDepth` already
rejects every parent outside 0..2, and a depth-2 parent must be a worker (`worker_cannot_spawn`).
Consequently both mutations are dead-code changes, and `MAX_SPAWN_DEPTH` itself is only compared
against `MAX_SPAWN_DEPTH + 1` in tests, so raising it to 5 is invisible:

```
$ (MAX_SPAWN_DEPTH=5) vitest <8 paths>  -> 221 pass, 20 files;  bun test <4 dirs> -> 193 pass, 0 fail
```

The actual ceiling is `ROLE_DEPTH` (`roles.ts:8-12`) plus the DB `CHECK (depth BETWEEN 0 AND 2)`.
Pin the constant and the boundary explicitly in `roles.test.ts`:

```ts
it('pins the maximum spawn depth at 2', () => {
  expect(MAX_SPAWN_DEPTH).toBe(2)
  expectCode(() => roleForDepth(3), 'max_depth')   // not just MAX_SPAWN_DEPTH + 1
  expectCode(() => roleForDepth(MAX_SPAWN_DEPTH + 1), 'max_depth')
})
```

If the branch in `assertCanSpawn` is deliberately unreachable defence-in-depth, say so in a comment
(or delete it) so the next reader does not assume it is tested.

### 3.3 M12b — the consent checkbox is not actually required

`InboxPanel.test.tsx:130-152` is named "requires the checkbox AND the exact phrase" but the flow
always ticks the box before typing, and the initial "disabled" assertion is already satisfied by the
empty text. Dropping `dialog.checked &&` from `InboxPanel.tsx:320` stays green:

```
$ (M12b applied) vitest InboxPanel.test.tsx -> 17 pass
```

Add the missing half to the same test, before ticking the checkbox:

```ts
fireEvent.change(screen.getByLabelText('Type APPROVE to confirm'), { target: { value: 'APPROVE' } })
expect(isDisabled(approveButton())).toBe(true)        // correct phrase, consent unchecked
fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
expect(isDisabled(approveButton())).toBe(false)
```

### 3.4 M14 — failing typecheck does not block verification

`evidenceVerified` documents "tests pass **and typecheck green**" (`orchestratorModel.ts:111-123`),
but no test ever passes `typecheck: { ok: false }`. Both `orchestratorRun.test.ts:166-184` cases and
`verifier.test.ts:142-151` vary `tests`/`scopeViolations` only.

Add to `orchestratorRun.test.ts` (and/or a direct unit test):

```ts
it('does not verify when typecheck is red', async () => {
  const ctx = await started()
  const result = await ctx.orchestrator.recordWorkerResult({
    projectId: PROJECT, taskId: ctx.taskId, fence: ctx.fence, actor: 'w1',
    outcome: 'success', expectedVersion: ctx.version,
    evidence: { tests: { passed: 9, failed: 0 }, typecheck: { ok: false } },
  })
  expect(result.ok && result.value.verified).toBe(false)
  expect(result.ok && result.value.task.status).toBe('claimed_done')
})
```

### 3.5 M9 — the worktree path-guard assertions are un-awaited under vitest

`worktree.test.ts:211-213`:

```ts
expectCode(Promise.resolve().then(() => assertInsideRoot(ROOT, '/etc/passwd')), 'outside_root')
expectCode(Promise.resolve().then(() => assertInsideRoot(ROOT, ROOT)), 'outside_root')
expectCode(Promise.resolve().then(() => assertInsideRoot(ROOT, `${ROOT}-evil/x`)), 'outside_root')
```

`expectCode` returns a promise and the test does not return/await it, so under vitest the assertions
run after the test has finished. With M9 (all guards removed) vitest is green and Bun is red — i.e.
the only reason the guard looks tested is that Bun also runs vitest-style files. Make the helper
synchronous instead:

```ts
function expectCodeSync(fn: () => unknown, code: string): void {
  try { fn() } catch (err) {
    expect(err).toBeInstanceOf(WorktreeError)
    expect((err as WorktreeError).code).toBe(code)
    return
  }
  throw new Error(`expected WorktreeError ${code}`)
}
expectCodeSync(() => assertInsideRoot(ROOT, '/etc/passwd'), 'outside_root')
expectCodeSync(() => assertInsideRoot(ROOT, ROOT), 'outside_root')
expectCodeSync(() => assertInsideRoot(ROOT, `${ROOT}-evil/x`), 'outside_root')
```

### 3.6 M15 — cwd containment only tested against `..` and `/etc`

`verify.test.ts:149-160` covers `../outside`, `/etc`, and a relative root. A sibling path such as
`/tmp/wt/task-1-evil` passes a naive `startsWith` check. `worktree.test.ts:210` already tests
`${ROOT}-evil` for `isInsideRoot`; the verify cwd guard needs the same case:

```ts
await expect(
  verifyWorktree({ root: ROOT, exec: fakeExec(baseScript()).exec }, { cwd: `${ROOT}-evil` })
).rejects.toMatchObject({ code: 'invalid_cwd' })
```

### 3.7 M16 — scope matching accepts a sibling prefix

`inScope` (`verify.ts:170-174`) treats `src/api` as covering `src/api-extra.ts` after the mutation,
and no test has a file that shares a prefix with a scope entry. Add:

```ts
it('does not treat a shared prefix as an in-scope file', async () => {
  const script = baseScript()
  script['git status --porcelain'] = { stdout: ' M src/api-extra.ts\n M src/api.ts\n' }
  const outcome = await verifyWorktree(
    { root: ROOT, exec: fakeExec(script).exec },
    { cwd: ROOT, scope: ['src/api'] }
  )
  expect(outcome.scopeViolations).toEqual(['src/api-extra.ts'])
  expect(outcome.ok).toBe(false)
})
```

Related behaviour gap: `plan.ts` `validateScope` happily accepts globs (`src/server/**/*.ts`, see
`plan.test.ts:19-24`), but `inScope` does literal prefix matching, so any plan written with a glob
fails verification with every changed file listed as a scope violation. Either reject globs at plan
validation or implement them in `inScope`; there is currently no test crossing the two modules.

### 3.8 M2 — nonce is pinned by exactly one API assertion

Removing the ledger nonce check leaves the whole Bun ledger suite green; only
`approvalApi.test.ts:250-255` fails. Add a direct `ledgerApproval` case next to the digest one
(`ledgerApproval.bun.test.ts:39-55`) so the ledger contract is asserted where it lives:

```ts
expect(() => ledger.approval.decideApproval(challenge.id, {
  actor: 'human', approve: true, digest: challenge.digest, nonce: 'wrong-nonce',
})).toThrow(/nonce mismatch/)
```

---

## 4. Behaviour with no test at all

### 4.1 `approvalHumanApi.ts` — 0 tests, and the 8 KiB cap is mislabelled

`grep -rn approvalHuman src` returns only `api.ts:14` (import) and `api.ts:115` (call). No test
imports the module, and none asserts where it sits in the auth/route chain. Probes (Bun, fake
runtime) on `c7c0eda`:

| Request | Result |
|---|---|
| `GET /api/approvals/challenge?id=x`, ledger off | `503 {"error":"ledger_off"}` (ok) |
| `POST /api/approvals/decide` body `{` | `400 {"error":"invalid_json"}` (ok) |
| `POST /api/approvals/request` body 9,000×`x` | `400 {"error":"invalid_json"}` — **cap fires, but the error is mislabelled** |
| `POST /api/approvals/request` `{projectId,kind,ttlMs:-5}` | `201`, `ttlMs:-5` forwarded verbatim (ledger clamps to 1 s) |
| `POST /api/approvalsx/decide` | `404` (prefix match, then falls through) |

`readBody` (`approvalHumanApi.ts:15-25`) counts **UTF-16 code units**, rejects with
`body_too_large`, and the caller's `catch` (`:96-99`) maps every throw to `invalid_json`/400, so a
too-large body is indistinguishable from malformed JSON. Also worth flagging: `/api/approvals/request`
requires no capability and no `requestId` idempotency (unlike `/api/control/approval/request`), which
is intended for the human surface but is entirely unasserted.

Minimum tests (Bun, since `approvalHumanApi` → `ledgerRuntime` → `bun:sqlite` at import time makes it
unloadable in vitest):

```ts
test('oversized approval body is 413 body_too_large, not a JSON error', async () => {
  const { status, body } = await call('POST', '/api/approvals/request', 'x'.repeat(9000))
  expect(status).toBe(413)
  expect(JSON.parse(body)).toEqual({ error: 'body_too_large' })
})

test('decide requires id, digest, nonce and a boolean approve', async () => {
  expect((await call('POST', '/api/approvals/decide', JSON.stringify({ id: 'a1' }))).status).toBe(400)
  expect(decided).toBe(0)   // fake ledger: nothing reached decideApproval
})

test('a node token cannot reach the human approval surface', () => {
  expect(isNodeTokenPath('/api/approvals/decide')).toBe(false)
})
```

The last one belongs in `auth.test.ts`; `isNodeTokenPath` (`auth.ts:135-141`) currently has no case
covering `/api/approvals`, so a future edit that widens the node-token list would let an agent
approve its own action with nothing failing.

### 4.2 Task review has no server semantics, and the layer that does exist self-verifies

There is no review endpoint, no `task.review` event and no transition out of `claimed_done` other
than `verifyTask`/`failTask`. `inbox.ts:113-117` puts `claimed_done` in the "review" bucket, but
`InboxPanel.tsx:192-200` "reviews" a task by **requesting a new approval** of kind `item.kind`; after
`consume` it only hides the row locally (`InboxPanel.tsx:267`) and the task stays `claimed_done`.

Worse, the orchestrator already treats worker-claimed evidence as verification:

```ts
// orchestratorRun.ts:116-126
function claimSuccess(ctx, taskId, fence, evidence) {
  const claimed = ctx.deps.ledger.task.claimDone(taskId, fence, evidence)
  if (!evidenceVerified(evidence)) return { task: claimed, verified: false }
  return { task: ctx.deps.ledger.task.verifyTask(taskId, fence, evidence), verified: true }
}
```

This contradicts `verifier.ts:1-3` ("`claimed_done` hanya naik ke `verified` lewat
`verifyWorkerResult`") and `verify.ts:200-203` (server-run git/test). `orchestratorRun.test.ts:129-146`
asserts the unsafe path (`verified: true` from a caller-supplied `{tests:{passed:12}}`), so a worker
can reach `verified` without the server ever running a command. Nothing tests the intended
separation.

Add a test that states the contract you actually want; as written it will fail, which is the point:

```ts
it('never marks claimed evidence verified without server-run verification', async () => {
  const ctx = await started()
  const result = await ctx.orchestrator.recordWorkerResult({
    projectId: PROJECT, taskId: ctx.taskId, fence: ctx.fence, actor: 'w1',
    outcome: 'success', expectedVersion: ctx.version,
    evidence: { tests: { passed: 99, failed: 0 }, typecheck: { ok: true } },
  })
  expect(result.ok && result.value.task.status).toBe('claimed_done')
  expect(result.ok && result.value.verified).toBe(false)
  expect(ctx.verifyCalls).toHaveLength(1)   // verifyWorkerResult is the only path to `verified`
})
```

and add the inbox-side assertion: after consuming a review approval for a task item, the task row
must change (or the UI must say it does not).

### 4.3 `channels/dedupe.ts` is tested but unused

`DedupeStore`/`dedupeKey` (`dedupe.ts:32-126`) are exercised by `channels.test.ts:128-154`, but
`grep -rn DedupeStore src | grep -v test` finds no production use: the dispatcher dedupes through
`ChannelStore.claimUpdate` (`channelStore.ts:195-205`). That is 126 lines and 2 tests of dead code —
either wire it in or delete it. The passing tests give a false sense that provider dedupe is covered
by that module.

---

## 5. Tests that assert mocks, not behaviour

These are not all wrong — they are valuable at the call-site level — but they cannot catch changes in
the thing they appear to cover:

1. **`orchestratorRun.test.ts`** drives `fakeLedger` (`orchestrator.fake.testutil.ts:136-165`). The fake
   `leaseTask` never enforces pool size, TTL, or max attempts, and `claimDone`/`verifyTask` only
   compare the fence. Statements like "rejects a stale fence before mutating anything"
   (`orchestratorRun.test.ts:186-200`) prove the orchestrator compares `task.fence`, not that the
   ledger refuses a stale fence (that lives in `ledger.bun.test.ts`, outside this scope).
2. **`channelDispatch.test.ts`** uses `fakeApproval` that re-implements status changes. The
   digest/nonce/single-use rules are (thankfully) covered against the real ledger in
   `approvalApi.test.ts`/`approvalGate.bun.test.ts`; do not read the dispatch tests as coverage of
   those rules.
3. **`channelsRuntime.test.ts:114-134`** fakes the ledger approval port with a `Map`; only the store,
   HMAC and HTTP mapping are real there.
4. **`inboxApi.test.ts:8-17` / `orchestratorApi.test.ts:11-17`** build their own `DDL` instead of
   running `openLedgerDb`. The fixture `approval` table has no `decision_id`, and the `task` table has
   no `fence`/`attempt`, so these tests cannot catch migration drift for the columns the projection
   actually depends on. Prefer `openLedgerDb(':memory:')` under Bun, or assert the fixture DDL
   against `PRAGMA table_info` at load.
5. **`InboxPanel.test.tsx:310-317`** is a source grep of `src/client/inbox.css` (no `:root`/`*`/
   `html`/`body`, has a media query). It asserts a real property but not scoping; a class renamed
   away from `inbox-*` would still pass.
6. **`verify.test.ts:233-245`** calls the real `createProcessExec` against `process.cwd()` and requires
   the checkout to be a git repo; it fails in an exported tarball/worktree copy without `.git` (it did
   in the scratch copy until `git init`). Keep it, but guard with a skip when `.git` is absent so the
   gate does not report a red test that says nothing about the code.

---

## 6. Behaviour gaps worth a decision (not fixed here)

- `approvalApi.ts:229-253` acks only successful consumes (correct), but the 409 body
  `{error:'not_consumable'}` does not distinguish "not approved" from "wrong digest" from "already
  used". `InboxPanel` therefore cannot tell the operator whether to re-approve or re-request.
  `approvalApi.test.ts:316-336` asserts the flat 409 only.
- `approvalApi.ts:179-227` replays a decision ack keyed only by `requestId`; a replay with the
  opposite `approve` value returns the original answer (safe, but undocumented and untested).
- `approvalHumanApi.ts:130-135` consumes without checking expiry/status itself; it relies on the
  ledger returning `false` (correct) but maps that to `409 {ok:false}` with no `requestId`, so a
  client retry cannot be deduped.
- `approvalGate.ts:65-73` checks the stored `expiresAt` against the injected `now`, then calls
  `consumeApproval` with the same `now`; the ledger also checks. One of the two is redundant, and the
  gate clock is not covered for a clock that moves between precheck and consume.

---

## 7. Summary

- 16 mutations applied, 8 survive (M4, M8, M8b, M9 under vitest, M12b, M14, M15, M16); M2/M7/M10/M11
  are each pinned by a single assertion.
- Highest impact survivors: **group commands other than approve/reject are not blocked** (M4),
  **the consent checkbox is not required** (M12b), **a red typecheck still verifies** (M14), and
  **scope contains a sibling-prefix hole** (M16).
- Highest impact untested behaviour: **`approvalHumanApi` has zero tests** (and its oversize error is
  reported as `invalid_json`), and **task review has no server semantics while `recordWorkerResult`
  self-verifies** (contradicting `verifier.ts`).
- Gate: the documented Bun command misses 108 P3 assertions; fix it to
  `bun test src/server` (or `src/server/*/*.bun.test.ts` plus the root glob).
