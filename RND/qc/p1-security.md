# QC review — P1 security invariants (capabilities, node tokens, control API)

Branch `feature/agent-pusat-p1` @ `2872190` (+ clean working tree, no uncommitted edits).
Commits reviewed: `999a920` (capability-scoped control API) and `2872190` (node-scoped
transport tokens).

Read-only review: no source, test, or config was modified. Only this report was written.
Probe scripts live outside the repo (`$JCODE_SCRATCH_DIR/qc/trace*.ts`, i.e.
`~/.jcode/scratch/qc/`).

Verification run:

```
npx vitest run src/server/control src/server/auth.test.ts src/server/agentStatusApi.test.ts \
  src/server/hooks.test.ts src/server/sessionsFake.test.ts src/server/ptyShell.test.ts
# 8 files / 198 tests, all pass
```

Probes (`bun ~/.jcode/scratch/qc/trace.ts`, `trace2.ts`, `trace3.ts`, `trace4.ts`) exercise the
real `authorizeRequest`, `CapabilityStore`/`allows`, `AckStore`, `handleControl`, and
`installContextLink` — no mocks of the units under review.

---

## Verdict

The *transport* scoping is sound: a node token reaches exactly the three allowlisted path
families and nothing else (Q1), it cannot mint (Q3), and it never equals or derives from the root
token (Q2). Capability verbs/resources also do not escalate across nodes or verbs (Q3).

But the P1 threat model — "a PTY child holds only a node token, so it can never act with root
authority" — **does not hold** because of two independent leaks:

* **C1 (Critical): the root token is written in cleartext to a file every agent can read.**
  `installContextLink(TOKEN)` bakes `WEBTERM_TOKEN` (the root token) into
  `<dataDir>/context-links/context.sh`. Any PTY child runs as the same UID and reads it. The
  allowlist in `auth.ts` is therefore decorative.
* **H1 (High): node identity is never bound to the token.** `isValidNodeToken` accepts *any*
  live node token on the allowlisted paths, and `/api/context-link` takes the requester's
  identity from a client-supplied `?node=`. Any agent can therefore act as any node
  (read a non-linked peer's link graph, read its peers' terminals/transcripts, and — with
  hook auth off, the default — rewrite any node's status/transcript).

Plus one high-impact correctness/security-adjacent bug: **the idempotency store never persists in
production** (M2), so the advertised 10-minute replay window does not exist outside tests.

Severity | ID | One-liner
--- | --- | ---
Critical | C1 | Root token persisted to a same-UID-readable file (`context.sh`)
High | H1 | Node token is not bound to a node id; context-link identity is a query param
Medium-High | H2 | Transcript path validated at write, read later: symlink swap ⇒ arbitrary read / blocking DoS
Medium | M1 | `'*'` capability ignores `agentIds`/`cwdPrefix` qualifiers
Medium | M2 | AckStore is per-request in prod ⇒ idempotency does not exist; shared-key design is cross-verb-replayable
Medium | M3 | Capability qualifiers are unenforceable on every HTTP route
Medium | M4 | `node.wait` grant ⇒ full terminal-buffer read; `node.read` has no route
Low | H3 | Strict hook auth off by default and frozen at module load
Low | M5 | Root-token comparison in mint route is not constant-time
Low | M6 | `cwdAllowed = isAbsolute` ⇒ a `node.spawn` grant can launch an agent anywhere
Low | L1-L4 | query-string node token, linear token scan, no capability sweep, unbounded waits

---

## Q1 — Can a PTY child reach beyond `/api/agent-status`, `/api/context-link`, `/api/control/*`?

**No bypass found.** Traced with the real gate (`authorizeRequest` + `isNodeTokenPath`), with
`pathname` taken from a real WHATWG `URL` exactly as `index.ts:26-28` does:

```
/api/agent-status             gate=true   allowlist=true
/api/context-link             gate=true   allowlist=true
/api/control/spawn|token|...  gate=true   allowlist=true
/api/settings                 gate=false
/api/workspaces               gate=false
/api/fs/read                  gate=false
/api/generate-name            gate=false
/ws                           gate=false
/api/control                  gate=false   (exact prefix, no trailing slash)
/api/agent-status/extra       gate=false
```

Traversal spellings are normalised by `new URL()` before the allowlist sees them, and the inner
routers parse the same normalised pathname, so gate and router cannot disagree:

```
/api/control/../settings      -> URL pathname /api/settings            (gate false)
/api/control/%2e%2e/settings  -> /api/settings                          (gate false)
/api/control/%2E%2E/settings  -> /api/settings                          (gate false)
/api/control/..%2fsettings    -> /api/control/..%2fsettings             (gate true, router 404)
/api/control\..\settings      -> /api/settings                          (gate false)
```

Residual design risk (L-risk, not a bug today): `isNodeTokenPath` is a *prefix* allowlist over a
namespace designed for agents (`/api/control/`). Any P2 route added there inherits node-token
reachability automatically, even if it is not capability-checked. Keep it exact-per-route and add
an assertion that every `/api/control/*` route except `/token` calls `authorize()`.

Note also that `/api/control/token` is transport-reachable with a node token but returns 403
(root comparison, verified in trace4) and 404 when minting is disabled — see Q3.

## Q2 — Root token: equality/derivation, argv, settings, logs, disk

Node token = `randomUUID()` (`hooks.ts:79-86`), minted per node id; it is independent of, and
never derived from, `WEBTERM_TOKEN`. Good:

* **argv** — hooks now use `curl -H @<headers file>` (`hooks.ts:196`); the value never lands in a
  command line. The P0 finding (B1) is fixed and the test drives a real `curl` argv to prove it.
* **settings JSON** — no token (`hooks.ts:184-206`, `writeClaudeSettings` at 229-237).
* **agent env** — `ptyShell.ts:74` now strips `WEBTERM_*`/`NODETERM_*` and `sessions.ts:181-189`
  re-injects the *node* token, so an agent no longer inherits the root token.
* **logs** — `index.ts:127-130` prints only `len=N`; `api.ts:142` logs method + pathname only.
* **disk mode** — `node-settings` dir 0700 (`hooks.ts:240-247`), headers file 0600
  (`hooks.ts:255-263`).

But: **the root token is on disk anyway** — see C1. And per-node 0600 does not isolate siblings
(any agent is the same UID and can read every `*.headers`), which is why H1's fix cannot rely on
token secrecy. Minor: `NODETERM_NODE_TOKEN`/`WEBTERM_TOKEN` remain readable via
`ps -E` / `/proc/<pid>/environ` to the same UID (L3-adjacent), so treat node tokens as
"same-user public".

## Q3 — Minting and capability escalation

* Node token as `x-webterm-capability` → `401 unauthorized`; node token as `x-webterm-token` on
  `POST /api/control/token` → `403 forbidden`; root token → `201` (trace4). **No mint by a node
  token.** The route is also 404 unless `WEBTERM_ALLOW_TOKEN_MINT=1` **and** `WEBTERM_TOKEN` is
  set (`controlApi.ts:249-254`), and it fails closed if `rootToken` is undefined.
* Verb escalation: a `node.spawn` grant on `node:n1` does **not** spawn/prompt/close `node:n2`
  and does not prompt/read n1 either (`allows` requires exact verb, `capabilities.ts:143`).
  Verified in trace.
* Cross-scope: `resourceMatches` prefix expansion (`capabilities.ts:103-108`) only fires for
  `workspace:`/`project:` grants, and **no route ever requests a composite resource**. Product
  effect: `workspace:`/`project:` grants are inert (deny everything), not escalatory — but the
  resource grammar suggests a scoping feature that does not exist. Either implement composite
  resources in `spawnRoute`/`nodesRoute` or drop the grammar.
* Real escalation present: `'*'` ignores qualifiers (M1) and `node.wait` reads the terminal
  buffer (M4).

## Q4 — Idempotency / requestId replay

Two separate facts:

1. **In production there is no idempotency at all.** `storeFor(deps)` keys a `WeakMap` by the
   `deps` object (`controlApi.ts:39-48`), but `mount.ts:93-95` builds a *fresh object literal on
   every request* (`{ ...(await resolveDefaultDeps()), ...overrides }`). Every request therefore
   gets a new `AckStore`, and `acks.get()` is always empty. The tests pass only because
   `mount.test.ts` injects the same `deps` reference repeatedly. Consequence: a retried
   `POST /prompt` after a client timeout writes the text **twice** (duplicate instructions to a
   live agent), and the 10-minute window documented at `controlTypes.ts:84-85` is false.
2. **If the store were shared**, its key is `requestId` only (`controlApi.ts:89,125,148`), so a
   response cached for `prompt nodeA` replays verbatim for `close nodeB` with the same id, and
   any single capability can evict the 1000-entry store (`controlTypes.ts:144-153`) to disable
   replay protection for other callers. Verified in trace:
   `same id different verb/resource -> {"status":201,...,"nodeId":"nodeA"}` and
   `victim ack after 1000 flooding sets: undefined`.

Fix both together: memoise the composed deps object (stable store), key acks by
`verb:resource:requestId` (or hash of the whole body), and cap per-capability entries rather than
globally.

## Q5 — Strict hook auth: path escape, symlink, TOCTOU, env-at-load

* **Path validation itself is solid** (`agentStatusApi.ts:106-120`): rejects relative paths, `..`
  segments, `\0`, and escapes through symlinks at validate time (via `realpathLoose`). Tests cover
  each. Note `dataDir()` is accepted as a root, which also admits
  `<dataDir>/node-settings/<hash>.headers` (other nodes' tokens) and `webterm.db`; harmless only
  because the transcript renderer drops non-JSONL lines.
* **H2 — deterministic TOCTOU, not a race.** The path is validated when the hook POSTs
  (`agentStatusApi.ts:169-174`) but the *unresolved* string is stored and `readFileSync` runs
  later in another request (`contextLink.ts:166-171`). Replace-after-validate is trivial because
  the writing agent owns the file:

  ```sh
  mkdir -p ~/.claude/projects/x
  echo '{"type":"user","message":{"content":"hi"}}' > ~/.claude/projects/x/t.jsonl
  # POST it as transcript_path (passes strict validation) ...
  rm ~/.claude/projects/x/t.jsonl
  ln -s /dev/zero ~/.claude/projects/x/t.jsonl    # or a JSONL-shaped secret file
  # a linked peer now reads: readFileSync follows the symlink
  ```
  `/dev/zero` makes `readFileSync` block the whole event loop (server hang / OOM). The same shape
  applies in non-strict mode with no swap at all (`transcript_path=/dev/zero` is stored verbatim).
* **H3 — strict auth is off by default and cannot be toggled at runtime.** `STRICT_HOOK_AUTH` is
  read once at module load (`agentStatusApi.ts:31`). That is documented, but it means the default
  deployment has *no* transcript validation and *no* hook identity check, while the module comment
  presents strict as the hardening. At minimum log a one-line warning at boot when it is off and a
  token is enforced.

## Q6 — `cwdAllowed` is still `isAbsolute`

`mount.ts:46` (`cwdAllowed: (cwd) => npath.isAbsolute(cwd)`), consumed at
`controlApi.ts:98-105`. Not exploitable with a node token (cannot mint/spawn), so today it is a
capability-holder issue only. It is not a traversal (there is nothing above `/`), it is *unbounded
scope*: a `node.spawn` grant can place an agent in any directory on the machine.

Concrete request (requires a `node.spawn` capability for `node:n-evil`):

```
POST /api/control/spawn
x-webterm-capability: wcap_...
{"requestId":"req-evil01","nodeId":"n-evil","agentId":"claude","cwd":"/"}
# equally: "/Users/<user>/.ssh", "/Users/<user>/Documents/spawn/webterm/.git"
```

Combined with `claudePermissionMode: auto/acceptEdits` (settings) that is a read/write agent
rooted anywhere. Minimal fix: make `cwdAllowed` resolve the path (`realpathSync`) and require
`isInside(workspaceRoot, resolved)`; keep `isAbsolute` only as the cheap pre-check. Until P1b,
document that `node.spawn` is equivalent to "root can run an agent anywhere".

## Q7 — Fail-open when `WEBTERM_TOKEN` is unset on loopback

`tokensMatch(undefined, …) === true` (`auth.ts:75-79`) and `resolveToken('127.0.0.1', '')` returns
`undefined` (`auth.ts:48-58`), so on the default loopback config:

```
gate(no token) /api/settings = true
gate(no token) /api/fs/read  = true
gate(no token) /ws           = true      # a full PTY
```

This is intentional and documented, but the practical consequence on a multi-user host is that
*any local account* can open `127.0.0.1:8700` and get a PTY as the webterm user (browsers are
still blocked by `sameOrigin`; a local process omits `Origin`). Two smaller fail-open edges:

* whitespace-only `WEBTERM_TOKEN` on loopback silently means "no token" (trimmed at
  `auth.ts:49-57`), logged only as `token off: loopback only`;
* node tokens are accepted from `?token=` (`auth.ts:149`) on the allowlisted paths, so they can
  end up in shell history / process listings even after the argv fix.

Recommendation: allow an explicit `WEBTERM_REQUIRE_TOKEN=1` to force token mode on loopback, and
reject/annotate the whitespace-only case at startup.

---

## Findings

### C1 — Critical: root token persisted to a same-UID-readable file

`src/server/index.ts:60` calls `installContextLink(TOKEN)` with the **root** token.
`contextLink.ts:279-286` writes `buildContextShim(token)` to `<dataDir>/context-links/context.sh`,
and `buildContextShim` (`contextLink.ts:189-196`) embeds it literally:

```
-H 'x-webterm-token: <ROOT TOKEN>' \
```

Mode 0700 does not help: every PTY child runs as the same user, and the generated skill
(`contextLink.ts:226-268`) advertises the path. So the "node token cannot reach `/ws`, settings,
workspaces, filesystem" invariant is void the moment a token is in force.

Evidence (trace3, fake token, temp data dir):

```
shim path : /…/context-links/context.sh
mode      : 700
contains  :   -H 'x-webterm-token: ROOT-TOKEN-FAKE' \
```

Reproduce (real server, real token):

```sh
WEBTERM_TOKEN=root-s3cret bun src/server/index.ts &     # any agent session already running
cat ~/.webterm-server/context-links/context.sh | grep -o "x-webterm-token: [^']*"
curl -s -H 'x-webterm-token: root-s3cret' http://127.0.0.1:8700/api/workspaces
```

Minimal fix: never write a token into the shim. Call `installContextLink()` with no argument and
have the shim read the per-node token at run time, e.g.

```sh
curl -s --get -H "x-webterm-token: ${WEBTERM_TOKEN}" ...
```

`WEBTERM_TOKEN` is already injected per child (`sessions.ts:181-189`), so the shim keeps working
while the root token never touches disk. (Token-in-argv for the agent's *own* node token is the
same exposure the hook already has; if that is unacceptable, point the shim at the node's
`*-headers` file instead.)

### H1 — High: node token is not bound to a node; context-link identity is caller-supplied

* `hooks.ts:117-121` `isValidNodeToken` is a flat reverse lookup: any live token, no owner.
* `auth.ts:125-131,138-152` therefore admits *every* node token for the allowlist.
* `api.ts:86-105` derives the requester purely from `?node=` (`isSafeNodeId` only checks the
  alphabet) and hands it to `renderForRequester` (`contextLink.ts:150-159`), which uses it for
  `findWorkspaceFor` + `buildLinkDoc`.
* `agentStatusApi.ts:150,164-175` likewise trusts `?node=`; the only binding
  (`stateVerified`) runs when `STRICT_HOOK_AUTH=1`, which is off by default.

Impact with a configured root token (the case that matters):

1. **Cross-link read.** Agent A uses its *own* node token as transport and claims to be node B:
   `GET /api/context-link?node=B&verb=list` returns B's peers, then
   `?node=B&verb=terminal&want=C` returns C's full scrollback — a peer A is not linked to.
   The link graph is not an authorization boundary; only "same workspace" survives.
2. **Token theft makes it worse.** Header filenames are `sha256(nodeId)[:16]` (`hooks.ts:266-269`)
   in a 0700 dir under the same UID, so A can read B's `.headers` and use B's token directly
   (needed only for strict-mode status writes, which do check identity).
3. **Default (strict off) writing.** `POST /api/agent-status?node=B` with A's token rewrites B's
   badge *and* B's transcript pointer (≤4096 chars, any path). Pointing B at an attacker-written
   JSONL file injects fabricated `assistant:`/`user:` lines into the context of every node linked
   to B the next time they read `transcript`/`summary`.

Reproduce (no root token needed beyond the one a session already holds):

```sh
# inside any agent PTY, with WEBTERM_TOKEN = its own node token
curl -s -H "x-webterm-token: $WEBTERM_TOKEN" \
  "http://127.0.0.1:8700/api/context-link?node=$VICTIM_ID&verb=list"
curl -s -H "x-webterm-token: $WEBTERM_TOKEN" -X POST \
  -d '{"hook_event_name":"Stop","transcript_path":"/tmp/injected.jsonl"}' \
  "http://127.0.0.1:8700/api/agent-status?node=$VICTIM_ID"
```

Minimal fix: add `nodeIdForToken(token): string | undefined` in `hooks.ts` (invert the existing
map), thread the verified token down, and (a) in `agentStatusApi`, require
`nodeIdForToken(header) === node` **unconditionally** (do not gate identity on strict auth), and
(b) in the control transport/context-link, derive the requester from the token and ignore or
equality-check `?node=`. Be explicit in the threat model that same-UID agents can steal each
other's tokens, so per-node identity is only a *bookkeeping* boundary — the real boundary must
remain the capability (and, for context-link, the workspace/link check performed server-side).

### H2 — Medium-High: transcript path is validated at write, used at read

`agentStatusApi.ts:106-120,169-174` validate; `contextLink.ts:166-171`
(`readFileSync(path,'utf8')`) trusts the stored string. An agent owns the file it points at, so
"swap after validation" is deterministic, not a race: symlink to a JSONL-shaped secret
(disclosure to peers) or to `/dev/zero`/a FIFO (event-loop hang).

Reproduce: see Q5 snippet. Also trivially exploitable with hook auth off, no swap needed:

```sh
curl -s -X POST -d '{"transcript_path":"/dev/zero"}' \
  "http://127.0.0.1:8700/api/agent-status?node=$SELF"
# a node linked to $SELF now hangs the server with GET /api/context-link?node=$SELF&verb=transcript
```

Minimal fix: at write time store `realpathSync` of the validated path (not the raw input); at
read time `lstat` (reject non-regular files and symlinks), open + `fstat` the fd, and cap the
number of bytes read (e.g. last 4 MiB of a transcript).

### M1 — Medium: `'*'` bypasses qualifiers

`capabilities.ts:145-147` returns before `qualifierMatches`. A token minted as
`{verb:'node.read', resource:'*', qualifier:{agentIds:['only-me'], cwdPrefix:'/repo/allowed'}}`
reads every node regardless of context (trace):

```
* node.read w/ qualifiers, empty ctx   : true
* node.read w/ qualifiers, wrong agent : true
```

Fix: run `qualifierMatches(record.qualifier, context)` for the `'*'` branch too.

### M2 — Medium: idempotency is dead in production (see Q4)

`mount.ts:93-95` + `controlApi.ts:39-48`. Fix: memoise the composed deps object, and key the store
by `verb:resource:requestId`.

### M3 — Medium: qualifiers are unenforceable everywhere

`controlApi.ts:59-78` never passes a `CapabilityContext` to `allows`, and `mint` exposes
`qualifier` (`capabilities.ts:59-66`). Any non-`'*'` token with `agentIds`/`cwdPrefix` is denied on
every route (`qualifierMatches` fails on `undefined` ctx) — fail-closed, but the feature is a
no-op; only the `'*'` path (M1) "works", by skipping it. Fix: drop `qualifier` from `mint`, or
supply context (e.g. capability-minted `cwd` bound at spawn) and enforce it.

### M4 — Medium: `node.wait` grants buffer read; `node.read` has no route

`waitRoute` (`controlApi.ts:202-221`) returns `getTerminal()` — the whole retained scrollback —
under a `node.wait` grant. `node.read` is mintable but no route consumes it, so a "watch for exit"
grant is in fact a "read all output" grant. Fix: gate `output` on `node.read`, or strip it from
`wait` responses unless the connection also holds `node.read`.

### M5 — Low: root-token compare in mint route

`controlApi.ts:252` uses `!==` for the root token. Use `tokensMatch` from `auth.ts:75`.

### M6 — Low: `cwdAllowed` scope (see Q6)

`mount.ts:46`, `controlApi.ts:98-105`.

### L1-L4 — Low

* `auth.ts:149`: node tokens accepted from `?token=`; prefer header-only for node tokens.
* `hooks.ts:117-121`: `isValidNodeToken` is O(active nodes) per request; store an inverted map.
* `mount.ts` never calls `CapabilityStore.sweep`; expired-but-never-verified records accumulate
  (bounded only by mint count, which is root-only).
* `waitRoute` holds a request up to 25 s at 100 ms polling with no per-caller concurrency cap.

---

## Verified-good (no action)

* Transport allowlist, including all traversal spellings (Q1).
* Node token is independent of the root token; no argv/settings/log exposure; files 0600/0700 (Q2).
* Node token cannot mint; `spawn`/`prompt`/`close`/`wait` grants do not cross verbs or node ids;
  `resourceMatches` has the `/`-boundary guard, so `ws1` cannot match `ws10` (Q3).
* JSON body handling (`asObject`), requestId/nodeId/cwd/size validation, and `assembleCmd` keeping
  `cmd` out of the request body: a capability holder cannot inject shell via `spawn`.
* `transcriptPathAllowed` is correct at the moment it runs (relative, `..`, NUL, symlink escape,
  `..foo` non-segment) and is covered by tests.
* Capability tokens are stored only as sha256 and are compared via map lookup; expiry and clamping
  behave as documented.

## Suggested fix order

1. **C1** — stop writing the root token into `context.sh` (one-line call-site + shim body change).
2. **H1** — `nodeIdForToken` and unconditional identity binding for `/api/agent-status`; derive
   context-link requester from the token.
3. **H2** — store `realpath`, re-check `lstat` + cap bytes at read.
4. **M2** — stable deps object + `verb:resource:requestId` ack key.
5. **M1/M3/M4** — qualifier enforcement for `'*'`, or remove qualifiers; gate `wait` output on
   `node.read`.
6. **M6** — workspace-root `cwdAllowed` (P1b).
