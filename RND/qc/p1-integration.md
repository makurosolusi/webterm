# QC review — P1 control path, end to end

Branch `feature/agent-pusat-p1` @ `2872190`. Read-only review: no production or test file was
modified; only this report was written.

Scope read in full: `src/server/control/{mount,controlApi,controlTypes,capabilities,waiters}.ts`,
`src/server/{api,index,auth,sessions,agentStatusApi,contextLink,hooks,launchLine,pty,ptyShell,nodeRegistry}.ts`,
`src/shared/{workspace,settings,protocol}.ts`, `RND/03-RENCANA.md`, `CHANGELOG.md`, `.env.example`.

Tests run: `npx vitest run src/server/control src/server/auth.test.ts` → **97 pass / 4 files**.
All existing tests are green. Every blocker below is *outside* what those tests actually exercise.

Probes (bun, in `$JCODE_SCRATCH_DIR`, never in the repo, `WEBTERM_DATA_DIR` pointed at scratch):

1. `authorizeRequest` with a `wcap_*` header, a node token, and the root token.
2. `handleControlHttp` without `overrides` (i.e. the *production* deps path): mint → spawn → spawn
   with the same requestId → nodes → close.
3. Real `sessions` singleton: spawn, `wait until=exit`, inspect `getTerminal` before/after exit.

Probe output is quoted next to each finding. `git status` is clean afterwards; two PTY children
(`cursor-agent`, absent on this machine → exit 127) were reaped.

## Verdict

The control path is **not functional end-to-end**. The unit tests pass because they stop at
`handleControl`/`handleControlHttp` with injected deps; none of them crosses `index.ts`'s transport
gate nor the production `resolveDefaultDeps` object identity. Three of the six blockers are
directly observable with the probes below.

---

## B1 — BLOCKER: a capability token never reaches the control API (gate rejects it)

`src/server/index.ts:41-49` (`allowed`) / `:72,:83` gate every `/api/*` request through
`authorizeRequest`, which accepts exactly two things (`src/server/auth.ts:138-152`): the root token
(`x-webterm-token` / `?token`) or a *node* token (`hooks.ts:117-121`). Capability tokens are neither.
`isNodeTokenPath` allows the *path* (`auth.ts:125-131`), but the value still has to be a node token.
The control API only ever reads `x-webterm-capability` (`controlApi.ts:59-64`), so a capability-only
client is refused before `mount.ts:73` is even called.

Probe 1:

```
path allowlisted: true
capability-only accepted: false
node-token accepted: true
root accepted: true
```

Failing scenario: the documented flow — mint a `wcap_*` (`RND/03-RENCANA.md:126` says the transport
gate maps "process token, node token, dan capability" — it does not), then call

```
curl -X POST :8700/api/control/spawn -H 'x-webterm-capability: wcap_…' -d …
```

→ `403 forbidden` (plain text from `index.ts:53-56`), never `mount.ts:96`. The only way to get
through today is to *also* send the root token, at which point the capability adds no delegation:
the whole point of the scoped token is gone.

Why tests miss it: `mount.test.ts:84-97` calls `handleControlHttp` directly; `index.ts` is never in
the call path. The mint→verify test (`mount.test.ts:139-152`) proves the store, not the gate.

Fix: extend the transport gate for `/api/control/*` with a capability validator (inject an
`isCapabilityToken` alongside `isNodeToken`, mirroring `authorizeRequest`'s existing injection
style), or drop `/api/control/*` from the root-gated `/api/` surface and let `mount` do all auth.

## B2 — BLOCKER: requestId replay (10-minute idempotency) is dead in production

`mount.ts:92-95` builds a **new object every request**:

```ts
const deps: ControlDeps = injected ? overrides : { ...(await resolveDefaultDeps()), ...overrides }
```

`controlApi.ts:39-48` keys the `AckStore` by that object identity (`WeakMap<ControlDeps, AckStore>`).
In production every request therefore gets a fresh, empty store, so `acks.get` (`:89`, `:125`, `:148`)
never hits. Tests inject one stable `deps` (`mount.test.ts:66-79`, `controlApi.test.ts:20-75`), which
is why `controlApi.test.ts:159,220,243` pass.

Probe 2 (production path, no overrides):

```
spawn#1:                   201 {"ok":true,…}
spawn#2 (same requestId):  409 {"error":"node_exists"}
```

Failing scenario: a client retries `POST /spawn` after a timeout (the exact reason the ack window
exists, `RND/03-RENCANA.md:113`) → `409 node_exists` instead of replaying the original `201`. Same
for `prompt`: a retried `requestId` injects the prompt text into the agent twice. `close` replay
after a re-spawn returns `closed:false` instead of the original body.

Fix: resolve default deps **once** (module-level `Promise` cache is already there) and return that
same object; apply `overrides` for tests either by mutating that cached object in tests or by
keeping a separate stable wrapper (e.g. cache the merged object per `overrides` reference).

## B3 — BLOCKER: `wait … until:exit` always returns an empty `output`

`controlApi.ts:164-168` (`observe`) reads `sessions.getTerminal(id)`; `sessions.ts:105` reads only
`this.map`; `sessions.ts:291` deletes the session from `map` in `onExit`. By the time the exit
tombstone is visible, the scrollback is gone. `OutputLog` lives only in `Session` (`sessions.ts:19-25,
199-205`) and is never moved to the registry that survives exit.

Probe 3:

```
wait: 200 {"state":"exited","exited":{"code":127,"reason":"self"},"output":""}
```

(with the same node's PTY having written a `command not found` line; `getTerminal` length measured 0
at, and after, exit).

Failing scenario: `until=exit` is the primary way a central agent learns what its node did. It gets
an exit code and no output — for every node, always. The unit test that asserts `output:'bye'`
(`controlApi.test.ts:261-265`) uses a fake whose `live` map keeps the entry after exit, so it passes
against behavior the real `Sessions` does not have.

Fix: keep the `OutputLog` (or its text) in `NodeRegistry` per exit tombstone, or do not delete the
log on exit; `getTerminal` should fall back to the tombstoned log.

## B4 — BLOCKER: control-spawned Claude never gets hooks, so status/transcript/`wait status:done` are dead

`controlApi.ts:109-112` opens a session with `{t:'open', id, cols, rows, cwd?, cmd, agentId}` — no
`sessionId`, no `resume`. `sessions.open` passes `sessionId` into `launchLine` (`sessions.ts:158-162`),
and `launchLine.ts:47-49` **returns `cmd` verbatim when `sid` is absent**, which skips the
`hasClaudeHookSettings` branch (`launchLine.ts:55-61`) that appends `--settings <file>`. Therefore
`writeClaudeSettings` is never called for a control-spawned node, so:

- no hook POSTs → `sessions.setStatus` never runs → `statusOf` is `undefined` → `GET /nodes` has no
  `status`, and `controlApi.ts:198` (`until: 'status:done'`) can never be true; the call always burns
  the full 25 s and returns `{state:'timeout'}` even after Claude finished its turn;
- `setTranscript` never runs → context-link `transcript`/`summary` dead (see M1);
- no `--session-id` → every spawn is an unrelated Claude session, and there is no way to ask control
  for the id to resume it (`OpenMsg.sessionId` is not accepted by `/spawn`).

The env block at `sessions.ts:181-189` (node token, `NODETERM_NODE_ID`, `hookEnv`) still runs, but
`hookEnv`'s token is useless when no hook is installed. So "does a spawned agent get
`WEBTERM_TOKEN`?" — **yes** (`sessions.ts:182`), but the hook half of that contract is not wired.

Failing scenario: `POST /spawn {agentId:'claude'}` → run a turn to completion → `POST /wait
{until:'status:done'}` → 25 s timeout; `GET /nodes` shows `{id,pid}` only.

Fix: mint a session id in `spawnRoute` (`randomUUID()` for `claude`-style agents via
`mintsSessionId`) and pass `sessionId`, or make `launchLine` attach the hook settings even without a
sid (the hook settings do not need the session id).

## B5 — BLOCKER (security): the context-link shim puts the ROOT token on disk

`index.ts:60` calls `installContextLink(TOKEN)`; `contextLink.ts:189-190` embeds
`x-webterm-token: <root token>` into `~/.webterm/context-links/context.sh` (`:268-270`, mode 0700
`:285`). This directly contradicts the new comment in `hooks.ts:173-175` ("Root token tidak pernah
menyentuh disk") that justifies the whole node-token scoping commit `2872190`.

Failing scenario: any PTY child (including an agent launched by control) reads
`~/.webterm/context-links/context.sh` — same uid, 0700 — and extracts the root token, then uses
`PUT /api/settings` or `/ws`, both root-only by design (`index.ts:30-40`). The node token scoping is
bypassable, and the shim does the leak itself, not just the file.

Fix: the shim already runs inside an agent PTY and receives `WEBTERM_TOKEN` (the node token,
allowlisted for `/api/context-link` at `auth.ts:127`). Use `-H "x-webterm-token: $WEBTERM_TOKEN"`
(or `curl`'s default env expansion) and stop passing `TOKEN` to `installContextLink`.

---

## M1 — Context-link does not work for control-spawned nodes at all

`contextLink.ts:157-158`: `findWorkspaceFor(db.list(), requesterId)` returns undefined unless the
node id exists in a persisted workspace's `nodes`. Control `spawn` never writes a node to any
workspace, so the shim exits with `Not a webterm agent node — nothing to read.` Even after B4/B5 are
fixed, a headless central agent has no linked context. Either accept that (document it) or teach
`findWorkspaceFor`/`renderForRequester` about control-spawned ids.

## M2 — Unbounded body read before any auth or size check

`mount.ts:83-88` calls `readBody()` for POST/PUT *before* deps/auth, and `api.ts:26-33`
(`readBody`) concatenates with no cap and no `Content-Length` check. `MAX_PROMPT_CHARS`
(`controlApi.ts:129`) is enforced only after the whole body is a JS string.

Failing scenario: default loopback, token off (`auth.ts:57` returns undefined and `auth.ts:107-115`
treats "no token configured" as authorized), any local process sends
`curl -X POST --data-binary @big /api/control/spawn` → server buffers the whole payload before
answering `400 invalid_request_id`. With a root token configured the request is authenticated, but
the memory blow-up is the same. Fix: cap at the transport (e.g. 64 KiB for control, reject 413 via
`Content-Length` + a streaming counter).

## M3 — The control API cannot be used on a default install

`mount.ts:43-44` requires both `WEBTERM_TOKEN` and `WEBTERM_ALLOW_TOKEN_MINT=1`; otherwise
`tokenRoute` answers 404 (`controlApi.ts:249-251`). A loopback install has no root token
(`auth.ts:48-57`), so there is no way to mint and therefore no way to call a single control route
(all answer 401). `RND/03-RENCANA.md:122` promises "Mint hanya CLI loopback atau flag root
eksplisit"; the loopback-CLI half is not implemented. Neither flag appears in `.env.example` or any
README section.

Failing scenario: fresh checkout, `bun run dev`, `POST /api/control/token` → `404 not_found`.

## M4 — `cwd` is only checked for being absolute

`mount.ts:46` (`cwdAllowed: npath.isAbsolute`) is explicitly marked "P1 masih permisif; P1b", but
`RND/03-RENCANA.md:134` requires realpath + workspace-root confinement for P1. A capability minted
for one node can spawn `claude` in `/`, `~/.ssh`, or any other directory (`controlApi.ts:98-105`).
Not a break of the stated P1 acceptance matrix, but it is a boundary the plan claims and the code
does not have; worth stating in the PR rather than silently deferring.

## M5 — `close` on a node that never existed creates a phantom exit

`controlApi.ts:151-153` computes `closed = isLive(id)` and then calls `sessions.close(id)`
unconditionally; `sessions.ts:241-242` writes an exit tombstone regardless of whether a session
existed.

Failing scenario: `POST /close {nodeId:'ghost'}` → `200 {closed:false}`; afterwards `POST /wait
{nodeId:'ghost', until:'exit'}` → `200 {state:'exited', exited:{code:-1,reason:'closed'}}` for a node
that was never spawned. Contradicts its own `closed:false` and pollutes the 256-entry tombstone ring
(`nodeRegistry.ts:18`).

## M6 — `until: 'idle'` fires on an empty buffer

`controlApi.ts:199-200` compares two consecutive `getTerminal` snapshots. An agent that has produced
no output yet (Claude booting, waiting on network, or writing only after the first prompt) has `''`
at both polls → `state:'idle'` after ~100 ms while the node is still working. The heuristic ignores
`statusOf`, which is the only real signal for "not working" (and is itself unavailable until B4 is
fixed).

Failing scenario: `POST /spawn {agentId:'claude'}` then immediately `POST /wait {until:'idle'}` →
`{state:'idle', output:''}` although Claude is still starting.

---

## Speculative / latent (not reachable today, but they are the next bug)

- **Ack key is only `requestId`, not `(path, requestId)`** — `controlApi.ts:39-48` + `:89,:125,:148`.
  Once B2 is fixed, reusing a requestId across routes replays the *other* route's response: spawn
  with `R`, then close with `R`, answers `201 spawn` and the node is never closed. Latent only
  because B2 makes the store always empty.
- **Capability qualifiers are never enforced** — `authorize` (`controlApi.ts:66-78`) passes no
  `ctx`, and the mint route cannot even set a qualifier (`controlApi.ts:255-271`). `agentIds` /
  `cwdPrefix` (`capabilities.ts:36-47,122-130`) are dead fields. If qualifiers are added to minting
  without passing ctx, they will silently not apply.
- **Node-token allowlist vs. control API mismatch** — `auth.ts:129` and `hooks.ts:174` claim a node
  token opens `/api/control/*`, but `controlApi.ts:59-64` only accepts capabilities → a spawned
  agent's `POST /api/control/nodes` passes the transport gate and then gets `401 unauthorized`. Not
  exploitable (fail-closed), just dead allowance and a misleading comment.
- **Cached rejected import** — `mount.ts:36-49` stores the promise with `??=`; one failed dynamic
  import (`../db`/`../sessions`) is cached forever, so every later control request 500s until the
  process restarts. Import failures are rare, but the failure mode is permanent.
- **`CapabilityStore.sweep` is never called** — `capabilities.ts:209-218` exists but no timer/call
  site in production; expired tokens are only dropped when the *same* token is verified. Bounded by
  root-only minting, so memory-only.
- **No 405 handling** — `GET /api/control/spawn` returns `mount.ts:97 false` → `api.ts:127`
  `{error:'unknown route'}` on a `GET`, which reads like "no such endpoint" rather than "wrong
  method". HEAD is treated as a non-matching method for every route for the same reason.
- **Malformed JSON is reported as `invalid_request_id`** — `mount.ts:53-59` maps `catch` to `{}`,
  then `controlApi.ts:84` fails the first field it looks at. An `invalid_json` 400 would be honest.
- **`nodes`/grant mismatch** — `controlApi.ts:232-235` returns 403 for a `workspace:`/`project:`
  grant even though the plan lists those resources for node scopes (`RND/03-RENCANA.md:119`); an
  exited node disappears from `/nodes` entirely, and the `status` field is optional in the type but
  absent from JSON (`JSON.stringify` drops `undefined`). No API doc fixes the shape, so this is a
  spec gap, not a proven bug.

---

## Line budgets and duplication (Rule 8)

- `src/server/control/controlApi.ts` — **297 / 300** service lines. At 99%; the next route breaks it.
- `src/server/sessions.ts` — **307 / 300** service lines. It was already 302 before this branch;
  `2872190` added to an over-limit file (the added lines are the `env` block, `:181-189`).
- `src/server/control/mount.ts` — 100 / 150 route. OK. `capabilities.ts` 228, `controlTypes.ts` 154. OK.
- Duplication that should be shared:
  - `json()` — `mount.ts:61-66` is a byte-for-byte copy of `api.ts:17-24`. The comment says "bentuk
    respons yang sama seperti api.ts", which is exactly the kind of invariant that should be one
    exported helper, not a copy that can drift (e.g. the 204 no-body rule is already only in `api.ts`).
  - The `CONTROL_PREFIX` membership check is done twice: `mount.ts:81` and `controlApi.ts:283`. The
    mount already knows the family; the second check only matters for direct `handleControl` tests.
  - `parseBody` (mount) vs `readBody` (api) vs `readBody` (`agentStatusApi.ts:50-55`) — three body
    readers, two of them unbounded (M2).

## Test coverage gaps that hide the blockers

- No test runs `index.ts`'s `allowed()` against `handleControlHttp` (B1).
- Every control test injects a stable `deps` object (`mount.test.ts:66-79`,
  `controlApi.test.ts:20-75`); no test calls `handleControlHttp` twice without overrides (B2).
- The `wait` fakes keep `output` after exit (`controlApi.test.ts:261-265`), unlike `Sessions` (B3).
- The `status:done` test sets status directly on a live fake node (`controlApi.test.ts:283-301`); no
  test covers a real control-spawned node, which has no hooks (B4).
- No test asserts the shim's token is *not* the root token (B5).

Suggested regression tests (in the same PR, per Rule 3): one integration test that boots the
transport gate with a `wcap_*` header; one that calls `handleControlHttp` twice with identical
requestId and no overrides; one that drives the real `Sessions` fake through exit and asserts `wait`
still returns the last output; one that captures the `OpenMsg` from `spawnRoute` and asserts
`sessionId` is present for `claude`.

## What is verified good

- One exec path: `spawnRoute` calls `deps.sessions.open` (`controlApi.ts:109`) exactly like the WS
  path; `cmd` is never taken from the body, always `assembleCmd(agentId, settings…)`
  (`:108`), and `agentId` must be a builtin (`:93`).
- Capability store is a single instance shared by mint and verify (`mount.ts:13-27`) — no mismatch.
- Hash-at-rest, TTL clamp, `*` restricted to `node.read`, exact-resource matching with `/`-scoped
  workspace/project prefixes (`capabilities.ts:103-150,160-196`) — tested and correct.
- Input validation on every route: `isSafeNodeId`, `isValidRequestId` bounds, positive-int cols/rows
  with caps, `until` whitelist, timeout bounds, prompt length (`controlApi.ts:84-105,128-132,180-189`).
- `plan` is a real 501 behind `plan.read` (`controlApi.ts:239-244`); it is reachable from the mint
  route with a concrete resource.
- Node status path for *WS-spawned* agents is intact: node token in `WEBTERM_TOKEN`
  (`sessions.ts:182`), header file with both headers (`hooks.ts:263-278`), `/api/agent-status` and
  `/api/context-link` allowlisted for node tokens (`auth.ts:125-131`), hooks work when `--settings`
  is attached (i.e. when a `sessionId` is present).
