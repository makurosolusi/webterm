# P1 revalidation 2 — mutation matrix and split-export check

- Task mode: mutation/review only. Repo `/Users/bip/Documents/spawn/webterm` was **not** modified
  and not committed; all mutations ran in `$JCODE_SCRATCH_DIR/qc-p1-2` (a `git archive` of HEAD
  plus a `node_modules` symlink).
- Branch `feature/agent-pusat-p3`. The request named `e3f6806`; the branch tip is `294d4e7`
  (`docs(rnd): record P1 revalidation and streaming body fixes`). `git diff --stat e3f6806 294d4e7
  -- src` is empty, so the scratch copy is source-identical to the requested HEAD.
- Repo `git status --short` at the end: empty. No source or doc file in the repo was touched.

## Baselines (scratch HEAD, `TMPDIR=/tmp`)

| Runner | Selection | Result |
| --- | --- | --- |
| vitest | control/mount.test, agentStatusApi, control/controlApi, auth, orchestratorRunApi, orchestratorRunModel, orchestratorRunProduction, orchestratorControlApi, extendedApi | 9 files / **182 tests**, all pass |
| bun | control/mount.bun, ledger/ledgerApproval.bun, orchestratorControlApi.bun, approvalHumanApi.bun, ledger/durableAck.bun | 5 files / **26 tests**, all pass |
| tsc | `npx tsc --noEmit` | exit 0 |

Baselines were re-run after restoring all mutations and stayed green (182/182, 26/26, tsc 0).

## Mutation matrix (one at a time, source restored with `git checkout -- .` after each)

| # | Mutation | Verdict | Failing test / assertion |
| --- | --- | --- | --- |
| 1 | `mount.ts` reverts to the injected unbounded `readBody()` plus a post-hoc `Buffer.byteLength` check | **killed** | `mount.test.ts > rejects an oversized Content-Length before reading the body` (line 196: expected 413, got 400) and `> rejects a chunked body over the cap while streaming, without the unbounded reader` (line 221: expected 413, got 400). Both die on **status**, not on the `readBody` spy: the injected reader returns `''`, so the 400 short-circuits before `expect(readBody).not.toHaveBeenCalled()` is reached. |
| 1b | Same but the reader still exists: `readBody()` call kept, body over cap returns 413 | **killed** | Same two tests, same assertions (spy returns `''`). |
| 2 | `agentStatusApi.ts` drops `readCappedBody` and reads the stream without a cap | **killed** | `agentStatusApi.test.ts > batas body hook > menolak body chunked di atas cap dengan 413 dan tidak menulis status/transcript` (expected 204 to be 413). |
| 3 | `ackKey` drops the node resource (`${verb}|${requestId}`) | **killed** | `controlAckScope.test.ts > ackKey scope > includes the node resource and the verb`; plus the two behavioural tests `ack replay is per node > does not replay a prompt ack from node A for node B with the same requestId` and `… close ack …`. 3 failures. |
| 4 | `depsFor` loses the `mergedDeps` WeakMap memo (merge per call) | **killed** | `mount.test.ts > replays with a partial overrides object (merged deps memoised per identity)` (expected 409 `node_exists`, got 201). |
| 5 | `mount.ts` drops `acks: durableAckFor(runtime?.db, 'control')` | **killed** | bun `control/mount.bun.test.ts > an approval request requestId replays across a ledger runtime reopen` (second id/nonce/expiresAt differ from the first response). |
| 6 | `consumeApproval` drops the `action_digest` comparison | **killed** | bun `ledger/ledgerApproval.bun.test.ts > consume rejects a wrong digest without spending the one-shot consent`. 8 pass / 1 fail. |
| 7a | `orchestratorRunApi.ts` stops exporting `orchestratorRunRoute` (and the `orchestratorRunEnabled` re-export) | **killed** | `tsc`: `extendedApi.ts(22,3) TS2724 no exported member 'orchestratorRunRoute'`, `orchestratorRunApi.test.ts(13,3) TS2724`, and two `TS2304 Cannot find name 'orchestratorRunEnabled'` inside the module. vitest: 9 failures in `extendedApi.test` + `orchestratorRunApi.test` (`TypeError: orchestratorRunRoute is not a function`). |
| 7b | `orchestratorControlApi.ts` stops exporting `orchestratorBootstrapRoute` / `orchestratorAssignRoute` | **killed** | `tsc`: 6 × `TS2459` in `extendedApi.ts(28,3)`, `(29,3)`, `orchestratorControlApi.bun.test.ts(12,12/35)`, `orchestratorControlApi.test.ts(7,7)` and `(8,3)`. vitest: 6 failures (`TypeError: orchestratorBootstrapRoute is not a function`). |
| 8 | `workerRuntimePrompt` reverts the single-line collapse (`capBytes(sanitizeText(prompt))`) | **killed** | `workerRuntimePrompt.test.ts > buildWorkerPrompt one-line delivery > collapses multi-line extra instructions and keeps every instruction` (`expected '…' not to match /[\r\n]/`). |

All eight requested mutations are killed. The route splits still expose the symbols their consumers
use: `extendedApi.ts` imports `ORCHESTRATOR_RUN_PATH`, `orchestratorRunRoute`,
`orchestratorBootstrapRoute`, `orchestratorAssignRoute` and the two control paths from the split
modules, so any dropped re-export fails `tsc` before tests even load.

## Survivors: the streaming cap itself is not pinned

Mutations 1 and 2 are killed only because the tests assert the **outcome** (413 + no writes) and the
mutants produced 400 through the injected empty reader. A stronger mutant survives every targeted
suite:

> **Survivor S-R1 (control):** keep the `content-length` fast reject, then buffer the request stream
> unbounded and check `Buffer.byteLength(raw) > 64 KiB` afterwards.
> **Survivor S-R2 (agent status):** identical shape, buffer the stream unbounded and check
> `> MAX_HOOK_BODY_BYTES` afterwards.

Verified: with S-R1 applied, `control/mount.test.ts` is **11/11 green**; with S-R2 applied,
`agentStatusApi.test.ts` is **26/26 green**. That is precisely the regression R1/R2 claimed to fix
(payload fully allocated before any size decision), so today the tests would not catch a revert to
"read everything, then reject".

Exact assertions that kill them (probe verified failing on the mutant, passing at HEAD):

```ts
// mount.test.ts
it('detaches from the request stream as soon as the cap is exceeded', async () => {
  const h = harness()
  const readBody = vi.fn(async () => '')
  const res = fakeRes()
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, { method: 'POST', headers: {}, resume() {} })
  const listenersAfterOverflow: number[] = []
  process.nextTick(() => {
    req.emit('data', Buffer.alloc(70 * 1024))          // one chunk already over the cap
    listenersAfterOverflow.push(req.listenerCount('data'))
    req.emit('data', Buffer.alloc(1024))               // must never be consumed
    req.emit('end')
  })
  await handleControlHttp(req, res as unknown as ServerResponse,
    new URL('/api/control/spawn', 'http://x'), readBody, h.deps)
  expect(res.statusCode).toBe(413)
  expect(listenersAfterOverflow).toEqual([0])          // reader detached at overflow
  expect(readBody).not.toHaveBeenCalled()
})

// agentStatusApi.test.ts
it('detaches from the request stream as soon as the cap is exceeded', async () => {
  const res = mockRes(); const d = deps()
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, { method: 'POST', headers: {}, resume() {} })
  const seen: number[] = []
  process.nextTick(() => {
    req.emit('data', Buffer.alloc(MAX_HOOK_BODY_BYTES + 1))
    seen.push(req.listenerCount('data'))
    req.emit('data', Buffer.alloc(16))
    req.emit('end')
  })
  await agentStatusRoute(req, res, URL_FOR(NODE), { strictAuth: false, deps: d })
  expect(res.statusCode).toBe(413)
  expect(seen).toEqual([0])
  expect(d.writes).toEqual({ status: [], transcript: [] })
})
```

Why it works: `readCappedBody` calls `req.off('data', onData)` as soon as the accumulated total
exceeds the cap (`channels/channelHttp.ts:48-51`). A buffering reader keeps one `data` listener
attached until `end`, so `listenerCount('data')` is `1` at overflow instead of `0`. Both probes were
run: mutant `[1]` → fail, HEAD `[0]` → pass, and the existing 11 / 26 tests stayed green.

Secondary hardening (cheap, optional): in the two existing cap tests, have the injected reader
return an over-cap string instead of `''`, so the current `expect(readBody).not.toHaveBeenCalled()`
line is actually reachable rather than shadowed by the status assertion.

## File budgets

Split modules (cap 250): `orchestratorRunApi.ts` 103, `orchestratorRunModel.ts` 103,
`orchestratorRunProduction.ts` 148, `orchestratorControlApi.ts` 38,
`orchestratorControlModel.ts` 137, `orchestratorControlService.ts` 171,
`control/controlHttpIo.ts` 71. **All within 250.**

Route files (cap 150) — met: `api.ts` 146, `control/mount.ts` 150 (exactly at cap, freeze it),
`orchestratorRunApi.ts` 103, `orchestratorRunProduction.ts` 148,
`central/centralApi.ts` 150, `approvalHumanApi.ts` 139, `workspacesApi.ts` 109,
`orchestratorControlApi.ts` 38, `fsApi.ts` 84, `orchestratorApi.ts` 72, `inboxApi.ts` 66,
`memoryApi.ts` 57, `settingsApi.ts` 46, `contextLinkApi.ts` 44. **Over 150:**
`channels/webhook.ts` 295, `channels/channelBindingsApi.ts` 285,
`approvalHumanRoutes.ts` 281, `control/controlApi.ts` 220, `agentStatusApi.ts` 174,
`extendedApi.ts` 156 (was 156 at `e3f6806` too; the split did not shrink it).

Service files over the 300 cap (unchanged by the P1 work): `hooks.ts` 352, `sessions.ts` 338,
`contextLink.ts` 323, `ledger/ledgerTask.ts` 303. Near the cap: `control/approvalApi.ts` 299,
`orchestrator/workerRuntime.ts` 298, `channels/channelStore.ts` 298.

## Notes and limits

- Verification is static plus targeted runtime suites; the full vitest/bun suites were not re-run
  per mutation (only the suites that own each behaviour, plus `tsc` for the export breaks).
- All mutated source files were restored to HEAD; the only difference in the scratch tree is this
  report file. The real repo was never written to (`git status --short` empty).
- Follow-up worth doing in the same fix commit: add the two listener-count probes and move the
  residual R2 readers (`api.ts`, `settingsApi.ts`) onto `readCappedBody`.

## Follow-up applied

The two listener-count probes above were added after this report was written:
`control/mount.test.ts` "detaches from the request stream as soon as the cap is exceeded" and
`agentStatusApi.test.ts` "melepas listener stream begitu cap terlampaui". Both pass at HEAD and
were confirmed to fail against the S-R1/S-R2 buffering mutants. The existing declared-oversize
tests now return an over-cap string from the injected reader so the `not.toHaveBeenCalled()`
assertion is reachable. Remaining residual: `api.ts`/`settingsApi.ts` body readers are still
unbounded; they are root/loopback-only and were not changed in this pass.
