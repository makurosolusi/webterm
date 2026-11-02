# P4 wave 2 — review of HTTP/wiring surfaces

Scope (`0f12506 4c5110c 56eeef1 26ac251 f82342e d3d4c47 f04dd5d 59b9523`): `extendedApi`,
`orchestratorRunApi`, `centralHttp`, `memoryFileHttp`, `api.ts`, `channelsRuntime`,
`channelBindingsHttp`, `channelHttp`, `channelSenderBoot`, `index.ts`, `workerRuntime*`,
`memoryFile*`, `central/*`, `telegramSend(er)`.

Method: static read plus line-referenced probes in a scratch copy (`~/.jcode/scratch/p4wave2`;
repo untouched). The wave's own suites: 198 tests green. **[repro]** = reproduced in a probe;
**[speculative]** = inference from reading only.

---

## 1. Auth boundaries

**Verdict: correct today; the guard itself is untested and one test is trivially evadable.**

- `auth.ts:128-134` `isNodeTokenPath` is an exact/prefix allowlist of `/api/agent-status`,
  `/api/context-link`, `/api/control/*`. None of `/api/central/*`, `/api/orchestrator/run`,
  `/api/memory/export|rebuild`, `/api/channels/telegram/bindings` match → node token gets 403.
- `auth.ts:167` capability tokens require `isControlPath` **and** the `x-webterm-capability`
  header (never the query string). They cannot reach the new surfaces.
- Ordering is right in both listeners: `index.ts:94`/`:110` run `allowed()` before
  `channelsRuntime.handleApi` (`:96`/`:112`) and `handleApi` (`:97`/`:113`). The webhook is
  before the gate by design (`:93`/`:109`), owns exactly one path (`channelsRuntime.ts:226`),
  and authenticates with the provider secret.
- Mutations: `centralHttp.ts:18,32` and `memoryFileHttp.ts:34` pin `{kind:'human', id:'root'}`;
  no body-supplied authority is ever read → a body cannot claim human authority.
- A non-root caller cannot mutate projects: only the root token (or the pre-existing token-free
  loopback default) reaches `/api/central/projects/:id/{pause,resume,priority}`.

**A1 (Medium — test gap, real blast radius).** The negative list at `auth.test.ts:207-226` names
none of the new privileged paths. Adding `pathname.startsWith('/api/central')` to
`isNodeTokenPath` passes the entire suite. The one source guard (`indexChannelsWiring.test.ts:31`)
matches the literal `isNodeTokenPath('/api/channels` only, so a `startsWith('/api/channels')`
variant evades it too. Any agent PTY (which carries a node token on disk) could then pause
projects or launch workers.
*Fix:* extend the negative list; assert the four families in one `it.each`.
*Test:* `gate('/api/central/portfolio', { headers: ORIGIN_HEADERS, [TOKEN_HEADER]: NODE }) === false`,
repeated for `/api/orchestrator/run`, `/api/memory/export`, `/api/memory/rebuild`,
`/api/channels/telegram/bindings`.

---

## 2. Body handling

**B1 (Medium — comment contradicts code; root-only DoS).** `extendedApi.ts:8` claims bodies are
"capped hard (16 KiB)". The check at `:72` runs **after** `await readBody()` (`:71`), and that
reader (`api.ts:31-38`) accumulates every chunk with no bound:
```ts
req.on('data', (chunk) => { data += chunk })
```
Repro: `curl -X POST --data-binary @4G.bin -H "x-webterm-token: $T" \
http://127.0.0.1:8700/api/orchestrator/run` — 4 GiB is fully buffered (through a string rope)
before any 413; RSS follows the upload, so a 16 GiB body OOM-kills the terminal server.
Versus existing routes: `/api/control` rejects on `Content-Length` **before** reading
(`control/mount.ts:112-119`), `/api/approval` and the channel edges read through capped readers.
`/api/workspaces` is equally unbounded, so this is not a new class — but this wave is the first
to advertise a cap it does not enforce. The flag gate (`:79-86`) also runs after the read, so a
disabled surface still eats the whole body.
*Fix:* reject when `content-length > MAX_API_BODY_BYTES` before `readBody`; long term pass a
capped reader (`channels/channelHttp.ts:30` `readCappedBody`) instead of `() => readBody()`.
*Test:* fake `req` with `content-length = MAX+1` and a `readBody` spy → assert 413 **and** that
`readBody` was never called. `extendedApi.test.ts:45` only proves the post-buffer 413.

**Channel paths are correct.** `channelHttp.ts:30-60` enforces the cap while streaming, drops the
listener and `req.resume()`s on overflow, so it never buffers past `maxBytes + 1` chunk;
`channelBindingsHttp.ts:39-50` additionally rejects a declared oversize before reading. The 8 KiB
(bindings) and 64 KiB (webhook, `webhook.ts:11`) paths genuinely stop early.
**B2 (Low, dead code):** `channelBindingsApi.ts:17`/`:276` can never fire because
`channelBindingsHttp.ts:14` caps at 8 KiB first. Two constants for one limit invites drift.
*Fix:* import `BINDINGS_BODY_LIMIT_BYTES` or delete the inner check.

---

## 3. Orchestrator run

Repo/cmd/agent are correctly server-derived: `parseRunBody` rejects
`repo,path,cwd,cmd,command,args,argv,exec,env,shell,agent,agentId`
(`orchestratorRunApi.ts:43-56`, `:112-116`); repo from `project.path` (`:162-167`), cmd from
settings (`:190-198`), agent id a constant (`:32`). The run actor is
`task.leaseOwner ?? task.agentId` (`workerRuntime.ts:108`), never the body.

- Assigned item required: `assignmentProblem` (`:170-188`) answers 409 `not_assigned` before a
  runtime is built, and `startWorker` re-checks (`orchestratorRun.ts:29-35`).
- Cross-project run: impossible. `task.projectId === input.projectId` (`:38`) and `ownsProject`
  (`:43`); a body `projectId` for another project only works if that project's item is genuinely
  assigned — still a root-authorized run of that project.
- Escape/symlink: repo must be absolute (`worktree.ts:165`); target inside root (`:207`) via lstat
  + realpath (`worktreeTarget.ts:22-48`); release re-validates inside-root and symlink
  (`worktree.ts:267-269`). `baseRef` validated (`orchestratorRunApi.ts:138`, `worktree.ts:173-181`).
  Timeout clamped 5 s..15 min (`:147`), enforced with a poll ceiling
  (`workerRuntimeSettle.ts:22-32`).
- `contextOf` cast (`:215-219`, `(deps.ledger?.ledger ?? {}) as never`): safe only because `:245`
  returned 503 when the runtime is null; the `?? {}` branch is dead and would become a `TypeError`
  → generic 500 if it ever went live.

**C1 (Medium — a failed run can leak a live PTY and a held worktree).** Everything after
`deps.sessions.open` (`workerRuntime.ts:194-220`) is outside a try/catch. A throw from
`statusOf`/`getTerminal`/`waitForSettle` propagates out of `runTask` while `opened === true`, so
`cleanup()` never runs. **[repro]** probe with a session port whose `statusOf` throws on the
second poll: `runTask` threw, `close` never called, `worktrees.release` never called, task left
leased until the reaper. Real `Sessions` (`sessions.ts:118-124`) does not throw today, so this is
robustness, not escalation — but it is the only path that skips "close the PTY always".
*Fix:* wrap `:228-275` and route the catch through `fail('spawn_failed', …)` (already does
`record` + `cleanup(true)`).
*Test:* "closes the PTY and releases the worktree when the session port throws after open"
(assert `closed === ['w-t1-1']`, `released === ['t1']`).

**C2 (Low-Med, concurrent plan mutation).** `orchestratorRun.ts:178` releases the worktree, then
`:184` `updateItem` can throw `stale_version`; the catch returns a deny **after** `claimSuccess`
already wrote `verified`. Result: task `verified`, item still `running`, worktree gone, route 409.
*Fix:* move the item transition into the same `tx` as the claim.
*Test:* plan store whose `updateItem` throws `StalePlanVersionError`; assert the task is not left
`verified` with a `running` item.

**C3 (Low).** `plan.status` is never checked (a `draft`/`completed`/`abandoned` plan still runs),
and `project.status === 'paused'` does not block a run. **[speculative]** may be intentional for P4.

---

## 4. Memory files

- Flag off is inert: `memoryFileHttp.ts:141` and `memoryFile.ts:66` return `disabled` before any
  fs/git/SQL. Split source of truth: the route honours `deps.enabled/deps.env`, the writer re-reads
  `process.env` (`:66`, `:166`) — identical in production, but any caller injecting `env` gets a
  confusing 503. *Fix:* thread the resolved flag into the writer.
- Git argv injection: none found. `relPath` is `safeSegment` output (no leading `-`, no `..`,
  `[A-Za-z0-9._-]`) (`memoryFilePath.ts:42-52`); argv uses `--` (`memoryFile.ts:81-83`); no shell
  (`memoryFilePath.ts:93-103`); the message is `oneLine`-sanitized and consumed by `-m`.

**D1 (High — path omits `scope`, so two facts share one file).** `memoryFilePath.ts:50-52` builds
`${projectId}/${key}.md`, but the DB key is unique per `(project, scope, key)`
(`ledgerSchemaV1.ts:126-136`). `project:deploy` and `scratch:deploy` are legal distinct facts that
map to the **same** file. **[repro]** export `m-proj` then `m-scratch` → both return
`relPath = 'p1/deploy.md'`, and the second export silently overwrote the first; rebuild can then
restore only one scope, the other fact being unrecoverable from files.
*Fix:* `${projectId}/${scope}/${key}.md` (pass `memory.scope`; rebuild already reads `scope`).
*Test:* "exports two facts differing only by scope to two distinct paths and rebuild restores both"
(distinct `relPath`s, both files exist, `inserted === 2`, no quarantine).

**D2 (High — rebuild reverts a supersede).** `applyRecord` (`memoryFile.ts:118-127`) matches on
`(project, scope, key)`, ignores `updated_at`, and always writes `status='fact'` with the file body.
The file written before a supersede is never removed, and `supersedeMemory` aliases the old row's
key (`memoryWrite.ts:202-213`), so the stale file becomes truth for the live key.
**[repro]** export "OLD body" → supersede to "NEW body" → `rebuildMemoryIndex` → the live row's
body becomes `"OLD body"`. Any rebuild silently rolls a supersede back.
*Fix:* refuse a downgrade — if `existing.updated_at > record.updatedAt`, count `unchanged`
(or quarantine as `stale_file`); ideally rewrite the file on supersede.
*Test:* the probe above, asserting `body === 'NEW body'`, `quarantined.length === 0`.

- Confinement: `resolveInside` is lexical (`:55-65`); `assertConfined` (`:77-91`) realpaths the
  leaf and every ancestor and rejects symlink escapes. TOCTOU only against the root-owned writer
  (dirs 0700, files 0600) → **Low**. **[speculative]** `port.write` (`:117-136`) uses only the
  lexical check, so a symlink planted between check and `rename` would be followed; `O_NOFOLLOW`
  would close it.
- `WEBTERM_MEMORY_DIR`: absolute-only (`memoryFileHttp.ts:58`); a **relative** value is silently
  discarded for `<dataDir>/memory`, so an operator typo is invisible. **Low** — log one warning.

**D3 (High — the write path cannot work on a fresh install).** Nothing creates or `git init`s the
memory root (`memoryRoot` `memoryFileHttp.ts:56-60`; no `mkdir`/`git init` anywhere).
`assertConfined` throws when the root is absent (`memoryFilePath.ts:78-79`) and `git add` fails in
a non-repo. **[repro]** probe on a temp `dataDir`: `writeMemoryFactFile` threw
`memory file root does not exist: <abs>/memory` → 400 `memory_file_error`; after a manual `mkdir`
the next call would fail at `git add` (no repository). `WEBTERM_MEMORY_FILES=on` is therefore inert
until an operator creates the dir *and* inits a repo.
*Fix:* `mkdir 0700` + idempotent `git init -q` in the port factory when `.git` is absent.
*Test:* real port on a `mkdtemp` dir creates the root and initialises the repo (every HTTP test
injects `fakePort()` rooted at `process.cwd()`, `memoryFileHttp.test.ts:38-52`, hiding this).

- Non-human authority / body id → CORE or worker write: impossible. Authority is fixed human/root;
  the body only supplies an existing row `id`; `renderMemoryFile` rejects `scope === 'core'`
  (`memoryFileRender.ts:32`) → 403, and `parseMemoryFile` refuses to rebuild core (`:81-83`).
- Error text: `safeMessage` (`memoryFileHttp.ts:62-65`) caps at 300 chars but does **not**
  `redactSecrets`, unlike the Telegram sender; it can surface the absolute root, relPath, and raw
  `git stderr/stdout` (`memoryFile.ts:82,88`) — a commit hook in that repo can print anything.
  Root-only caller → **Low**. *Fix:* wrap in `redactSecrets`.
- Quarantine correctness: grouping by `project\0scope\0key` (`memoryFile.ts:183-193`) and
  quarantining every row of that triple with one audit event each is correct. It compares only
  `title`/`body`, so same content with different `evidence`/`updatedAt` is not flagged. **Low.**

---

## 5. Telegram egress

- Token: read at **send** time (`telegramSend.ts:102-103`), never stored, returned or logged; it
  appears only inside the request URL (`:132`). Every failure path scrubs it — `clean()`
  (`:68-70`) calls `redactSecrets(text, [token])`, which also scrubs
  `TELEGRAM_BOT_TOKEN`/`WEBTERM_TOKEN`/the webhook secret from `process.env`
  (`webhook.ts:284-295`); the timeout path returns a fixed `'timeout'` (`:140-147`); provider
  `description` is scrubbed (`:168-176`). The store schema holds no token
  (`channelStoreSchema.ts:12-25`).
- Group denial: `channelBindingsApi.ts:174-185` refuses `approver`/`owner` for a negative id or
  `isGroup === true` → 403, nothing stored (**[repro]** `channelBindingsHttp.test.ts:146`).
  Residual: `parseBinding` (`channelStoreSchema.ts:57-65`) does not re-apply the rule on load, so a
  hand-edited `channels.json` could hold a group as `owner`. **Low**; re-validate on load.
- Start/stop: `channelSenderBoot.ts:44-47` starts only with a token, logs one redacted line
  otherwise; `track()` installs a single `process.once('exit')` stop (`:29-37`); `unref` keeps the
  timer out of the loop (`telegramSender.ts:241-242`); `flushOnce` refuses to overlap (`:108`).
  Presence is sampled at boot, so a token configured later drains only after a restart, despite
  `channelsRuntime.ts:216` implying otherwise. **Low** doc/behaviour mismatch.
- Outbox `nextAt`/dead: `parseReply` normalises a missing v1 `nextAt` to `createdAt`
  (`channelStoreSchema.ts:91-104`); `markReplyFailed` persists `nextAt` + `dead`; dead/sent rows
  drop their in-memory entry (`telegramSender.ts:143-186`); `not_configured` stays pending
  (`:154-160`). **[repro]** `telegramSender.test.ts:336`, `channelStore.test.ts:95`.

**E1 (Low).** `channelsRuntime.ts:252-256` keys the failure throttle on
`req.socket.remoteAddress`. Behind a proxy every peer is the proxy, so 30 bad secrets in 60 s
(`channelThrottle.ts:4-5`) block genuine deliveries for the window. *Fix:* opt-in trusted-proxy /
`X-Forwarded-For` keying.
`resolveApiBase` (`telegramSend.ts:89-92`) reads `process.env` instead of `options.env()`,
making the test seam incomplete. **Low.**

---

## 6. Central

- No auth by design (`centralHttp.ts`), reachable only through the root-only `/api` gate (§1);
  `isCentralPath` (`:27-29`) matches portfolio and `projects/` exactly, so the mount never widens.
- The mutation guard is **fixed** `human/root` (`:18,32`) and `centralApi.ts:75-87` re-runs
  `assertHumanAuthority`, so even a widened `authorize` cannot promote an agent.
  **[repro]** `centralHttp.test.ts` "a body that claims agent authority is ignored".
- `decodeProjectId` (`centralApi.ts:38-45`) un-escapes one segment; a `%2F`-derived id containing
  `/` is length-validated (`centralModel.ts:70-82`) and used only as a bound parameter → no
  injection.
- 503 gates: flag then runtime (`centralApi.ts:118-120`), matching `extendedApi.ts:79-86`.
- No N+1: `portfolio` (`centralProjection.ts:206-247`) issues 6 aggregate statements with `IN (…)`
  plus the page query; `projectPortfolio` reuses it with a filter. All lists are LIMIT/OFFSET
  bounded (200 / 1 000 000).
- `priority` with no body → `clampPriority(undefined)` → 400 `invalid_priority`
  (`centralApi.ts:100-102`); cosmetic.

---

## 7. Worker runtime

- Double record: the `recorded` flag (`workerRuntime.ts:126`) plus every branch going through
  `record`/`fail`; the `stale_fence` hold-on path correctly skips release (`:253-256`).
- Stale fence/cleanup: closes only a node it opened (`opened && !closed`, `:148`) and releases only
  a worktree still owned by the same path (`:157-158`). Correct.
- Caps: prompt 2000 chars at the route, 8 KiB runtime; output 64 KiB (`:42`, `:228`); ANSI
  stripped (`workerRuntimePrompt.ts:7-12`). `capBytes` slices by bytes (`:14-18`) and can split a
  codepoint — cosmetic. `sanitizeText` leaves C1 controls (U+0080–U+009F, e.g. `\u009b`); JSON
  escaping prevents body injection, only a later terminal render could be affected. **Low.**
- Node ids: `w-${taskId}-${fence}` truncated to 64 (`workerRuntimePrompt.ts:21-23`). Task ids are
  UUIDs (`ledgerCore.ts:78-80`), so the fence is never truncated today; a longer id would drop the
  fence and could collide with a prior attempt of the same task (caught by `isLive`, which cannot
  distinguish this collision from a genuine live node). **Low**; hash instead of slice.
- Exit/lease race: `waitForSettle` (`workerRuntimeSettle.ts:17-33`) returns `session_exited` before
  the lease check; both become a recorded failure with cleanup. The lease is a deadline, never
  refreshed — a healthy run longer than `caps.leaseMs` fails; document it in the 409 codes.
- The one leak path is C1.

---

## Missing tests that survive a critical mutation

1. **Node-token allowlist for the new families** (`auth.test.ts:207-226`): adding
   `/api/central`, `/api/orchestrator`, `/api/memory/export` or `/api/channels` to
   `isNodeTokenPath` passes everything (A1).
2. **Capability confinement**: nothing asserts
   `authorizeRequest({ pathname: '/api/central/...', headers: { 'x-webterm-capability': CAP } }) === false`
   with `isCapabilityToken` supplied; only control paths are covered.
3. **Pre-buffer body cap** on `extendedApi` (B1): deleting the post-read check, or a future
   `content-length` guard, is undetected.
4. **Memory scope in the relPath** (D1): dropping `scope` is undetected — every export test uses
   one scope.
5. **Rebuild vs supersede** (D2): no test supersedes then rebuilds.
6. **Real memory port on a cold root** (D3): all HTTP tests inject a fake port, so "root missing /
   not a git repo" never runs.
7. **Session-port throw after open** (C1): no test makes a session call throw.
8. **Plan mutation between start and record** (C2): no test drives `updateItem` to a stale version
   during a successful verify.

## Priority

| ID | Severity | One-line |
|----|----------|----------|
| D1 | High | memory relPath drops `scope` → two facts, one file, silent loss |
| D2 | High | rebuild from a stale file reverts a supersede |
| D3 | High | memory write path is inert on a fresh install (no dir, no `git init`) |
| B1 | Medium | `extendedApi` buffers the whole body before the 16 KiB check |
| A1 | Medium | new root-only families absent from the auth negative list |
| C1 | Medium | a throw after `open` skips PTY close + worktree release |
| C2 | Low-Med | task `verified` while the plan item stays `running` |
| E1 | Low | webhook throttle keyed on a proxy address can block deliveries |
| B2/C3/etc | Low | 16 vs 8 KiB constants, unredacted error text, paused/draft plans still run |

*Disclaimer: static review plus targeted probes in a scratch copy. Runtime-only issues outside
those probes (PTY timing, real Telegram delivery, real `bun:sqlite` contention) are not covered.*
