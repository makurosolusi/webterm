# QC review — P1 test suite (false-confidence audit)

Branch `feature/agent-pusat-p1`, commit **`2872190`** (`feat(security): scope transport tokens to
agent nodes`). Read-only review: no production or test file in the repo was modified; the only
repo write is this report.

**Basis note.** While this audit ran, another session started editing the working tree
(among others `src/server/auth.ts`, `agentStatusApi.*`, `api.ts`, `control/*`, `hooks.*`,
`index.ts`, `nodeRegistry.ts`, `sessions.ts`, plus new `RND/qc/p1-*.md`). Those edits are
**not** part of this review. Everything below was measured against a pinned copy of `2872190`
extracted with `git archive HEAD`, so the line numbers and mutation results are reproducible and
do not drift with that other session.

Scope (all eight files named in the task):

```
src/server/control/capabilities.test.ts
src/server/control/controlApi.test.ts
src/server/control/mount.test.ts
src/server/agentStatusApi.test.ts
src/server/auth.test.ts
src/server/hooks.test.ts
src/server/ptyShell.test.ts
src/server/sessionsFake.test.ts
```

Verification run (pinned HEAD): `npx vitest run <8 files>` → **8 files / 198 tests pass**
(auth 42, capabilities 24, mount 6, controlApi 25, agentStatusApi 17, ptyShell 14,
sessionsFake 27, hooks 43).

Method, all outside the repo:

1. `~/scratch/p1head` = `git archive HEAD` extraction; `~/scratch/p1mut-head` = same tree with a
   symlinked `node_modules`, used as the mutation sandbox.
2. `~/scratch/mutate-head.mjs` — 78 single-line mutations, one at a time, each followed by the
   full eight-suite run; file restored from `p1head` after every mutation.
3. `~/scratch/mutate2-head.mjs` — 7 corrected/re-run mutations (patterns that did not match,
   or that needed a clean temp dir).
4. `~/scratch/p1mut-head/src/server/control/probe.test.ts` — 9 probes for the "missing cases"
   list, asserting the behavior the suite does **not** pin.

Result: **51 killed, 26 survived, 1 pattern miss** in round 1; round 2 (7 corrected/re-run
mutations) **3 killed, 4 survived**. The survivors are the useful output, plus three probes that
expose real behavior.

---

## Verdict

The suite is good on the happy paths of the new P1 surface: capability scope matching (including
the `ws1`/`ws10` and `/repo/app`/`/repo/application` boundaries), expiry *in the store*, replay
TTL, hook-file permissions on a clean machine, and the hook-shell quoting are all genuinely
killed by mutations. It is weak in four places: **boundaries are tested one side only**, the
**fixed-tempdir fixture makes file-mode tests pass on the second run**, several **source-text
greps cannot see a disabled dispatch**, and the **token-at-rest test does not look at the map that
stores the token**. Two real defects were also found that no test covers: a `requestId` collision
across verbs, and unauthenticated requests getting validation errors (400) before authentication
(401).

Priority order for fixes: P0 token-at-rest assertion (C9), P0 cross-verb `requestId` semantics,
P1 wiring integration test (W1/W2/W3), P1 tempdir isolation (H5), then the boundary assertions.

---

## 1. Surviving mutations — suite by suite

Every row is a mutation that leaves the eight suites green today.

### capabilities.test.ts

| # | Mutation that survives | Why the suite misses it | Assertion to add |
|---|---|---|---|
| C9 | `records.set(sha256(token), …)` + `verify/revoke` lookup rewritten to use the **raw token** as the map key | `capabilities.test.ts:40` "does not store the raw token" only does `JSON.stringify(store.verify(token))`. The record object never contained the token, so hashing the key is unobservable. | Reach the map explicitly: `const map = (store as unknown as { records: Map<string, unknown> }).records`; assert `[...map.keys()]` equals `[createHash('sha256').update(token).digest('hex')]` and does not contain `token`. This is the single highest-value gap in the file. |

Note: C12/C13/C10 etc. are killed; expiry, sweep, prefix matching, `*`, qualifier and clamp all
hold. The store's behavioral surface is well covered **except** at-rest representation.

### controlApi.test.ts

| # | Mutation that survives | Why | Assertion to add |
|---|---|---|---|
| A1/A2 | `REQUEST_ID_MAX 128→129`, `REQUEST_ID_MIN 8→7` | Only `'short'` (5 chars) is rejected (`controlApi.test.ts:174`). `'req-0001'` is exactly 8, so lowering MIN to 7 changes nothing tested. | Table test: `'r'.repeat(7)`→400, `'r'.repeat(8)`→201, `'r'.repeat(128)`→201, `'r'.repeat(129)`→400. |
| A3 | `text.length > MAX` → `>=` | Only 32 769 and 'hello' are sent (`:230`). | `'x'.repeat(32_768)` must be 200, `+1` must be 413. |
| A4 | `timeoutMs > WAIT_MAX_MS` → `>=` | Only 25 001 is rejected. | `timeoutMs: 25_000` must be accepted (probe 6 confirms current behavior); 25 001 stays 400. |
| A5 | idle detection collapsed to "a second poll happened" (`previous !== undefined`) | The idle test keeps the buffer constant, so both implementations return `idle`. | Change output between polls (`sleep` hook writes a chunk after the first poll) and assert **timeout**, not idle. |
| A6 | `nodes` route stops rejecting `workspace:`/`project:` grants | No test asks `/nodes` with a non-`node:` `node.read` grant. | `node.read` on `workspace:ws1` and `project:p1` → 403; only `node:*`/`*` answer 200. |
| A13 | `positiveInt(cols, 500)` → `501` | Only `cols: 0` is rejected. | `cols: 500`→201, `cols: 501`→400 (same for `rows`). |
| A15 | `headerValue` starts accepting array headers | No test sends a repeated `x-webterm-capability`. `headerValue`'s contract ("header ganda dianggap tidak ada") is untested. | Call with `{ 'x-webterm-capability': ['wcap_a', 'wcap_b'] }` → 401, plus `['wcap_good']` → 401 (single value only). |

Also uncovered (no mutation needed; probe evidence):

- **Unauthenticated + invalid body**: `spawnRoute` validates `requestId`/`nodeId` **before**
  `authorize`. Probe 9: `POST /spawn {requestId:'bad'}` with no credential → **400**, not 401.
  Concrete assertion: unauthenticated malformed body must be 401 (auth first), or explicitly
  document the ordering and test 400 only with a valid token.
- **`requestId` reuse across verbs** (probe 3): `spawn` with `req-shared-1` → 201; `prompt` with
  the **same** `requestId` and a prompt capability → **201 replay of the spawn body**, and no
  input is written. `AckStore` is keyed by `requestId` alone (`controlTypes.ts:155-176`). Concrete
  assertion: same `requestId` on a different verb must be a fresh operation (or 409), never the
  other verb's response. This is a real idempotency defect, not just a missing test.

### mount.test.ts

| # | Mutation that survives | Why | Assertion to add |
|---|---|---|---|
| M1 | `if (!result) return false` → answer 404 + `handled: true` | No test sends a recognized path with an unsupported method (`DELETE /api/control/nodes`). Router-level test exists, HTTP bridge test does not. | `DELETE /api/control/nodes` → `handled: false`, `res.ended === false` (api.ts must still own the 404/fall-through). |
| M2 | `withBody = method === 'POST'` (PUT body dropped) | No PUT test. | `PUT /api/control/*` with a JSON body must reach the handler (or be explicitly rejected), not read as `{}`. |
| M3 | bad JSON → `return raw` instead of `{}` | Equivalent, because `asObject()` rejects strings. Low value; keep as documentation only. |
| — | **no request body cap** (probe 7) | 2 MiB body with a valid capability → **201**. `readBody` accumulates without limit in both `api.ts:26` and `mount.ts`. | Either add a cap (`Content-Length` + streaming count) and test 413 at the limit, or record the accepted limit as a decision. Today no test and no enforcement. |
| — | malformed JSON only tested for `spawn` | `prompt`/`close`/`wait` share `asObject`, so coverage is adequate by construction, but a table over all four routes is cheap. | Table test: bad JSON → `invalid_request_id` (or `invalid_node_id`) for all routes. |

### agentStatusApi.test.ts

| # | Mutation that survives | Why | Assertion to add |
|---|---|---|---|
| S3 | `raw.length > TRANSCRIPT_PATH_MAX` → `>=` | The oversized case builds a path **longer** than the limit (root + 4096 chars), so both comparisons reject. | Path of exactly `TRANSCRIPT_PATH_MAX` chars inside the root must be accepted; +1 rejected. Note the router's own store-side cap agrees (`<=`), so a boundary test also pins the pair. |
| S5 | `STRICT_HOOK_AUTH` also accepts `'true'` | Env test only covers unset and `'1'` (`:269-281`). | With `WEBTERM_STRICT_HOOK_AUTH='true'` (and `'TRUE'`, `'01'`), `STRICT_HOOK_AUTH` stays `false`; `'1'` is the only truthy spelling. |
| S6 | non-strict store-side cap `&& transcript_path.length <= TRANSCRIPT_PATH_MAX` removed | The static grep in `hooks.test.ts` (`boundsTranscriptPath`) still matches the *strict-side* `raw.length` check, so removing the store-side cap changes no test. | Route test (strict off) with a 4097-char path: `setTranscript` must **not** be called (and `setStatus` may be). |
| W3 | `api.ts` dispatch `if (await agentStatusRoute(...)) return` → `if (false && await …)` (route becomes dead) | `agentStatusApi.test.ts:260-266` and `hooks.test.ts:446-452` only `toContain()` the call text; the mutated line still contains it. | Integration test through the real `route()` (or a factory that builds it without binding a port) asserting `POST /api/agent-status` reaches the hook writer. |
| — | `hookSpecificOutput` 200 path never runs | `deps.workspaceFor` always returns `null` in this file, so the push-context branch is only statically grepped in `hooks.test.ts`. | Provide a workspace stub → 200 with `{ hookSpecificOutput }`, then `nextHookContext` dedup on the second identical event → 204. |
| — | unsafe `?node=` no-op is only statically grepped | `hooks.test.ts` guards the source text; no runtime assertion. | `?node=../evil` with a valid token → 204, and `setStatus`/`setTranscript` not called. |
| — | symlink **inside** the root is never exercised | Only escaping symlinks are tested. | Probe 8 shows current behavior is correct (204 + stored); add the assertion so a stricter future `realpath` change does not silently break legitimate hooks. |

### auth.test.ts

| # | Mutation that survives | Why | Assertion to add |
|---|---|---|---|
| U3 | `if (origin === 'null') return false` deleted | `new URL('null')` throws, and the existing `catch { return false }` rejects it anyway. The dedicated "rejects Origin: null" test therefore passes with or without the line. | Either accept this as redundant defense-in-depth (comment the branch as such) or assert a distinguishable property (e.g. spy that `URL` throws / assert the branch's intent in a unit comment). As written the test cannot detect the regression it claims to guard. |
| W2 | `index.ts` `allowed()` → `return true || authorizeRequest({…})` (gate permanently open) | `auth.test.ts:282-292` only regex-matches `authorizeRequest({`, `isNodeToken: isValidNodeToken`, `pathname: url.pathname`, `if (!allowed(req, url))`. All still present. | Extract the request handler or the argument builder into a non-listening module and integration-test: non-loopback host + no token + hostile origin on `/ws` → 403; with the right root token → 101/upgrade path. At minimum, call `allowed` with a fake `req`/`url` and `TOKEN` set, asserting `false`. |

### hooks.test.ts

| # | Mutation that survives | Why | Assertion to add |
|---|---|---|---|
| H4 | `chmodSync(dir, 0o700)` → `0o755` | No test inspects the `node-settings` directory mode. | `statSync(dirname(headersPath)).mode & 0o777 === 0o700` (skip on win32, mirroring the source). |
| H6 | settings JSON `{ mode: 0o600 }` → `0o644` | No test checks the settings file mode (only the `.headers` file is checked). | `statSync(settingsPath).mode & 0o777 === 0o600`. |
| H5 | `.headers` mode `0o600` → `0o644` | **Environment-dependent**: `hooks.test.ts:10` pins `WEBTERM_DATA_DIR` to a fixed `tmpdir()/webterm-hooks-test` that is never cleaned. On any machine where a previous run created the file, `writeFileSync(..., {mode})` does not change the existing mode, so the test keeps seeing 0600. It only fails after the dir is wiped (verified: wiped → KILLED; warm → SURVIVED). | Use `mkdtempSync` per run (`beforeEach`) or `rmSync` before the suite, and assert the mode of a **freshly created** file. This also removes cross-test contamination of node tokens/settings between runs. |
| — | source-grep route tests (`:383-503`) | Same class as W3: the checks assert text, not behavior, and duplicate what `agentStatusApi.test.ts` covers behaviorally (for the cases it covers). Keep `rejectsUnsafeNode`/`boundsTranscriptPath` only where no runtime test exists, and delete the duplicate. | Replace grep assertions with the runtime tests listed under agentStatusApi. |

### ptyShell.test.ts

| # | Mutation that survives | Why | Assertion to add |
|---|---|---|---|
| P3 | locale guard drops `LC_CTYPE` | `:88-91` asserts `LANG` and `LC_ALL` only. | `expect('LANG' in ptyEnv({ LC_CTYPE: 'C' }, { interactive: true })).toBe(false)`. |

Everything else (`WEBTERM_*` stripping, `BUN_INSTALL`, `fish -l`, `~/x`, shell quoting) is killed.

### sessionsFake.test.ts

| # | Mutation that survives | Why | Assertion to add |
|---|---|---|---|
| T2 | `close()` no longer calls `forgetNodeToken(id)` | No session test asserts that closing forgets the node token or deletes its settings/header files; `hooks.test.ts` tests `forgetNodeToken` directly, not through `Sessions.close`. | After `sessions.close(id)`: `stateVerified(id, nodeTokenBeforeClose)` is `false`, and the `.headers`/settings files are gone. |
| T8 | `isContextCapable(agentId)` gate removed (all agents get `WEBTERM_NODE_ID/PORT`) | Every agent spawn in this file is `claude`, which is context-capable. | Spawn `agentId: 'copilot'` (builtin, **not** in `CONTEXT_LINK_CAPABLE`): assert `WEBTERM_NODE_ID`/`WEBTERM_PORT` absent, `WEBTERM_TOKEN` (node token) still present. |
| T12 | `hasClaudeHookSettings(agentId)` gate removed (all agents get `hookEnv`) | Same reason: only `claude` is exercised, and only `claude` is hook-capable (`CLAUDE_HOOK_SETTINGS_CAPABLE = ['claude']`). | Same `copilot` spawn: assert `NODE_TOKEN_ENV` (`WEBTERM_NODE_TOKEN`) absent. |

Note: `T3` ("close always emits exit" on the subscriber line) survived in round 1 because the
mutated line is dead when the session is already out of `map`; the corrected mutation
(`if (firstClose) send?.(exit)` → unconditional caller exit) **is killed** by
"a later close does not overwrite self". Not a gap — recorded here so the raw log is not
misread.

### Already strong (mutations killed, listed so the gap list is not over-read)

- Capability expiry/revoke/sweep semantics, TTL clamp, prefix boundaries, `*` restriction,
  qualifier matching, unique ids.
- `x-webterm-capability` only (never `x-webterm-token`), root-token mint gate, `cwdAllowed`,
  size/cwd/agent validation, dead-node 404, ack TTL boundary, close idempotency.
- Strict hook auth gate off/on, token mismatch, `..` traversal, symlink escape, `..foo` inside
  root, root swap.
- Hook header file contents (no root token), `isValidNodeToken` map lookup, context-memo sweep,
  `encodeQueryValue`, stderr silencing, argv token absence, shell parse.
- Origin checks (port/host/`null`/malformed/`Sec-Fetch-Site`), token length guard, trimming,
  env write, node-path allowlist, non-loopback refusal.
- Session: tombstone/echo gating, empty chunk, unsafe id, replay, tombstone clearing, root-token
  stripping from child env.

---

## 2. Missing cases from the task list — status

| Requested case | Covered at store level | Covered at route level | Evidence |
|---|---|---|---|
| Token expiry exactly at boundary | Yes (`capabilities.test.ts:73-85`) | **No** (only "expired 10 ms later", `controlApi.test.ts:98-101`) | Probe 2: route returns 401 at `now === expiresAt`; behavior correct, test absent. |
| Revoked token | Yes (`:193-201`) | **No** | Probe 1 passes (401); no refusal test at the API. |
| Resource boundary `ws1`/`ws10`, `/repo/app`/`/repo/application` | Yes, and mutations killed | n/a | Strong. |
| `requestId` reuse across verbs | — | **No, and currently wrong** | Probe 3: `prompt` with a `spawn` requestId returns the spawn's 201 and writes nothing. |
| Body > limit | — | **No limit implemented** | Probe 7: 2 MiB → 201. |
| Malformed JSON | — | Yes for `spawn` (`mount.test.ts:129`) | Shared `asObject` covers the rest, but a 4-route table is cheap. |
| Node token on `/api/settings` | n/a | Yes (`auth.test.ts:238-250`, mutation U9 killed) | Strong. |
| Strict transcript symlink | Escape: yes (killed) | Inside root: **no test** | Probe 8 passes (204 + stored); add it. |
| Root token env leakage | Yes (`sessionsFake.test.ts:467-538`, P1/T7 killed) | n/a | Strong. |
| Auth before validation ordering | — | **No** | Probe 9: 400 instead of 401 without credentials. |

---

## 3. Tests that assert implementation instead of behavior

1. **`hooks.test.ts:383-503`** — reads `agentStatusApi.ts`/`api.ts` and regex-matches code.
   Mutations W3 (dead `agentStatusRoute` dispatch) and partially W1 survive. Useful as a
   "shape" guard, harmful as the only guard for wiring; it also duplicates runtime assertions.
2. **`agentStatusApi.test.ts:260-266`** — `toContain("path === '/api/context-link'")` and
   `toContain('await agentStatusRoute(req, res, url)')`. Same weakness.
3. **`auth.test.ts:134-140, 282-292`** — `index.ts` wiring by regex. Mutation W2 (gate always
   true) survives, i.e. the test cannot detect the most dangerous possible regression in the
   file it "verifies".
4. **`capabilities.test.ts:40-45`** — asserts the returned record has no token field; the map
   key (the actual at-rest representation) is untested (C9).
5. **`auth.test.ts:52-54`** — `Origin: null` assertion passes even if the explicit branch is
   deleted (malformed-URL catch rejects it). Test and line are redundant with each other.
6. **`hooks.test.ts` fixture** — fixed `tmpdir()/webterm-hooks-test` with no cleanup means the
   mode tests assert leftover state from a previous run, not the code under test (H5).

---

## 4. Concrete reproductions

Pinned HEAD copy, all under `$JCODE_SCRATCH_DIR` (nothing in the repo):

```
~/scratch/p1head/           git archive HEAD (2872190)
~/scratch/p1mut-head/       mutation sandbox (same tree + node_modules symlink)
~/scratch/mutate-head.mjs   78 mutations; log: ~/scratch/mutate-head.log
~/scratch/mutate2-head.mjs  7 corrected mutations; log: ~/scratch/mutate2-head.log
~/scratch/p1mut-head/src/server/control/probe.test.ts  9 probes
```

Probe results (expected-vs-actual, from the run):

```
✓ 1 revoked token rejected (401)
✓ 2 expiry exactly at boundary rejected (401)
× 3 same requestId on another verb → got 201 (spawn replay), expected 200 prompt
✓ 4 requestId length 129 rejected
✓ 5 prompt text exactly 32768 accepted
✓ 6 timeoutMs exactly 25000 accepted
× 7 2 MiB body → 201 (no cap), expected 413
✓ 8 symlink inside transcript root accepted
× 9 unauthenticated invalid body → 400, expected 401
```

Mutation highlights (survivors, round 1 + round 2):

```
C9   raw token as map key + lookup .............. SURVIVED
A1   REQUEST_ID_MAX 128 → 129 ................... SURVIVED
A2   REQUEST_ID_MIN 8 → 7 ....................... SURVIVED
A3   prompt 32768 boundary exclusive ............ SURVIVED
A4   wait timeout 25000 boundary exclusive ...... SURVIVED
A5   idle = "second poll" ....................... SURVIVED
A6   /nodes answers workspace grant ............. SURVIVED
A13  spawn size cap 500 → 501 ................... SURVIVED
A15  duplicate headers accepted ................. SURVIVED
M1   unknown method answered 404 ................ SURVIVED
M2   PUT body dropped ........................... SURVIVED
S3   transcript max exclusive ................... SURVIVED
S5   STRICT also accepts "true" ................. SURVIVED
S6   store-side transcript cap removed .......... SURVIVED
H4   node-settings dir 0755 ..................... SURVIVED
H5   header file 0644 (warm tmpdir) ............. SURVIVED / for a clean dir: KILLED
H6   settings json 0644 ......................... SURVIVED
U3   Origin:null branch removed ................. SURVIVED
P3   LC_CTYPE ignored ........................... SURVIVED
T2   close forgets no token ..................... SURVIVED
T8   WEBTERM identity for every agent .......... SURVIVED
T12  hookEnv for every agent .................... SURVIVED
W1   control dispatch dead (grep intact) ........ SURVIVED
W2   index allowed() always true (grep intact) .. SURVIVED
W3   agent-status dispatch dead (grep intact) ... SURVIVED
```

---

## 5. Recommended fixes, in order

1. **P0 — C9**: assert the map key is the sha256 of the token (private-field access in the test).
   Token-at-rest is a security claim; it is currently unverified.
2. **P0 — cross-verb `requestId`**: decide the contract (key by `path + requestId`, or reject a
   reused id with a different verb) and add the two-verb test. Probe 3 currently returns a
   wrong-verb 201 body.
3. **P1 — wiring**: one real integration test for `api.ts`/`index.ts` (handler factory or a
   listening server on an ephemeral port). Delete the source-text greps once it exists; W1/W2/W3
   are exactly the regressions a test suite must not miss.
4. **P1 — tempdir isolation** in `hooks.test.ts` (`mkdtemp` per run) and per-suite cleanup; then
   assert directory 0700, settings 0600, headers 0600 on freshly created files.
5. **P2 — boundaries**: requestId 7/8/128/129, prompt 32768/32769, timeout 25000/25001,
   cols/rows 500/501, transcript-path max exactly / +1, duplicate header arrays, `LC_CTYPE`.
6. **P2 — route-level security cases**: unauthenticated+invalid body → 401 (or documented 400),
   revoked/expired-at-boundary tokens at the API, `/nodes` with workspace/project grants,
   non-context agent (`copilot`) receiving no WEBTERM identity/hook token, `close()` forgetting
   the node token and files.
7. **P3 — body limit**: add a request-size cap (or record the decision); today a 2 MiB JSON body
   is parsed and accepted.
8. **P3 — probes worth promoting as-is**: symlink inside root accepted; idle must require an
   unchanged buffer; `hookSpecificOutput` 200 path with a workspace stub.

---

## 6. Disclaimer

Findings are from static review plus the mutation/probe runs above. A mutation that survives shows
the suite does not pin that line; it does not by itself prove a production bug (only the three
probes marked `×` demonstrate observable wrong behavior: cross-verb replay, no body cap,
validation-before-auth). Runtime edge cases outside the exercised paths (real PTY, real HTTP
socket, browser Origin handling) are not covered by this report.
