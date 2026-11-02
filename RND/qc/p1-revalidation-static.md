# P1 static revalidation — B2, B4, M5, M2, capability/auth scoping

- Repo `/Users/bip/Documents/spawn/webterm`, branch `feature/agent-pusat-p3`, HEAD `3e867f0`.
- Mode: REVIEW/MUTATION ONLY. No repo source/test/config was edited; all mutations were applied to
  a scratch copy (`$JCODE_SCRATCH_DIR/qc/webterm-reval2`, `node_modules` symlinked, own `git` repo
  so the git-dependent test can run) and reverted with `git checkout` after each run.
- Only artifact written: this report (untracked markdown). No commit, no source change.
- Static only; no server was booted. Runtime/edge behaviour outside the suite is not covered here.

## 1. Baseline gates (scratch copy == HEAD)

| Gate | Command | Result |
| --- | --- | --- |
| typecheck | `npx tsc --noEmit` | clean, exit 0 |
| full vitest | `npx vitest run` | **127 files / 1697 tests, all pass** (2 consecutive runs) |
| bun suites | `bun test $(find src -name '*.bun.test.ts')` | **28 files / 201 tests, all pass** |

Targeted suites requested in the brief (run in the real repo, read-only):

```
auth 66 · hooks 49 · capabilities 27 · controlApi 30 · mount 9 · agentStatusApi 24
sessionsFake 32 · approvalApi 19 · approvalHumanApi 20 · inboxApi 5 · memoryApi 4
memoryFile 19 · channels/ 113 (9 files)
→ 22 files / 417 tests passed
```

Known flake (pre-existing, not caused by any mutation): `src/client/terminalCore.test.tsx >
elemen 0x0: open ditunda, lalu terkirim lewat fallback batas waktu` failed in 2 of ~10 full-suite
runs under parallel load, passes 3/3 when run alone. Low severity, but it can mask a real red.

## 2. Mutation matrix

Each row = one mutation in the scratch copy, full `vitest run` (and bun suites where the guard is
ledger/DB), then revert.

| # | Mutation | Result | Failing tests |
| --- | --- | --- | --- |
| 1 | `isNodeTokenPath` += `pathname.startsWith('/api/central')` (`auth.ts:128`) | killed | `auth.test.ts` "does not allow anything that reaches settings…", "has exactly the three allowlist arms", "names no privileged family inside the allowlist", `it.each` "/api/central/portfolio" (node + capability rows) — 5 |
| 2a | capability read from `queryToken` (`auth.ts:168`) | killed | "does not read a capability from the query string" — 1 |
| 2b | capability accepted outside `/api/control/` (drop `isControlPath`) | killed | 7 (5 `it.each` families + "never accepts a capability outside the control family" + minted-token round-trip) |
| 3 | `resolveSpawnSessionId` trusts client `sessionId` (`spawnSession.ts:20`) | killed | `controlApi.test.ts:140` "validates a client-supplied session id instead of trusting it" — 1 |
| 4a | `ackKey` = `requestId` only (`controlTypes.ts:135`) | killed | "does not replay a spawn ack for a different route with the same requestId" — 1 |
| 4b | `ackKey` = `` `${verb}|${requestId}` `` (drops node resource) | **SURVIVED** | 113/113 control+approval tests pass → S1 |
| 5 | close-ghost branch → `404 node_not_found` (`controlApi.ts:135-139`) | killed | "closing a never-existing node leaves no tombstone, so wait stays 404", "closes once and is idempotent per requestId" — 2 |
| 6a | `CONTROL_MAX_BODY_BYTES` 64 KiB → 1 GiB (`controlTypes.ts:91`) | killed | mount "rejects an oversized Content-Length before reading the body", "rejects an accumulated body over 64 KiB even without Content-Length" — 2 |
| 6b | `declaredTooLarge` → `false` (`controlHttpIo.ts:22`) | killed | mount "rejects an oversized Content-Length before reading the body" — 1 |
| 7a | drop API-layer digest pre-check in `decideRoute` (`approvalApi.ts:204`) | **SURVIVED** | port/ledger still throws → `decisionFailure` maps to the same 403; body is not asserted as an API-layer decision → S5 |
| 7b | drop nonce check (`ledgerApproval.ts:206`) | killed | bun `approve with nonce+digest, then consume exactly once` — 1 |
| 7c | drop `single_use` guard + `single_use = 0` write (`ledgerApproval.ts:240,244`) | killed | 4 bun tests (approvalGate, ledgerApproval, ledgerTask) |
| 7d | drop digest check in `consumeApproval` (`ledgerApproval.ts:243`) | **SURVIVED** | 201 bun + 113 vitest pass → S3 |
| 8 | `assertCanPromote` no-op (`memoryCore.ts:118-131`) | killed | vitest `memoryFile` "rejects workers, non-human core, and non-fact rows"; bun "promotion needs machine evidence and a non-worker authority", "core scope is human-only", "M2: a worker cannot supersede a fact into a new fact" — 4 |
| 9a | group approver binding allowed (`channelBindingsApi.ts:174`) | killed | 5 (bindings API/HTTP group policy + audit) |
| 9b | approve/reject from group allowed (`identity.ts:85`) | killed | `channels.test.ts` "denies approval from a bound group even with an approver binding" — 1 |
| 10 | B2 regression: `depsFor` stops memoising merged deps (`mount.ts:84-88`) | **SURVIVED** | **full 1697 pass** → S2 |
| 11 | `resourceMatches` → `true` (`capabilities.ts:111`) | killed | 8 (capabilities exact/prefix, approval scope x3, controlApi verb/resource, nodes filter) |
| 12 | `spawnRoute` stops passing `sessionId` to `sessions.open` (`controlApi.ts:88`) | killed | "mints a UUID session id for claude so the launch line carries hooks", "validates a client-supplied session id…" — 2 |
| 13 | drop `acks: durableAckFor(db,'control')` in `mount.ts:140` | **SURVIVED** | control+ledger+durableAck suites all pass → S4 |
| 14 | human approval `storeFor` returns a fresh `AckStore` per call (`approvalHumanRoutes.ts:32`) | **SURVIVED** | tests always take the durable branch → S6 (fallback branch untested) |

## 3. Surviving mutations and the assertions to add

**S1 — Medium (scoping). `ackKey` without the node resource.**
`src/server/control/controlTypes.ts:135`. Replaying `node.prompt`/`node.close` with the same
`requestId` for a *different* `nodeId` returns the first node's acked 2xx and never touches the
second node. Kills only the cross-verb case today.
Assertion: `ackKey('node.prompt','node:a','req-00000001') !== ackKey('node.prompt','node:b','req-00000001')`
plus a behavioural test — prompt node A with `R`, prompt node B with `R`, expect B's fake
`sessions.input` to have been called (or a `409/400` for reuse). Same for `close`.

**S2 — Medium (regression coverage, B2). No test pins the stable-deps invariant.**
`src/server/control/mount.ts:39-49,78-90`. Reverting the WeakMap memo leaves 1697/1697 green:
every control test injects all three deps and takes the `Promise.resolve(overrides)` fast path, so
the merge path that B2 fixed is never executed. `ledgerRoutes.bun.test.ts` also builds a fresh
`controlDeps()` per call.
Assertion: in a bun test, `handleControlHttp(...)` twice with the **same partial overrides object**
(no full 3-dep injection) and identical `requestId` → second call must replay 201, not 409.
Simplest seam: export `depsFor` (or a `resetControlDepsForTest`) and assert
`await depsFor(o) === await depsFor(o)`.

**S3 — Medium (security invariant, untested). Consume ignores the digest.**
`src/server/ledger/ledgerApproval.ts:243`. `consumeApproval(id, {digest:'wrong'})` still consumes
and sets `single_use = 0`; nothing in 201 bun + 113 vitest notices. The `approval.consume` control
route (`approvalApi.ts:236-246`) does not re-check the digest itself, so this is the only guard, and
"consent binds to the exact action" becomes untested.
Assertion: `expect(consumeApproval(ctx, id, { digest: 'x'.repeat(64) })).toBe(false)` and the
approval must remain consumable afterwards; a second `consume` with the right digest must succeed.

**S4 — Medium (replay across restart, untested wiring).**
`src/server/control/mount.ts:140`. Removing `acks: durableAckFor(...)` is invisible to
`durableAck.bun.test.ts` (store unit) and `ledgerRoutes.bun.test.ts` (no repeat requestId).
Assertion: same capability + same `requestId` on `POST /api/control/approval/request`, then
`resetActiveLedgerRuntimeForTest()` + `startLedgerRuntime({path})` on the same DB, then repeat →
same `id`, status 201 (replay), and only one approval row exists.

**S5 — Low (defence-in-depth, benign today).** `approvalApi.ts:204` pre-check removable because the
port throws and `decisionFailure` (`approvalFields.ts:22-28`) re-maps the message to the same 403.
Add a test with a port whose `decideApproval` does **not** validate the digest, asserting the API
returns `403 digest_mismatch` and never calls the port.

**S6 — Low.** `approvalHumanRoutes.ts:26-35` in-memory fallback is dead code in tests (durable
branch always taken, since the fake DB exposes `query`). Either delete the fallback or add a
replay test with a `db` that has no `query`.

## 4. Residual code findings (not mutation-derived)

**R1 — Medium: M2 is only partly fixed; control body is still buffered before the byte check.**
`src/server/control/mount.ts:115-120` awaits `readBody()` (the unbounded reader in
`src/server/api.ts:31-38`) and *then* checks `Buffer.byteLength(raw)`. A chunked request with no
`Content-Length` still allocates the whole payload before the 413. `mount.test.ts` "accumulated body
over 64 KiB even without Content-Length" asserts the status, not that the buffer stayed bounded, so
it passes either way. Fix: use `readCappedBody` from `src/server/channels/channelHttp.ts:30`
(already used by `extendedApi.ts:93`).

**R2 — Medium: unbounded body readers remain on other surfaces.**
- `src/server/agentStatusApi.ts:52-58`, used at `:135` — node-token reachable (`isNodeTokenPath`
  allows `/api/agent-status`), so any agent PTY can POST an arbitrarily large body to the shared
  server and OOM it. Identity check runs before the read (`:126`), which is good, but the read
  itself is unbounded.
- `src/server/api.ts:31-38` via `:62` (workspaces), `:76` (fs write), `:81` (git), and
  `src/server/settingsApi.ts:11` — root/loopback-only, but the default install is token-free
  loopback, so any local process qualifies.
Severity is bounded by the local/loopback threat model, but it contradicts the M2 statement
"cap at the transport". `extendedApi.ts` (16 KiB) and control (64 KiB) are the only capped paths.

**R3 — Low: `declaredTooLarge` ignores non-numeric/negative lengths by design**
(`controlHttpIo.ts:22-26` → `Number.isFinite(n) && n > max`), so only the post-hoc check catches
those; that is fine once R1 is fixed.

## 5. File budgets (Rule 8)

Hard cap 500 lines; service 300, route 150, repository 250, utility/config 200.

Over 80% of the hard cap (>400 lines), all non-test/non-generated:

| Lines | File | Note |
| --- | --- | --- |
| 464 | `src/shared/workspace.ts` | shared types + helpers, no tier of its own; effectively a god module |
| 456 | `src/client/SessionsPanel.tsx` | |
| 451 | `src/client/App.tsx` | |
| 446 | `src/client/terminalKeys.ts` | utility cap 200 → 223% |
| 412 | `src/client/sessionList.ts` | |

Over tier but ≤400 (watch list, ≥80% of 500 for none):

```
369 InboxPanel.tsx · 360 themes.ts · 359 EditorNode.tsx · 352 hooks.ts (service 300)
345 TerminalCore.tsx · 338 sessions.ts (service 300) · 323 contextLink.ts (service 300)
303 ledger/ledgerTask.ts (repository 250 → 121%)
```

Route files (>150) and the ones called out in the brief:

```
300 orchestratorRunApi.ts        (200% of route cap)
300 orchestratorControlApi.ts    (200%)
299 control/approvalApi.ts       (99% of service cap; route family, 199% of route cap)
295 channels/webhook.ts          (197%; dispatch + route in one file)
285 channels/channelBindingsApi.ts (190%)
281 approvalHumanRoutes.ts       (187%)
172 agentStatusApi.ts            (115%)
156 extendedApi.ts               (104%)
150 control/mount.ts             (100% — exactly at the cap)
150 central/centralApi.ts        (100%)
146 api.ts                       (97% — one route away from over)
160 index.ts                     (107%; server entry point, not a barrel — acceptable, but no headroom)
```

Brief-specific files that are fine: `orchestrator/workerRuntime.ts` 298/300 (99%, no headroom;
splitting is already done via `workerRuntimePrompt/Session/Settle/Types`),
`memory/memoryFile.ts` 231/300 (77%), `ledger/ledgerSchemaV1.ts` 179 (schema cap 200, split into
V1/V2/V3 + `migration.ts` 226), `InboxPanel.tsx` 369 (client component, no numeric tier but the
largest UI file after the four >400).

Recommendation: freeze `mount.ts` and `api.ts` (no new lines), split `approvalApi.ts` at the
list/route seam, and move `orchestratorRunApi`/`orchestratorControlApi` handlers behind the same
kind of thin route/serve split already used for control.

## 6. Verified good at HEAD (positive space)

- Node-token allowlist is exactly three arms, one `startsWith`, pinned by a source-reading test
  (`auth.ts:128-134`, `auth.test.ts:249-274`). Central/orchestrator/memory/channels families are
  asserted both behaviourally and textually.
- Capability tokens are header-only and `/api/control/`-only (`auth.ts:167-170`); root token wins
  first, node token second, origin gate applies to all three.
- Mint route: constant-time compare, feature flag, `*` restricted to `node.read`, TTL validated
  (`controlApi.ts:171-199`).
- B4: `resolveSpawnSessionId` mints/validates and `spawnRoute` passes it (`controlApi.ts:75-88`);
  both the mint and the validation are killed by mutation.
- M5: ghost close returns `200 closed:false` without calling `sessions.close` and without a
  tombstone (`controlApi.ts:132-139`); mutation to 404 is caught.
- Approval: digest+nonce+single-use are enforced in the ledger and the single-use and nonce guards
  are each pinned by 1-4 bun tests; control consume acks only successes (`approvalApi.ts:241-251`).
- Memory authority is server-derived (`requireAuthority`/`assertCanPromote`), HTTP memory surface is
  read-only (`memoryApi.ts:1-3`), file export uses a fixed `{kind:'human',id:'root'}`
  (`memoryFileHttp.ts:30`) and the transport is root-only.
- Telegram group handling is denied three times over (binding role `channelBindingsApi.ts:174`,
  identity `identity.ts:85`, dispatch `channelDispatch.ts:183`), each independently mutation-killed.

## 7. Prioritized fixes

1. **S3** — add the consume-digest test (cheapest, guards a security invariant).
2. **R1/R2** — route control + agent-status through `readCappedBody`; this is the actual M2 fix.
3. **S2** — one bun test that exercises the merged-deps path, otherwise B2 can silently regress.
4. **S1** — ackKey must include the node resource and be tested for it.
5. **S4** — replay-across-restart assertion for the control approval route.
6. Freeze `mount.ts`/`api.ts`, split `approvalApi.ts` and the two 300-line `orchestrator*Api` files.
