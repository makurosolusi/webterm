# QC review — P0 security surface (node id, hook builder, session/API boundaries)

Branch `feature/agent-pusat-p0` @ `b4e7f01`. Read-only review: no production or test file was
modified; only this report was written.

Scope: `src/shared/workspace.ts` (`isSafeNodeId`, `SAFE_NODE_ID`), `src/server/sessions.ts`
(`open`/`handle` boundary), `src/server/hooks.ts` (`encodeQueryValue`, `shq`,
`claudeHooksSettings`, `writeClaudeSettings`, `buildClaudeFlags`), `src/server/launchLine.ts`,
`src/server/api.ts` (node-param routes), `src/server/contextLink.ts` + `transcriptPresence.ts`
(path use of ids), `src/client/ws.ts` + `terminalSession.ts` (id flow to the wire).

Probes (outside the repo, nothing written inside it):
`~/.jcode/scratch/probe.ts` (validator payload matrix), `probe2.ts` (`Sessions` with injected fake
PTY), `probe3.ts` (hook command executed by real `sh`, argv captured via a stub `curl`),
`probe4.ts` (prototype-key lookup), `probe5.ts` (live `ps` while a hook runs).

Verification run: `npx vitest run` → 77 files / 1041 tests pass.
`npx vitest run src/shared/workspace.test.ts src/server/hooks.test.ts
src/server/sessionsFake.test.ts` → 81 pass (see Observation 1 for one transient failure on the
first invocation of that command).

---

## Verdict

The node-id path itself holds: **no payload in the requested classes reaches a shell.** Two
medium findings sit next to it — one contradicts a security claim the code makes about itself
(B1), the other is a boundary the validator is not applied to (B2). Neither is remote
unauthenticated RCE; both are reachable by anything already inside the token/loopback trust
boundary, i.e. a spawned agent.

---

## B1 — BLOCKER (Medium): the hook tokens are exposed in the process table, contrary to the comment

`hooks.ts:176-181` builds

```
curl -s '<url>' -H "x-webterm-node-token: $WEBTERM_NODE_TOKEN" -H "x-webterm-token: $WEBTERM_TOKEN" --data-binary @-
```

and the doc block above it (`hooks.ts:140-155`) states the value "tidak boleh mendarat di baris
perintah: di sana ia terbaca semua proses pengguna lewat `ps`" and, for the transport token,
"nilainya tidak pernah muncul di `ps`". That is false: the **shell expands both variables before
`exec`**, so the real values land in curl's argv.

Evidence (`probe5.ts`, stub `curl` that sleeps 3 s, `ps -axo pid,args` during the run):

```
27459 /bin/sh .../curl -s http://127.0.0.1:8700/api/agent-status?node=n1 \
  -H x-webterm-node-token: NODE-TOKEN-abc \
  -H x-webterm-token: SUPER-SECRET-TRANSPORT-TOKEN-123456 --data-binary @-
```

`WEBTERM_TOKEN` is the transport token that gates `/api/*` **and** the WS upgrade, i.e. a full
PTY. macOS lets any local user read other users' `ps` args, so on a shared host this is
cross-user escalation to a shell as the webterm user, not just same-user information disclosure.
Window per hook is short (~one curl round trip) but hooks fire on every event, and a polling
`while :; do ps ...; done` wins reliably.

Impact: any local process (multi-user host: any other user) that samples `ps` during a hook
obtains a token that spawns a PTY. The design goal of the `$VAR` reference (keep secrets out of
argv) is met for the *agent* launch line, not for the hook invocation.

Not a false alarm about intent: `hooks.ts:151-157` reasons carefully about *why* the header must
be emitted unconditionally, and the intent is clearly "the value never reaches argv". The
mechanism does not deliver that.

Directions (not implemented, review only): give curl its headers from a source that is not argv
(`-H @file` with a 0600 file, `--config` fed on a fd, or move the body to a file so stdin is free
for `--config -`); or drop the env indirection and write the header file next to the settings
file that is already written 0600. Either way update the comment, because a security claim that
is wrong is worse than no claim — the next reviewer will trust it.

Suggested regression test: run the built command under a real `sh` with a stub `curl` that dumps
its argv, then assert the token literal does not appear in argv.

## B2 — BLOCKER (Medium): `/api/agent-status` accepts any `node` value; statuses/transcripts are uncapped

`sessions.open` validates at the WS boundary, and `workspace.ts:265-279` documents the id as
"validated at the boundary and again at the interpolation point". The third boundary — the HTTP
hook callback that also writes per-node state — never calls `isSafeNodeId`:

- `api.ts:79-88`: `node = url.searchParams.get('node')` → `sessions.setStatus(node, status)` and
  `sessions.setTranscript(node, body.transcript_path)` for **any** string, including `''`,
  newlines, quotes, 10 kB values.
- `contextLink.ts:166-168` then `readFileSync(path)` on whatever `transcript_path` was posted.
- `nodeRegistry.ts:33-36`: `statuses` / `transcripts` are `Map`s with **no cap** (`exits` is
  capped at `EXIT_TOMBSTONE_LIMIT = 256`, statuses/transcripts are not — already noted as L3 in
  `RND/qc/session-review.md`, this is the remotely-drivable version of it).

Consequences inside the trust boundary: unbounded memory growth (a loop of distinct `node=`
values, each with a `transcript_path`, is never reclaimed — only `open`/`close` of that exact id
frees it); arbitrary status forgery for any node id (a node can be pinned `working`/`done`, which
gates Resume); and an agent can point its own transcript at any readable file and have
`/api/context-link?verb=transcript` read it back. The last one is near-worthless on its own (an
agent has a shell), but it defeats the "context link only reads a peer's conversation" intent.

Reachability is gated by `authorize` (`auth.ts:110-118`): `sameOrigin` blocks browser CSRF, and a
token is required off-loopback. So this is not unauthenticated, but the token is held by every
spawned agent — the same population that can already run commands. Rated Medium, not High,
because the worst outcome (shell) is already available to the actor.

Suggested fix + test: `if (!isSafeNodeId(node)) return 204` in the handler (and same for
`/api/context-link`, `/api/generate-name`), plus a cap on `statuses`/`transcripts` keyed the same
way `exits` is. Test: POST with `node=../../etc/passwd` → 204, `statusOf(...)` undefined.

## L1 — LOW: the node-id contract comment claims a second validation that does not exist, and the regex accepts a leading `-`

Two separate small gaps in the same contract, both `workspace.ts:275-279`:

1. `isSafeNodeId`'s docstring says it is "Dipanggil di batas WebSocket (`Sessions.open`) dan lagi
   di titik interpolasi (hooks.ts)". It is **not** called in `hooks.ts`: that file imports only
   `isPermissionMode` from `shared/workspace` (`hooks.ts:4`), and the second layer there is
   quoting/encoding, not validation (`hooks.ts:167-175` even says so: "di sini pertahanannya
   quoting"). The docstring is wrong in the direction that matters — it makes the codebase look
   like it has a defence in depth it does not have. Fix the comment (quoting *is* the second
   layer, and `probe3.ts` shows it holds) or add the actual call.
2. The regex `/^[A-Za-z0-9_-]{1,64}$/` allows `-` in the first position: `probe.ts` gives
   `isSafeNodeId('-x') === true`, `isSafeNodeId('--help') === true`, and `probe2.ts` shows
   `open({id:'-x'})` spawning a PTY. Compare `SAFE_SESSION_ID`
   (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/`), which deliberately requires an alphanumeric first
   character and whose comment names `-x` as the rejected shape — so the intent exists in the
   sibling validator and was not carried over.

No exploit is reachable today: the node id never becomes an argv element (the claude settings path
is `sha256(id).slice(0,16)`, `hooks.ts:195-199`; the id only reaches `WEBTERM_NODE_ID`, map keys,
and a percent-encoded query value). It stays Low until something turns an id into a flag or a
filename. Suggest tightening to `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` and adding `-x`, `--help`,
`--` to the test matrix in `workspace.test.ts:281-300`.

## L2 — LOW: `close`/`input`/`resize` skip the boundary check

`handle()` (`sessions.ts:281-288`) validates nothing; only `open` does. `close(id)` reaches
`forgetNodeToken` → `rmSync(sha256-hashed path)` (safe) **and** `registry.setExit(id)` for any
string (`probe2.ts`: `close('../../evil')` → `getExit('../../evil')` = `{code:-1, reason:'closed'}`),
so arbitrary ids create tombstones (bounded at 256, so not a growth vector) and a peer's PTY can
be killed by id. Killing a known node id is by design for multi-attach clients, so the practical
hole is only the missing symmetry. Cheap fix: run the same `isSafeNodeId` guard at the top of
`handle`, so all four verbs share one gate.

## L3 — LOW: unguarded prototype-key lookups in `agentConfig` / `isBuiltinAgent`

`AGENT_CONFIG as Record<string, AgentConfig>[id]` (`workspace.ts:85-87`) is a plain-object
lookup, so `agentConfig('__proto__' | 'constructor' | 'toString' | 'hasOwnProperty')` returns a
truthy non-config, `isBuiltinAgent(...)` returns `true`, and `agentConfig(id).launchCmd` is
`undefined` (`probe4.ts`). Current blast radius is cosmetic (`AgentNode.tsx:80-90` renders an
undefined label/colour; `baseAgentOf` refuses inheritance for a custom agent so named). Note the
one dangerous shape: if a future caller does `assembleCmd(agentConfig(id))`-style lookups or
`AGENT_CONFIG[id].launchCmd` with an untrusted id, the command becomes the literal string
"undefined" in a shell. Suggest `Object.hasOwn(AGENT_CONFIG, id)` inside `agentConfig`.

---

## Checked and clean (with evidence)

- **Validator, full payload matrix** (`probe.ts`, 37 cases): rejects `'`, `"`, `$()`, backtick,
  `\n`, trailing `\n`, `\r`, tab, NUL, space, `&`, `=`, `;`, `|`, `#`, `%`, glob `*?{}`, `~`,
  `\`, `../`, `..`, dotfiles, `é`, RTL override, NBSP, fullwidth, 65-char, and every non-string
  (`null`, `42`, `[]`, `{}`). `$` does **not** match before a trailing newline in JS, so
  `'ab\n'` is rejected (this is the classic `$`-vs-`\z` trap; not present here). Accepts UUIDs,
  `[A-Za-z0-9_-]{1,64}`, boundary 64 exact.
- **Invalid ids cannot spawn or create state** (`probe2.ts`, `Sessions` with injected fake PTY):
  10 hostile `open`s (`'`, `$()`, backtick, newline, `&x=`, `;`, `../`, space, `-x`, `''`) →
  0 spawns except `-x` (L1), `isLive` false, `statusOf` undefined, no map/registry entry. Legit
  id spawns normally. Ordering is right: the guard is the first statement of `open`
  (`sessions.ts:139`), before `resumeIsDead`, `hookEnv`, `spawn`.
- **Hook command stays valid shell** (`probe3.ts`, 15 hostile ids incl. `n1'; touch /tmp/pwn; '`,
  `n1$(id)`, `n1\n-H x: y`, `--help`, 64 chars, trailing backslash): `sh -n` OK for all; argv from
  a stub `curl` is always exactly 8 elements, exactly **one** `http://` argument, and
  `new URL(arg).searchParams.get('node')` round-trips the original id byte-for-byte. No payload
  fragment (`rm`, `-rf`, `whoami`, `-H x-evil`) appears as its own argv element, so `shq` +
  `encodeQueryValue` double layer holds even for ids the validator would reject.
- **`sessionId` is validated before both uses**: `launchLine.ts:53` (`isSafeSessionId(sid, true)`
  before any flag is emitted) and `transcriptPresence.ts:98` (before `<sid>.jsonl` is joined to a
  path). `buildClaudeFlags` itself does interpolate `sessionId` unvalidated
  (`hooks.ts:270`), but its only production caller is `launchLine` behind that guard — noted, not
  a finding.
- **Settings file path is hashed**, 0600, removed on `close` (`hooks.ts:195-220`); id reuse cannot
  make two nodes share a file except by a 64-bit hash collision on a 16-hex prefix (not
  attacker-usable: it needs control of both ids).
- **`port`** is `Number(env.PORT) || 8700` (`serverConfig.ts`) everywhere it is interpolated
  unquoted into the URL, and `launchLine` passes the module constant — no string reaches
  `http://127.0.0.1:${port}` from the wire.
- **Client surface** (`ws.ts:100-150`, `api.ts:145`): node ids are generated by `randomId()` and
  only ever used as JSON map keys or through `encodeURIComponent`; `replayOpen` gates `resume` on
  `canResumeWith` (which validates). No template interpolation of an id into a URL, selector, or
  path found in the client.

## Residual risks (not fixed by this review, mostly pre-existing)

1. **DNS rebinding defeats `sameOrigin`.** `auth.ts:88-108` compares `Origin.host` with the
   request `Host`; under rebinding both name the attacker's domain, so both agree. With the
   default loopback-no-token config, a page served from `evil.tld` that re-resolves to
   `127.0.0.1` gets a WS shell. Pre-existing and broader than this diff, but it is the actual
   control protecting `/ws` in the default posture, so it belongs on the record.
2. **PTY control == RCE by design.** `msg.cmd` from the client is executed by the login shell
   (`pty.ts:161-181`). Node-id validation is therefore not a privilege boundary; the token (or
   loopback) is. Any review that treats "safe node id" as an injection defence should say so
   explicitly.
3. **`transcript_path` is an arbitrary file read** for a linked peer (B2). An allowlist of
   `~/.claude/projects/**` would remove the odd affordance cheaply.
4. **Trust in the persisted workspace** (`db.ts` JSON blob, `nodeRegistry`): node ids loaded from
   disk are not re-validated, so a hand-edited/corrupted board can pin ids the validator would
   reject. Their only effect is a silent no-spawn plus registry entries keyed by them (B2's
   unbounded map, reachable via the API alone).
5. **Token hygiene** beyond argv: `writeTokenToEnv` (`auth.ts:71-77`) puts `WEBTERM_TOKEN` into
   the env of every child (`pty.ts:181`, whole env inherited), so every agent and every process it
   spawns can read it. Deliberate (the hook needs it), but it makes B1 the *last* place the token
   is exposed, not the only one.

## Observation 1 — one transient test failure, not reproducible

On the first invocation, `npx vitest run src/shared/workspace.test.ts src/server/hooks.test.ts
src/server/sessionsFake.test.ts` failed
`sessionsFake.test.ts:158` — `P0: a subscriber that detaches its peer mid-delivery does not
starve it` (`expected 'first' to be 'first'` / received `'firstsecond'`, i.e. the detached peer
received the second broadcast). `SubscriberSet.send` snapshots via `Array.from`, which makes that
outcome unreachable by construction, and 5 subsequent runs (alone and in the same 3-file
combination) plus the full 1041-test suite all passed. Recording it rather than dismissing it:
if it recurs, the suspect is not this diff's logic but test isolation/ordering. No action taken
(tests are out of scope for this review).

## Test blind spots worth closing (security-relevant)

- `workspace.test.ts:281-300` covers `'`, `"`, `$()`, backtick, `\n`, space, `;`, `&&`, `|`,
  `&x=1`, 65 chars, non-strings — but not `-x`/`--help` (L1), `\r\n`, NUL, or `../`.
- Nothing pins the claim in `isSafeNodeId`'s docstring that validation also happens at the hook
  interpolation point (L1.1); a test that greps `hooks.ts` for the import, or that adds the call,
  would keep comment and code from drifting apart again.
- `hooks.test.ts:189-230` is the strongest security test in the repo (real `sh -n` + argv scan);
  it does not assert that the expanded token never appears in argv (B1), which is precisely the
  assumption the comment relies on.
- No test asserts `/api/agent-status` rejects an unsafe `node` (B2), and none asserts
  `statuses`/`transcripts` are capped.

Cross-user visibility spot-check on this host (non-root): `ps -axo user,pid,args` lists root and
`_*`-user processes with full arguments, so B1's exposure is not limited to the same user.
