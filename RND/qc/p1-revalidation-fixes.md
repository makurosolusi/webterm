# P1 revalidation fixes — S1–S6, R1–R2

- Repo `/Users/bip/Documents/spawn/webterm`, branch `feature/agent-pusat-p3`.
- Input: `qc/p1-revalidation.md` (runtime acceptance at `3e867f0`) and
  `qc/p1-revalidation-static.md` (mutation matrix at `3e867f0`).
- Fix commit: `fb08982` — `fix(control): stream-cap request bodies and pin ack regressions`.
- Scope of that commit: three source files (`control/controlHttpIo.ts`, `control/mount.ts`,
  `agentStatusApi.ts`) plus tests. No secrets, tokens, or payloads reproduced here.

## S1–S6: survivors pinned by tests

Six mutations survived the full suite; `fb08982` adds assertions that kill each one. Only the
two body readers (R1/R2) needed a source change.

| ID | Finding (surviving mutation) | Fix / test | Status |
| --- | --- | --- | --- |
| S1 | `ackKey` dropped the node resource, so the same `requestId` against node B replayed node A's ack. | `controlAckScope.test.ts`: key shape includes verb and node; behavioural replay tests for `prompt` and `close` on two nodes. | Pinned; `ackKey` already carried `node:<id>` at `3e867f0`. |
| S2 | Stable merged control deps were untested; every test injected all three deps and took the fast path. | `mount.test.ts`: two calls with the **same partial overrides** and one `requestId` replay `201` instead of `409 node_exists`. | Pinned; merge memo unchanged. |
| S3 | `consumeApproval` ignored the digest and still spent `single_use`. | `ledgerApproval.bun.test.ts`: wrong digest returns `false`, the approval stays consumable, the right digest then succeeds. | Pinned; ledger guard unchanged. |
| S4 | Dropping `acks: durableAckFor(db, 'control')` went unnoticed. | `mount.bun.test.ts`: same capability and `requestId`, ledger closed and reopened on the same DB, replay returns the original id and only one approval row exists. | Pinned; wiring unchanged. |
| S5 | API-layer digest pre-check could be removed because the port re-mapped the error to the same `403`. | `approvalApiDigest.test.ts`: a port that does not validate the digest still yields `403 digest_mismatch` and the port is never called; matching digest passes through. | Pinned; pre-check unchanged. |
| S6 | Human approval in-memory fallback was dead in tests (fake DB always exposed `query`). | `approvalHumanRoutes.test.ts`: a `db` without `query` replays through one in-memory store per runtime. | Pinned; fallback kept (still reachable for non-query fakes). |

## R1–R2: body caps now enforced while streaming

| ID | Finding | Fix / test | Status |
| --- | --- | --- | --- |
| R1 | Control body was read in full by the unbounded `readBody()` and only then checked, so a chunked 70 KB body was fully allocated before `413`. | `readControlBody` in `controlHttpIo.ts` uses `readCappedBody` with `CONTROL_MAX_BODY_BYTES` (64 KiB); `content-length` stays a fast reject. Test: two 40 KiB chunks with the injected reader spied, expects `413` and reader never called. | **Fixed** in `fb08982`. |
| R2 | `/api/agent-status` read an unbounded body from a node-token-reachable endpoint, so any agent PTY could buffer an arbitrarily large payload. | `agentStatusApi.ts` uses `readCappedBody` with `MAX_HOOK_BODY_BYTES` (256 KiB); overflow returns `413 payload_too_large` before `setStatus`/`setTranscript`. Tests: over-cap chunked body rejected, just-under-cap body accepted. | **Fixed** for agent status in `fb08982`. |
| R2 residual | `src/server/api.ts` `readBody` still serves workspaces, fs write, and git routes, and `settingsApi.ts` reads unbounded. | Root/loopback-only, so severity is bounded by the local threat model, but the body is still buffered before any size decision. | **Open**; route through `readCappedBody` next. |
| R3 | `declaredTooLarge` ignored non-numeric/negative lengths by design. | Replaced by `declaredLength` (digits only) plus the streaming cap, so only a valid oversized length fast-rejects and everything else is capped during read. | Closed by the R1 fix. |

## Gates (this branch, after `fb08982`)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | clean, exit 0 |
| `npx vitest run` | 132 files / 1720 tests, all pass with `TMPDIR=/tmp` |
| `bun test $(git ls-files '*.bun.test.ts')` | 29 files / 203 tests, all pass |
| New control/approval/agent-status suites | included in both runs above, all pass |

Bare `TMPDIR` on this machine resolves inside `$HOME` (`/Users/bip/.jcode/scratch`), which makes
`control/controlCwd.test.ts > honours explicit extra roots …` fail because a `mkdtemp` directory
counts as inside home. With the documented gate env (`TMPDIR=/tmp`) the suite is green 1720/1720.
This is environment-only and unrelated to `fb08982`.

## File budgets

Hard cap 500; route 150; service 300; utility 200.

| Lines | File | Note |
| --- | --- | --- |
| 150 | `src/server/control/mount.ts` | exactly at the route cap; no headroom, freeze it |
| 174 | `src/server/agentStatusApi.ts` | 115% of the route cap; the cap helper import added two lines |
| 71 | `src/server/control/controlHttpIo.ts` | within utility budget |
| 299 | `src/server/control/approvalApi.ts` | 99% of the service cap; split at the list/route seam |
| 298 | `src/server/orchestrator/workerRuntime.ts` | 99% of the service cap; no headroom |
| 103 | `src/server/orchestratorRunApi.ts` | route cap met after the split (model 103, production 148) |
| 38 | `src/server/orchestratorControlApi.ts` | route cap met after the split (model 137, service 171) |
| 295 | `src/server/channels/webhook.ts` | dispatch + route in one file |
| 285 | `src/server/channels/channelBindingsApi.ts` | 190% of the route cap |
| 281 | `src/server/approvalHumanRoutes.ts` | 187% of the route cap |
| 146 | `src/server/api.ts` | one route away from over; still holds the residual R2 readers |

Above 80% of the hard cap, unchanged by this fix: `src/shared/workspace.ts` 464,
`SessionsPanel.tsx` 456, `App.tsx` 451, `terminalKeys.ts` 446 (utility cap 200),
`sessionList.ts` 412. Recommendation unchanged: freeze `mount.ts` and `api.ts`, and split
`approvalApi.ts`. The two `orchestrator*Api` routes are now 103 and 38 lines, so the route target
is satisfied there.

## Follow-ups

1. R2 residual: move `workspaces`/`fs`/`git` and `settings` reads onto `readCappedBody`.
2. S6: either keep the tested fallback or delete it; do not leave it untested again.
3. Freeze `mount.ts`; route budget is already exhausted.
