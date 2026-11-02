# P1 revalidation 2 — streaming caps and route splits on a real server

- Repo `/Users/bip/Documents/spawn/webterm`, branch `feature/agent-pusat-p3`,
  HEAD `294d4e7` (split commit `e3f6806`).
- Scope: ACCEPTANCE ONLY. No repo source/test changed, nothing committed. This file is the
  only repo write.
- Runtime: Bun 1.4.2, `NODE_ENV=production`, `HOST=127.0.0.1 PORT=8831`, fresh temp data dir,
  `WEBTERM_LEDGER=on WEBTERM_ORCHESTRATOR_RUN=on WEBTERM_CENTRAL=on WEBTERM_ALLOW_TOKEN_MINT=1`.
  Root token generated per run; only its **length** is logged by the server and only its
  presence is reported here. Secrets are redacted.
- Harness: temp `/bin/sh` script that prints `HARNESS_READY`, appends to a launch-count file,
  answers `PING` with `MARKER_PONG`, then waits. Injected via
  `PUT /api/settings {"agentLaunchCommands":{"claude":"<harness>"}}` (200).
- Capabilities: minted through `POST /api/control/token` (201 each) for `node.spawn`,
  `node.prompt`, `node.wait`, `node.close` on `node:qcnode1`.

## Result summary

**19/19 checks verified. 0 failed.** No source bug found, so there is no bug `file:line` to
report. File references below are the implementation points each check exercised.

### 1. Control plane still works after the `mount.ts` streaming rewrite — VERIFIED

| Check | Observed |
| --- | --- |
| spawn | `201 {"ok":true,"requestId":"req-spawn-0001","nodeId":"qcnode1"}` |
| harness really launched | launch-count file = 1 |
| prompt | `200 {"ok":true,"requestId":"req-prompt-0001","nodeId":"qcnode1"}` |
| wait (until `idle`) | `200 {"state":"idle","output":"HARNESS_READY … PING one\r\nMARKER_PONG PING one\r\n"}` |
| close | `200 {"ok":true,"requestId":"req-close-0001","nodeId":"qcnode1","closed":true}` |
| replay spawn, same `requestId` | `201` same body; launch count **1 → 1** (no second PTY) |
| replay prompt, same `requestId` | `200` same body |

Evidence: streaming body read at `src/server/control/mount.ts:112` →
`src/server/control/controlHttpIo.ts:37-57`; ack replay path unchanged in
`src/server/control/controlApi.ts:53-55,104-106,128-130`.

### 2. Control body cap 64 KiB — VERIFIED

| Request | Observed |
| --- | --- |
| chunked POST `/api/control/prompt`, 70 KiB, no `Content-Length` | `413 {"error":"payload_too_large","max":65536}` |
| declared `Content-Length: 71680`, body never completed | `413 {"error":"payload_too_large","max":65536}` in < 3 s, no hang |
| exactly 65536-byte body, valid shape (trailing JSON whitespace) | `200 {"ok":true,"requestId":"req-64k-0001","nodeId":"qcnode1"}` — not 413 |
| invalid JSON under cap | `400 {"error":"invalid_json"}` |

The exact-cap request is the boundary check: `readCappedBody` rejects only on `total > max`
(`src/server/channels/channelHttp.ts:48`), cap constant
`src/server/control/controlTypes.ts:91`. Declared-length fast reject:
`src/server/control/controlHttpIo.ts:49-51`.

### 3. `/api/agent-status` cap 256 KiB — VERIFIED

| Request | Observed |
| --- | --- |
| chunked POST, ~300 KiB, `?node=qcnode1` | `413 {"error":"payload_too_large"}` |
| small `SessionEnd` body | `204`, empty body |
| small `Stop` body | `204`, empty body |
| unsafe node id `?node=..%2Fevil` | `204`, empty body (no-op unchanged) |

Evidence: `MAX_HOOK_BODY_BYTES` `src/server/agentStatusApi.ts:28`, capped read at
`src/server/agentStatusApi.ts:131`, unsafe-id no-op before the read.

### 4. Split route modules — VERIFIED

| Request | Observed |
| --- | --- |
| `POST /api/orchestrator/bootstrap`, non-git `path` | `400 {"error":"invalid_path"}` |
| `POST /api/orchestrator/run`, payload carries `repo` | `400 {"error":"client_controlled_field","message":"repo is resolved server-side and must not be sent"}` |
| `GET /api/central/portfolio` | `200 {"items":[],"total":0,"limit":50,"offset":0}` |
| `GET /api/memory/search?projectId=p&q=x` | `200 {"projectId":"p","q":"x","limit":20,"items":[]}` (not 500) |

Evidence: `src/server/orchestratorControlModel.ts:100` (`invalid_path`),
`src/server/orchestratorRunModel.ts:57` (`client_controlled_field`),
`src/server/extendedApi.ts:85-100` (16 KiB streaming cap + dispatch),
`src/server/central/centralApi.ts:126-131` (portfolio 200),
`src/server/memoryApi.ts:12,39,56` (search 200/400 path).
All four split imports loaded and answered; no 500 and no import error in the log.

### 5. Log hygiene — VERIFIED

Facts measured on the final run log (`server.log`, exactly 2 non-empty lines):

| Probe | Result |
| --- | --- |
| root token literal (48 chars) in log | 0 occurrences |
| UUID-shaped strings (node token is a UUID) | 0 occurrences |
| `wcap_` capability prefix | 0 occurrences |
| harness stdout (`HARNESS_READY` / `MARKER_PONG`) | 0 occurrences |
| stack-trace lines (`    at …(` ) | 0 |
| `Cannot find module` / `SyntaxError` / `TypeError` / `ReferenceError` / `api … failed:` | 0 |

Whole log content, redacted: `ledger on: <tmp>/ledger.db` and
`webterm listening on http://127.0.0.1:8831 (prod, token on: len=48)`. The boot line reports
only token length, never the value. Harness output stayed in the PTY stream (visible through
`wait`), not in the server log. Node-token reachability was not required for this check: the
log is entirely accounted for by the two boot lines.

## Gate and environment notes

- The production server booted cleanly (`prod`, token set, ledger `on`); all `/api` families
  answered through the real `index.ts` request path, not unit-test fakes.
- `distAssets.generated.ts` is the committed empty stub in this checkout, so static asset
  serving is empty. That is unrelated to the API checks above and was not exercised.
- Test-harness timing detail (not a product bug): `wait` with `until:"idle"` can legitimately
  return `state:"idle"` with empty output before a just-spawned shell has emitted anything.
  The driver therefore polled until `MARKER_PONG` appeared; the final run captured both
  `HARNESS_READY` and `MARKER_PONG`.

## Cleanup

- Server process terminated; harness processes killed; port 8831 confirmed free.
- Temp data dir, harness, driver, token file, and logs removed from `/tmp/wtqc-run`.
- Ports 8799 and 3001 were never contacted or modified.

## Verdict

Streaming caps (control 64 KiB, agent-status 256 KiB, extended API 16 KiB) and the
orchestrator/central/memory route splits are re-proven at runtime: exact status and body
match the contract, idempotent replay does not double-spawn, and the server log leaks
neither token nor harness output. No fix required.
