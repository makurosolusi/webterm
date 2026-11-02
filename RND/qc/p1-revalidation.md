# P1 Control-Plane Revalidation (Acceptance)

- Repo: `/Users/bip/Documents/spawn/webterm`
- Branch: `feature/agent-pusat-p3`
- HEAD: `3e867f0` (verified before and after; worktree source/tests untouched)
- Date: 2026-11-01
- Server: production build path (`NODE_ENV=production`), `127.0.0.1:8830`, temp data dir, cwd `/tmp`.
- Tokens: root 48-hex, node tokens and capability tokens redacted as `<root>`, `<node-token>`, `<cap:verb resource>`.

## Method

Booted a real server on 8830 with `WEBTERM_TOKEN`, `WEBTERM_ALLOW_TOKEN_MINT=1`,
`WEBTERM_CONTROL_CWD_ROOTS=<tmp>/cwd`, and `agentLaunchCommands` pointing at temp shell
harnesses. Capabilities were minted via `POST /api/control/token` with the root token.
`val-node-1`-style IDs were used for scope tests; additional IDs were minted per test.
All checks below were executed; nothing is inferred from source alone.

## 1. Node-token scope — VERIFIED

Spawned node `vnode1` (agent `codex`) whose launch command wrote its injected
`$WEBTERM_TOKEN` to a temp file (`mode 600`, 36 bytes) and slept. The value was never
printed; it was used only in headers.

| Request | Status | Body |
|---|---|---|
| `POST /api/agent-status?node=vnode1` with node token | **204** | (empty) |
| `POST /api/agent-status?node=other-node` with node token | **403** | `{"error":"node token does not match node"}` |
| `GET /api/settings` with node token | **403** | `forbidden` |
| `GET /api/approvals` with node token | **403** | `forbidden` |
| `GET /api/control/nodes` with node token | **401** | `{"error":"unauthorized"}` |
| `GET /api/central/portfolio` with node token | **403** | `forbidden` |
| `POST /api/orchestrator/run` with node token | **403** | `forbidden` |
| `GET /api/channels/telegram/bindings` with node token | **403** | `forbidden` |
| `GET /api/settings` with root token | **200** | settings JSON |
| `GET /api/no-such-route` with root token | **404** | `{"error":"unknown route"}` |

Source refs: `src/server/auth.ts:128` (node-token path allowlist), `src/server/agentStatusApi.ts:128`
(token-to-node binding), `src/server/auth.ts:160` (node token only on allowlisted paths).

Resource scoping also held: a `node.spawn node:vnode1` capability could not spawn `node:spawn2`
(**403** `forbidden`), and `node.prompt node:prompt1` could not prompt `node:prompt2`
(**403** `forbidden`).

## 2. B2 stable deps / ack key — VERIFIED

Spawn replay with identical body and `requestId=req-b2-spawn-0001`:

- Spawn #1 -> **201** `{"ok":true,...}`
- Spawn #2 same requestId -> **201** replay; `GET /api/control/nodes` still showed exactly
  one `spawn1` entry, so no second PTY.
- `POST /api/control/close` reusing the SAME requestId -> **200**
  `{"closed":true,...}`. The close acted; it did not replay the spawn ack.
- Re-sending the spawn body afterwards -> **201** replay, and `spawn1` did NOT reappear in
  `nodes`; the 10-minute ack was replayed, not re-spawned.

Prompt replay used two `opencode` counter nodes that append each received line to a file:

- Same `requestId` to `prompt1` twice -> **200** both times; file line count stayed **1**.
- Same `requestId` to `prompt2` -> **200**; line count became **2** (per-resource key, not
  global).
- Duplicate prompt on the same key produced **0** extra lines.

Source refs: `src/server/control/controlTypes.ts:171` (`ackKey` = verb + node + requestId),
`src/server/control/mount.ts:63` (deps memoized per identity so AckStore survives requests).

## 3. B4 sessionId mint/validation — VERIFIED

Using `agentId=claude` with the harness script (args ignored by the script):

| Case | Status | Body |
|---|---|---|
| Supplied UUID `sessionId` | **201** | `{"ok":true,"requestId":"req-b4-uuid-0001","nodeId":"sid1"}` |
| `../x` | **400** | `{"error":"invalid_session_id"}` |
| 257-char id | **400** | `{"error":"invalid_session_id"}` |
| `""` empty | **400** | `{"error":"invalid_session_id"}` |
| `--help` (flag-shaped) | **400** | `{"error":"invalid_session_id"}` |
| No `sessionId` (auto-mint) | **201** | `{"ok":true,"requestId":"req-b4-auto-0001","nodeId":"sid2"}` |

Post-spawn `wait` on `sid1` returned
`{"state":"idle","output":"WEBTERM_TOKEN=set\r\nNODE=sid1\r\nPORT=8830\r\n"}` and `sid2`
returned `state:"exited"` with the same marker output: no crash, session id path works,
node env was injected.

Ordering note (not classified as failure): `isLive` is checked at
`src/server/control/controlApi.ts:71` before `resolveSpawnSessionId` at
`src/server/control/controlApi.ts:75`. On an already-live node, an invalid `sessionId`
therefore returns **409** `node_exists`, not 400. On a non-live node all invalid forms
returned 400 as required.

## 4. M5 tokensMatch / ghost close — VERIFIED

| Case | Status | Body |
|---|---|---|
| Close existing `close1` | **200** | `{"closed":true,...}` |
| Close again | **200** | `{"closed":false,...}` |
| Close never-opened `ghost` | **200** | `{"closed":false,...}` |
| Prompt dead `close1` | **404** | `{"error":"node_not_found"}` |
| Wait never-opened `ghost` | **404** | `{"error":"node_not_found"}` |
| Wait dead `close2` after buffered output | **200** | `state:"exited"`, `exited.code:-1`, `reason:"closed"`, `output:"WEBTERM_TOKEN=set\r\nNODE=close2\r\nPORT=8830\r\n"` |

Header separation:

| Case | Status | Body |
|---|---|---|
| Capability in `x-webterm-token` only | **403** | `forbidden` |
| Capability in `x-webterm-capability` | **200** | `{"closed":false,...}` |
| Capability only in query `?token=` | **403** | `forbidden` |
| Root token in `x-webterm-capability` (+ root in token header) | **401** | `{"error":"unauthorized"}` |
| Capability on `/api/settings` | **403** | `forbidden` |
| Wrong root token / same-length wrong root token | **403** | `forbidden` |
| Root token in query for `/api/settings` | **200** | settings JSON |

Source refs: `src/server/auth.ts:23` (`CAPABILITY_HEADER`), `src/server/auth.ts:168`
(capability read only from header, control paths only), `src/server/control/controlApi.ts:134`
(ghost close never calls `sessions.close`).

## 5. M2 body cap / invalid JSON — VERIFIED

| Case | Status | Body |
|---|---|---|
| JSON body exactly **65536** bytes | **400** | `{"error":"invalid_request_id"}` (not 413; parsed) |
| JSON body **65537** bytes | **413** | `{"error":"payload_too_large","max":65536}` |
| Invalid JSON `{not json` | **400** | `{"error":"invalid_json"}` |
| `text` length **32769** | **413** | `{"error":"text_too_large","max":32768}` |
| Chunked **70000** bytes, no `Content-Length` | **413** | `{"error":"payload_too_large","max":65536}` |

The chunked request trace showed `Transfer-Encoding: chunked` data frames (65304 + 4704 bytes)
and no `Content-Length`, proving the cap is enforced by byte accumulation, not by declared
length. Source refs: `src/server/control/controlTypes.ts:91`,
`src/server/control/mount.ts:112` (declared check), `mount.ts:117` (accumulated-byte check),
`src/server/control/controlApi.ts:109` (prompt text cap).

## 6. Line budgets — VERIFIED

At HEAD `3e867f0`:

```
150 src/server/control/mount.ts
146 src/server/api.ts
```

Both are `<= 150`. `mount.ts` sits exactly at the route budget.

## 7. Log hygiene — VERIFIED

Server log contained only:

```
webterm listening on http://127.0.0.1:8830 (prod, token on: len=48)
```

Greps for the root token, the node token, and harness stdout markers
(`WEBTERM_TOKEN=set`, `NODE=...`, `TOKENFILE=written`, `PORT=8830`) each returned **0**
matches. Harness stdout stayed in the PTY buffer/`wait` response, not the log.

## Cleanup — VERIFIED

Server and all harness/counter processes were terminated; `lsof -iTCP:8830` reported the port
free; no `/tmp/p1rev` processes remained. Temp data, scripts, token files, and logs were
removed. Repo source and tests were not edited or committed.

## Verdict

All seven acceptance groups are **VERIFIED** at HEAD `3e867f0`. No FAILED item.
One behavioral note only: on an already-live node, `409 node_exists` precedes sessionId
validation (`src/server/control/controlApi.ts:71`), so invalid sessionIds are observable as
400 only on non-live nodes.
